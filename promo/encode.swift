// Encodes the rendered promo into an MP4 with AVFoundation (no ffmpeg needed).
//   swift promo/encode.swift <frames dir> <audio.wav> <out.mp4> [fps]
// Frames are f0000.png, f0001.png … at 1920 × 1080; the WAV becomes AAC.
import AVFoundation
import AppKit

let args = CommandLine.arguments
guard args.count >= 4 else {
  print("usage: swift encode.swift <frames dir> <audio.wav> <out.mp4> [fps]")
  exit(1)
}
let framesDir = URL(fileURLWithPath: args[1])
let audioURL = URL(fileURLWithPath: args[2])
let outURL = URL(fileURLWithPath: args[3])
let fps = Int32(args.count > 4 ? Int(args[4]) ?? 30 : 30)
let videoOnly = outURL.deletingPathExtension().appendingPathExtension("video.mp4")

let frames = try FileManager.default.contentsOfDirectory(atPath: framesDir.path)
  .filter { $0.hasSuffix(".png") }.sorted()
guard let firstImage = NSImage(contentsOf: framesDir.appendingPathComponent(frames[0])),
      let firstCG = firstImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  print("no frames"); exit(1)
}
let width = firstCG.width, height = firstCG.height

// 1. Frames → H.264 video track.
try? FileManager.default.removeItem(at: videoOnly)
let writer = try AVAssetWriter(outputURL: videoOnly, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: width,
  AVVideoHeightKey: height,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: 14_000_000,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
  ],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
  kCVPixelBufferWidthKey as String: width,
  kCVPixelBufferHeightKey as String: height,
])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

for (i, name) in frames.enumerated() {
  autoreleasepool {
    guard let image = NSImage(contentsOf: framesDir.appendingPathComponent(name)),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
          let pool = adaptor.pixelBufferPool else { return }
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
    guard let pb = buffer else { return }
    CVPixelBufferLockBaseAddress(pb, [])
    let ctx = CGContext(
      data: CVPixelBufferGetBaseAddress(pb), width: width, height: height, bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)
    ctx?.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
    CVPixelBufferUnlockBaseAddress(pb, [])
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
    adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: fps))
  }
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else { print("video failed:", writer.error ?? "?"); exit(1) }

// 2. WAV → AAC (.m4a): MP4 players expect AAC, not PCM.
func export(_ asset: AVAsset, preset: String, to url: URL, type: AVFileType) {
  try? FileManager.default.removeItem(at: url)
  guard let session = AVAssetExportSession(asset: asset, presetName: preset) else { print("no exporter for", preset); exit(1) }
  session.outputURL = url
  session.outputFileType = type
  let done = DispatchSemaphore(value: 0)
  session.exportAsynchronously { done.signal() }
  done.wait()
  guard session.status == .completed else { print("export failed:", session.error ?? "?"); exit(1) }
}
let aacURL = outURL.deletingPathExtension().appendingPathExtension("audio.m4a")
export(AVURLAsset(url: audioURL), preset: AVAssetExportPresetAppleM4A, to: aacURL, type: .m4a)

// 3. Video + AAC → final MP4, both passed through as encoded.
let composition = AVMutableComposition()
let videoAsset = AVURLAsset(url: videoOnly)
let audioAsset = AVURLAsset(url: aacURL)
let duration = videoAsset.duration
if let v = videoAsset.tracks(withMediaType: .video).first,
   let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) {
  try track.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: v, at: .zero)
}
if let a = audioAsset.tracks(withMediaType: .audio).first,
   let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
  try track.insertTimeRange(CMTimeRange(start: .zero, duration: min(duration, audioAsset.duration)), of: a, at: .zero)
}
export(composition, preset: AVAssetExportPresetPassthrough, to: outURL, type: .mp4)
try? FileManager.default.removeItem(at: videoOnly)
try? FileManager.default.removeItem(at: aacURL)
print("wrote", outURL.path, "(\(frames.count) frames, \(width)×\(height), \(fps) fps)")
