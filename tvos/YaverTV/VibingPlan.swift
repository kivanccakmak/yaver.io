// VibingPlan.swift — intersect the agent's repository/box answer with what
// this tvOS build can actually render.
//
// The agent's `remote-runtime` option means the BOX can produce WebRTC. tvOS
// now ships a raw libwebrtc decoder and the remote-runtime control protocol,
// so it can negotiate H.264 or JPEG-over-data-channel and drive the guest with
// a soft Siri Remote cursor. TV frames remain the compatibility lane.

import Foundation

enum TVPreviewDestination: Equatable {
    case webFrames
    case androidFrames
    case interactiveWebRTC
}

struct TVPreviewChoice: Identifiable, Equatable {
    let id: String
    let title: String
    let detail: String
    let available: Bool
    let primary: Bool
    let destination: TVPreviewDestination?
}

struct TVRenderLaneVerdict: Identifiable, Equatable {
    let id: String
    let label: String
    let usable: Bool
    let reason: String
}

/// The client half of render negotiation. Keep this explicit until the agent
/// exposes NegotiateRenderLanes over HTTP; a surface name is not a decoder.
let tvOSRenderLaneVerdicts: [TVRenderLaneVerdict] = [
    TVRenderLaneVerdict(
        id: "frames",
        label: "TV frames",
        usable: true,
        reason: "Runs on the box and reaches this TV directly when possible, otherwise through the free Yaver relay. Tailscale is optional."
    ),
    TVRenderLaneVerdict(
        id: "webrtc",
        label: "WebRTC",
        usable: true,
        reason: "Interactive WebRTC on Apple TV: Siri Remote pointer, scroll, guest keys, and text, with authenticated frame fallback when ICE is slow."
    ),
]

func tvPreviewChoices(project: ProjectSummary, capabilities: ProjectPreviewCapabilities) -> [TVPreviewChoice] {
    capabilities.options.map { option in
        let backendReason = option.reason?.trimmingCharacters(in: .whitespacesAndNewlines)
        switch option.id {
        case "dev-server":
            let runnable = option.supported && project.kind == .web
            let detail: String
            if runnable {
                detail = "Headless browser on the box → authenticated frame session → this TV. Direct or free relay; no Tailscale requirement."
            } else if !option.supported {
                detail = backendReason ?? "The box could not start this browser lane."
            } else {
                detail = "This target does not expose a browser-renderable app. Pick a native runtime target instead."
            }
            return TVPreviewChoice(
                id: option.id,
                title: project.kind == .web ? "Browser → TV frames" : option.label,
                detail: detail,
                available: runnable,
                primary: option.primary == true,
                destination: runnable ? .webFrames : nil
            )

        case "remote-runtime":
            if project.kind == .android {
                let runnable = option.supported
                return TVPreviewChoice(
                    id: option.id,
                    title: "Android runtime → TV frames",
                    detail: runnable
                        ? "Runs the Android app on the box and sends its captured frames to this TV."
                        : (backendReason ?? "No Android runtime is available on this box."),
                    available: runnable,
                    primary: option.primary == true,
                    destination: runnable ? .androidFrames : nil
                )
            }
            let runnable = option.supported && project.kind == .web
            return TVPreviewChoice(
                id: option.id,
                title: "Interactive WebRTC · Apple TV",
                detail: runnable
                    ? tvOSRenderLaneVerdicts.first(where: { $0.id == "webrtc" })!.reason
                    : (backendReason ?? "This target does not expose a browser-renderable WebRTC runtime."),
                available: runnable,
                primary: option.primary == true,
                destination: runnable ? .interactiveWebRTC : nil
            )

        default:
            return TVPreviewChoice(
                id: option.id,
                title: option.label,
                detail: backendReason ?? "This option is available on another Yaver surface, not this TV.",
                available: false,
                primary: option.primary == true,
                destination: nil
            )
        }
    }
}
