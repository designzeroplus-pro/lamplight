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
    if onDevice { req.requiresOnDeviceRecognition = true }
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
      if result.isFinal { finish(id) }
    }
    if error != nil { finish(id) }  // e.g. "no speech detected": keep whatever we heard
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
        bytes.withUnsafeBytes { raw in
          let src = raw.bindMemory(to: Int16.self)
          for i in 0..<frames { out[i] = Float(Int16(littleEndian: src[i])) / 32768 }
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
  engine = e
  emit(["type": "ready", "onDevice": e.onDevice, "locale": localeId])
  e.start()
}

dispatchMain()
