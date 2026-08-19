import Foundation

/// Where tvOS obtains DeepSeek access. This enum intentionally carries no key
/// material. The selected source can be shown in UI and task telemetry safely.
enum BoxlessCredentialSource: Equatable {
    case localKeychain
    case mobileHandoff(id: String, expiresAt: Date)
    case remoteVault(deviceID: String)
    case managedGateway

    var displayName: String {
        switch self {
        case .localKeychain: return "Saved on this Apple TV"
        case .mobileHandoff: return "Provided by your iPhone (temporary)"
        case .remoteVault: return "Provided by the selected Yaver machine"
        case .managedGateway: return "Yaver managed gateway"
        }
    }
}

enum BoxlessCredentialState: Equatable {
    case ready(BoxlessCredentialSource)
    case missing
    case expiredHandoff
    case remoteRuntimeRequired(deviceID: String)

    var displayName: String {
        switch self {
        case .ready(let source): return source.displayName
        case .missing: return "DeepSeek access is not configured"
        case .expiredHandoff: return "The phone handoff expired; approve a new one"
        case .remoteRuntimeRequired: return "The selected machine must be online"
        }
    }
}
