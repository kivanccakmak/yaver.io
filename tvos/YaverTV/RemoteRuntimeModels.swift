// RemoteRuntimeModels.swift — the wire contract shared by tvOS and the
// agent's /remote-runtime endpoints.

import Foundation

struct RemoteRuntimeViewport: Decodable, Equatable {
    let label: String?
    let width: Int
    let height: Int
}

struct RemoteRuntimeDeviceDims: Decodable, Equatable {
    let width: Int
    let height: Int
    let scale: Double?
    let rotation: String?
}

struct RemoteRuntimeTarget: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    let platform: String
    let enabled: Bool
    let reason: String?
    let displaySurface: String?
    let viewport: RemoteRuntimeViewport?
}

struct RemoteRuntimeCapabilities: Decodable, Equatable {
    let workDir: String
    let framework: String
    let remoteRuntimeEligible: Bool
    let supportedTransports: [String]?
    let currentHostClass: String?
    let targets: [RemoteRuntimeTarget]
}

struct RemoteRuntimeSession: Decodable, Equatable {
    let id: String
    let workDir: String
    let framework: String
    let targetId: String
    let targetLabel: String
    let platform: String?
    let deviceId: String?
    let displaySurface: String?
    let viewport: RemoteRuntimeViewport?
    let transportMode: String?
    let frameTransport: String?
    let status: String
    let lastCommand: String?
    let note: String?
    let deviceDims: RemoteRuntimeDeviceDims?
}

struct RemoteRuntimeICECredentials: Decodable {
    let iceServers: [RemoteRuntimeICEServer]
    let ttlSeconds: Int?
}

struct RemoteRuntimeICEServer: Decodable {
    let urls: [String]
    let username: String?
    let credential: String?

    private enum CodingKeys: String, CodingKey {
        case urls, username, credential
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let many = try? container.decode([String].self, forKey: .urls) {
            urls = many
        } else if let one = try? container.decode(String.self, forKey: .urls) {
            urls = [one]
        } else {
            urls = []
        }
        username = try container.decodeIfPresent(String.self, forKey: .username)
        credential = try container.decodeIfPresent(String.self, forKey: .credential)
    }
}

struct RemoteRuntimeWebRTCAnswer: Decodable {
    struct Description: Decodable {
        let type: String?
        let sdp: String?
    }

    let session: RemoteRuntimeSession
    let answer: Description
    let transport: String?
    let note: String?
}

struct RemoteRuntimeControlEnvelope: Decodable {
    let session: RemoteRuntimeSession
}
