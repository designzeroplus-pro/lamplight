// lamplight-transcriber
//
// Live speech-to-text with Apple's Speech framework.
//   stdin  : raw PCM, 16 kHz, mono, signed 16-bit little-endian
//   stdout : one JSON object per line
//            {"type":"ready","onDevice":true}
//            {"type":"partial","seg":3,"text":"…"}
//            {"type":"final","seg":3,"text":"…"}
//            {"type":"error","code":"denied","message":"…"}
//            {"type":"done"}
//
// Audio is cut into segments at pauses (and at least every ~50 s, the server
// recognizer's limit), so every segment becomes one line in the notes.
//
//   lamplight-transcriber [--locale ko-KR] [--status] [--authorize]

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

// ── Be our own "responsible process" ───────────────────────────────────────
// macOS attributes privacy prompts to whichever app launched us (Lamplight,
// but also Terminal or an IDE during development). If that app's Info.plist
// lacks a speech-recognition usage string, TCC kills us instead of asking.
// Re-launch ourselves with responsibility disclaimed so our own embedded
// Info.plist (NSSpeechRecognitionUsageDescription) is the one that counts.
@_silgen_name("responsibility_spawnattrs_setdisclaim")
private func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

private var disclaimedChild: pid_t = 0

private func relaunchDisclaimed() {
  guard getenv("LAMPLIGHT_DISCLAIMED") == nil else { return }
  var size: UInt32 = 4096
  var buf = [CChar](repeating: 0, count: Int(size))
  guard _NSGetExecutablePath(&buf, &size) == 0 else { return }
  let exe = String(cString: buf)

  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  defer { posix_spawnattr_destroy(&attr) }
  guard responsibility_spawnattrs_setdisclaim(&attr, 1) == 0 else { return }
  setenv("LAMPLIGHT_DISCLAIMED", "1", 1)

  var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) }
  argv.append(nil)
  var pid: pid_t = 0
  let rc = posix_spawn(&pid, exe, nil, &attr, argv, environ)
  argv.forEach { free($0) }
  guard rc == 0 else { unsetenv("LAMPLIGHT_DISCLAIMED"); return }  // fall back to running in-process

  // Pass stop signals through, then exit with the child's status.
  disclaimedChild = pid
  for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig) { s in if disclaimedChild > 0 { kill(disclaimedChild, s) } }
  }
  var status: Int32 = 0
  while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
  exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f))
}

relaunchDisclaimed()

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
  fflush(stdout)
}

func statusName(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch s {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

let args = CommandLine.arguments
var localeId = "ko-KR"
if let i = args.firstIndex(of: "--locale"), i + 1 < args.count { localeId = args[i + 1] }

if args.contains("--status") {
  emit(["type": "status", "status": statusName(SFSpeechRecognizer.authorizationStatus())])
  exit(0)
}

// Asks for permission up front (used by the first-run guide), then exits.
if args.contains("--authorize") {
  SFSpeechRecognizer.requestAuthorization { status in
    emit(["type": "status", "status": statusName(status)])
    exit(0)
  }
  dispatchMain()
}

final class LiveTranscriber {
  static let silenceGap: TimeInterval = 1.1   // pause that ends a segment
  static let maxSegment: TimeInterval = 50    // stay under the 1-minute server limit

  let recognizer: SFSpeechRecognizer
  let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
  let queue = DispatchQueue(label: "lamplight.stt")

  var request: SFSpeechAudioBufferRecognitionRequest?
  var tasks: [Int: SFSpeechRecognitionTask] = [:]
  var texts: [Int: String] = [:]
  var finalized = Set<Int>()
  var seg = 0
  var segStarted = Date()
  var lastChange = Date()
  var heardSomething = false
  var ending = false
  var timer: DispatchSourceTimer?

  init?(locale: String) {
    guard let r = SFSpeechRecognizer(locale: Locale(identifier: locale)) else { return nil }
    recognizer = r
  }

  var onDevice: Bool { recognizer.supportsOnDeviceRecognition }
  // --server: let Apple's servers recognize (more accurate, needs internet,
  // audio leaves the Mac). Default stays on-device.
  let preferServer = CommandLine.arguments.contains("--server")

  func start() {
    queue.async { [self] in
      self.beginSegment()
      let t = DispatchSource.makeTimerSource(queue: self.queue)
      t.schedule(deadline: .now() + 0.25, repeating: 0.25)
      t.setEventHandler { [weak self] in self?.tick() }
      t.resume()
      self.timer = t
    }
    readStdin()
  }

  // Must run on `queue`.
  func beginSegment() {
    seg += 1
    let id = seg
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.taskHint = .dictation
    if onDevice && !preferServer { req.requiresOnDeviceRecognition = true }
    if #available(macOS 13, *) { req.addsPunctuation = true }
    request = req
    segStarted = Date()
    lastChange = Date()
    heardSomething = false

    tasks[id] = recognizer.recognitionTask(with: req) { [weak self] result, error in
      guard let self else { return }
      self.queue.async { self.handle(id: id, result: result, error: error) }
    }
  }

  var lastRestart = Date.distantPast

  // A segment that stopped on its own (error, or a final we didn't ask for)
  // must be replaced, or later audio would go to a dead request.
  // Must run on `queue`.
  func restartIfCurrent(_ id: Int) {
    guard id == seg, !ending else { return }
    let wait = max(0, 1 - Date().timeIntervalSince(lastRestart))  // at most once a second
    lastRestart = Date().addingTimeInterval(wait)
    queue.asyncAfter(deadline: .now() + wait) { [weak self] in
      guard let self, id == self.seg, !self.ending else { return }
      self.request?.endAudio()
      self.beginSegment()
    }
  }

  // Must run on `queue`.
  func handle(id: Int, result: SFSpeechRecognitionResult?, error: Error?) {
    if let result {
      let text = result.bestTranscription.formattedString
      if text != texts[id] {
        texts[id] = text
        if id == seg {
          lastChange = Date()
          heardSomething = !text.isEmpty
        }
        if !result.isFinal && !text.isEmpty { emit(["type": "partial", "seg": id, "text": text]) }
      }
      if result.isFinal { finish(id); restartIfCurrent(id) }
    }
    if let error {
      let ns = error as NSError
      emit(["type": "log", "seg": id, "message": "\(ns.domain) \(ns.code): \(ns.localizedDescription)"])
      finish(id)  // e.g. "no speech detected": keep whatever we heard
      restartIfCurrent(id)
    }
  }

  // Must run on `queue`.
  func finish(_ id: Int) {
    guard !finalized.contains(id) else { return }
    finalized.insert(id)
    let text = (texts[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty { emit(["type": "final", "seg": id, "text": text]) }
    tasks[id] = nil
    texts[id] = nil
    if ending && tasks.isEmpty { done() }
  }

  // Must run on `queue`.
  func tick() {
    guard !ending else { return }
    let now = Date()
    let paused = heardSomething && now.timeIntervalSince(lastChange) > Self.silenceGap
    let tooLong = now.timeIntervalSince(segStarted) > Self.maxSegment
    if paused || tooLong {
      request?.endAudio()
      beginSegment()
    }
  }

  func readStdin() {
    Thread {
      let handle = FileHandle.standardInput
      var carry = Data()
      var gain: Float = 1
      while true {
        let chunk = handle.availableData
        if chunk.isEmpty { break }  // EOF
        carry.append(chunk)
        let usable = carry.count & ~1
        guard usable > 0 else { continue }
        let bytes = carry.prefix(usable)
        carry = carry.dropFirst(usable)
        let frames = usable / 2
        guard let buffer = AVAudioPCMBuffer(pcmFormat: self.format, frameCapacity: AVAudioFrameCount(frames)) else { continue }
        buffer.frameLength = AVAudioFrameCount(frames)
        let out = buffer.floatChannelData![0]
        var energy: Float = 0
        bytes.withUnsafeBytes { raw in
          let src = raw.bindMemory(to: Int16.self)
          for i in 0..<frames {
            let v = Float(Int16(littleEndian: src[i])) / 32768
            out[i] = v
            energy += v * v
          }
        }
        // Automatic gain: quiet voices (laptop mic across a table) are lifted
        // toward a comfortable level so the recognizer hears them as speech.
        // Near-silence is left alone so room noise isn't amplified.
        let rms = (energy / Float(max(frames, 1))).squareRoot()
        if rms > 0.004 {
          let wanted = min(8, max(1, 0.12 / rms))
          gain += (wanted - gain) * (wanted < gain ? 0.5 : 0.15)
        }
        if gain > 1.01 {
          for i in 0..<frames { out[i] = tanhf(out[i] * gain) }  // soft limit, no harsh clipping
        }
        self.queue.async { self.request?.append(buffer) }
      }
      self.queue.async { self.end() }
    }.start()
  }

  // Must run on `queue`.
  func end() {
    ending = true
    timer?.cancel()
    request?.endAudio()
    request = nil
    if tasks.isEmpty { done() }
    // Don't wait forever for a recognizer that never answers.
    queue.asyncAfter(deadline: .now() + 6) { [weak self] in
      guard let self else { return }
      for id in Array(self.tasks.keys) { self.finish(id) }
      self.done()
    }
  }

  var didFinish = false
  func done() {
    guard !didFinish else { return }
    didFinish = true
    emit(["type": "done"])
    exit(0)
  }
}

var engine: LiveTranscriber?

/* ── File mode ──────────────────────────────────────────────────────────────
 *   lamplight-transcriber --file audio.wav --segments segments.json [--locale ko-KR]
 * audio.wav: 16 kHz mono Int16 (prepared and level-matched by the app).
 * segments.json: [[startSec, endSec], …] — the stretches that contain speech.
 * Each segment is recognized on its own (no wall-clock pauses involved),
 * emitting {"type":"final","start":s,"text":…} and {"type":"progress",…}. */
func argValue(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

func transcribeFile(_ recognizer: SFSpeechRecognizer, wav: String, segmentsPath: String) {
  guard let data = FileManager.default.contents(atPath: wav), data.count > 44,
        let segData = FileManager.default.contents(atPath: segmentsPath),
        let segments = try? JSONSerialization.jsonObject(with: segData) as? [[Double]] else {
    emit(["type": "error", "code": "file", "message": "could not read input"])
    exit(5)
  }
  let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
  let samples: [Float] = data.dropFirst(44).withUnsafeBytes { raw in
    raw.bindMemory(to: Int16.self).map { Float(Int16(littleEndian: $0)) / 32768 }
  }
  for (index, seg) in segments.enumerated() {
    guard seg.count == 2 else { continue }
    let a = max(0, Int(seg[0] * 16_000))
    let b = min(samples.count, Int(seg[1] * 16_000))
    guard b - a > 1_600, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(b - a)) else { continue }
    buffer.frameLength = AVAudioFrameCount(b - a)
    samples.withUnsafeBufferPointer { src in
      buffer.floatChannelData![0].update(from: src.baseAddress! + a, count: b - a)
    }
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = false
    req.taskHint = .dictation
    if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
    if #available(macOS 13, *) { req.addsPunctuation = true }
    req.append(buffer)
    req.endAudio()

    let done = DispatchSemaphore(value: 0)
    var text = ""
    var finished = false
    let lock = NSLock()
    let task = recognizer.recognitionTask(with: req) { result, error in
      lock.lock(); defer { lock.unlock() }
      if finished { return }
      if let result { text = result.bestTranscription.formattedString }
      if result?.isFinal == true || error != nil { finished = true; done.signal() }
    }
    if done.wait(timeout: .now() + 90) == .timedOut { task.cancel() }
    let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !clean.isEmpty { emit(["type": "final", "start": seg[0], "end": seg[1], "text": clean]) }
    emit(["type": "progress", "done": index + 1, "total": segments.count])
  }
  emit(["type": "done"])
  exit(0)
}

SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else {
    emit(["type": "error", "code": "denied", "message": "speech recognition \(statusName(status))"])
    exit(2)
  }
  guard let e = LiveTranscriber(locale: localeId) else {
    emit(["type": "error", "code": "locale", "message": "unsupported locale \(localeId)"])
    exit(3)
  }
  guard e.recognizer.isAvailable else {
    emit(["type": "error", "code": "unavailable", "message": "recognizer unavailable"])
    exit(4)
  }
  if let wav = argValue("--file"), let segs = argValue("--segments") {
    emit(["type": "ready", "onDevice": e.onDevice, "locale": localeId, "mode": "file"])
    // Recognition callbacks need the main queue free; work on a background thread.
    Thread { transcribeFile(e.recognizer, wav: wav, segmentsPath: segs) }.start()
    return
  }
  engine = e
  emit(["type": "ready", "onDevice": e.onDevice && !e.preferServer, "locale": localeId])
  e.start()
}

dispatchMain()
