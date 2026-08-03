// screenread — Yaver's text oracle: a frame in, text + boxes out, as JSON.
//
// L0 of docs/architecture/APPLE_VISION_TEXT_ORACLE.md. Deliberately DUMB: no
// policy, no thresholds, no caching, no network. Policy lives in Go. This exists
// so surfaces WITHOUT a DOM — tvOS, visionOS, watch, car, a WebRTC frame, a
// capture card — can reach a NAMED verdict instead of only PIXELS or SILENT.
//
// 🔴 CODESIGNING TRAP (this repo's own history, 2026-07-25): macOS kills an
// unsigned binary under launchd with OS_REASON_CODESIGNING while launchd still
// reports "spawn scheduled" — it looks like a hang, not a rejection, and it took
// the agent down for a whole session. So whoever builds this MUST sign in the
// same breath:
//
//     xcrun swiftc -O screenread/main.swift -o screenread \
//       && codesign --force -s - screenread
//
// and the Go probe must attempt a RUN, never os.Stat the path — a
// present-but-killable binary is the canonical "inventory says yes, operation
// says no".
//
// Usage:  screenread <image-path> [--min-confidence 0.0]
// Output: {"ok":true,"blocks":[{"text","confidence","x","y","w","h"}],"ms":123}
//         {"ok":false,"error":"…"}            (exit 1, never a partial success)

import Foundation
import Vision
import CoreImage

struct Block: Codable {
    let text: String
    let confidence: Float
    // Normalised 0..1, origin BOTTOM-LEFT (Vision's convention). Kept raw
    // rather than flipped: a consumer that assumes top-left will be wrong in a
    // way that is obvious, whereas a silent flip here would be wrong in a way
    // that is not.
    let x: Double, y: Double, w: Double, h: Double
}

struct Output: Codable {
    let ok: Bool
    let blocks: [Block]?
    let ms: Int?
    let error: String?
}

func emit(_ out: Output) -> Never {
    let enc = JSONEncoder()
    enc.outputFormatting = [.withoutEscapingSlashes]
    if let data = try? enc.encode(out), let s = String(data: data, encoding: .utf8) {
        print(s)
    } else {
        print("{\"ok\":false,\"error\":\"encode failed\"}")
    }
    exit(out.ok ? 0 : 1)
}

func fail(_ msg: String) -> Never {
    emit(Output(ok: false, blocks: nil, ms: nil, error: msg))
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail("usage: screenread <image-path> [--min-confidence 0.0]")
}
let path = args[1]

var minConfidence: Float = 0.0
if let i = args.firstIndex(of: "--min-confidence"), i + 1 < args.count {
    minConfidence = Float(args[i + 1]) ?? 0.0
}

guard FileManager.default.fileExists(atPath: path) else {
    fail("no such frame: \(path)")
}
guard let ciImage = CIImage(contentsOf: URL(fileURLWithPath: path)) else {
    // Naming the path matters: the commonest cause is a screenshot that was
    // never written (a simulator that did not boot), and "decode failed" alone
    // sends the reader hunting the wrong bug.
    fail("could not decode image: \(path)")
}

let started = Date()
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(ciImage: ciImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("vision failed: \(error.localizedDescription)")
}

let observations = request.results ?? []
var blocks: [Block] = []
for obs in observations {
    guard let candidate = obs.topCandidates(1).first else { continue }
    guard candidate.confidence >= minConfidence else { continue }
    let bb = obs.boundingBox
    blocks.append(Block(
        text: candidate.string,
        confidence: candidate.confidence,
        x: Double(bb.origin.x), y: Double(bb.origin.y),
        w: Double(bb.size.width), h: Double(bb.size.height)
    ))
}

emit(Output(
    ok: true,
    blocks: blocks,
    ms: Int(Date().timeIntervalSince(started) * 1000),
    error: nil
))
