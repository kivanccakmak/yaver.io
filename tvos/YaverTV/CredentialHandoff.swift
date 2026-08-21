import CryptoKit
import Foundation
import Security
import Sodium

struct CredentialHandoffRequest: Codable {
    let version: Int
    let type: String
    let handoffId: String
    let targetDeviceId: String
    let targetPublicKey: String
    let accountFingerprint: String
    let createdAt: Double
    let expiresAt: Double
}

struct CredentialHandoffEnvelope: Codable {
    let version: Int
    let type: String
    let handoffId: String
    let targetDeviceId: String
    let accountFingerprint: String
    let senderPublicKey: String
    let nonce: String
    let ciphertext: String
}

struct CredentialPayload: Codable {
    let version: Int; let handoffId: String; let targetDeviceId: String; let accountFingerprint: String
    let createdAt: Double; let expiresAt: Double; let kind: String; let value: String
}

enum CredentialHandoff {
    static let qrPrefix = "yaver-credential:v1:"
    static let sodium = Sodium()

    static func accountFingerprint(_ accountID: String) -> String {
        let digest = SHA512.hash(data: Data("yaver-credential-account-v1\0\(accountID.trimmingCharacters(in: .whitespacesAndNewlines))".utf8))
        return Data(digest.prefix(18)).base64URLEncoded
    }

    static func makeRequest(accountID: String) throws -> CredentialHandoffRequest {
        let pair = try HandoffIdentityStore.loadOrCreate()
        let now = Date().timeIntervalSince1970 * 1000
        return CredentialHandoffRequest(version: 1, type: "yaver-credential-request",
            handoffId: Data(sodium.randomBytes.buf(length: 18)!).base64URLEncoded,
            targetDeviceId: TokenStore.installationID(), targetPublicKey: Data(pair.publicKey).base64EncodedString(),
            accountFingerprint: accountFingerprint(accountID), createdAt: now, expiresAt: now + 120_000)
    }

    static func encodeQR<T: Encodable>(_ value: T) throws -> String {
        qrPrefix + (try JSONEncoder().encode(value)).base64URLEncoded
    }

    static func parseEnvelope(_ qr: String) throws -> CredentialHandoffEnvelope {
        guard qr.hasPrefix(qrPrefix), qr.count <= 16 * 1024,
              let data = Data(base64URL: String(qr.dropFirst(qrPrefix.count))) else { throw HandoffError.malformed }
        return try JSONDecoder().decode(CredentialHandoffEnvelope.self, from: data)
    }

    static func verificationCode(request: CredentialHandoffRequest, envelope: CredentialHandoffEnvelope) -> String {
        let transcript = ["yaver-credential-sas-v1", request.handoffId, request.targetDeviceId, request.targetPublicKey,
            request.accountFingerprint, envelope.senderPublicKey].joined(separator: "\0")
        let digest = SHA512.hash(data: Data(transcript.utf8))
        let bytes = Array(digest.prefix(3))
        return String(format: "%06d", ((Int(bytes[0]) << 16 | Int(bytes[1]) << 8 | Int(bytes[2])) % 1_000_000))
    }

    static func accept(_ envelope: CredentialHandoffEnvelope, request: CredentialHandoffRequest) throws -> String {
        guard envelope.version == 1, envelope.type == "yaver-credential-envelope",
              envelope.handoffId == request.handoffId, envelope.targetDeviceId == request.targetDeviceId,
              envelope.accountFingerprint == request.accountFingerprint, Date().timeIntervalSince1970 * 1000 < request.expiresAt,
              !HandoffReplayStore.contains(envelope.handoffId),
              let sender = Data(base64Encoded: envelope.senderPublicKey), let nonce = Data(base64Encoded: envelope.nonce),
              let cipher = Data(base64Encoded: envelope.ciphertext) else { throw HandoffError.malformed }
        let pair = try HandoffIdentityStore.loadOrCreate()
        guard let payload = decrypt(envelope: envelope, sender: sender, nonce: nonce, cipher: cipher, recipientSecretKey: pair.secretKey),
              payload.handoffId == request.handoffId, payload.targetDeviceId == request.targetDeviceId,
              payload.accountFingerprint == request.accountFingerprint, CredentialStore.allowedKinds.contains(payload.kind),
              payload.expiresAt == request.expiresAt, Date().timeIntervalSince1970 * 1000 < payload.expiresAt else { throw HandoffError.authenticationFailed }
        try CredentialStore.save(kind: payload.kind, value: Data(payload.value.utf8))
        try HandoffReplayStore.consume(payload.handoffId)
        return payload.kind
    }

    static func decrypt(envelope: CredentialHandoffEnvelope, sender: Data? = nil, nonce: Data? = nil, cipher: Data? = nil,
                        recipientSecretKey: [UInt8]) -> CredentialPayload? {
        guard let sender = sender ?? Data(base64Encoded: envelope.senderPublicKey),
              let nonce = nonce ?? Data(base64Encoded: envelope.nonce),
              let cipher = cipher ?? Data(base64Encoded: envelope.ciphertext), nonce.count == 24,
              let plain = sodium.box.open(nonceAndAuthenticatedCipherText: [UInt8](nonce + cipher),
                senderPublicKey: [UInt8](sender), recipientSecretKey: recipientSecretKey) else { return nil }
        return try? JSONDecoder().decode(CredentialPayload.self, from: Data(plain))
    }

    enum HandoffError: Error { case malformed, authenticationFailed, secureStorageUnavailable }
}

private enum HandoffReplayStore {
    private static let service = "io.yaver.tv.credential-handoff.replay.v1"
    private static let account = "consumed"
    static func contains(_ id: String) -> Bool { load().contains(id) }
    static func consume(_ id: String) throws {
        var ids = load().filter { $0 != id }; ids.append(id); ids = Array(ids.suffix(64))
        let data = try JSONEncoder().encode(ids)
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound { var insert = q; attrs.forEach { insert[$0.key] = $0.value }; guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw CredentialHandoff.HandoffError.secureStorageUnavailable } }
        else if status != errSecSuccess { throw CredentialHandoff.HandoffError.secureStorageUnavailable }
    }
    private static func load() -> [String] {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?; guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return [] }
        return (try? JSONDecoder().decode([String].self, from: data)) ?? []
    }
}

private enum HandoffIdentityStore {
    static let service = "io.yaver.tv.credential-handoff.identity.v1"
    struct Pair { let publicKey: [UInt8]; let secretKey: [UInt8] }
    static func loadOrCreate() throws -> Pair {
        if let data = read(), let object = try? JSONDecoder().decode(Saved.self, from: data),
           let pub = Data(base64Encoded: object.publicKey), let sec = Data(base64Encoded: object.secretKey), pub.count == 32, sec.count == 32 {
            return Pair(publicKey: [UInt8](pub), secretKey: [UInt8](sec))
        }
        guard let pair = CredentialHandoff.sodium.box.keyPair() else { throw CredentialHandoff.HandoffError.secureStorageUnavailable }
        let data = try JSONEncoder().encode(Saved(publicKey: Data(pair.publicKey).base64EncodedString(), secretKey: Data(pair.secretKey).base64EncodedString()))
        let deleteQuery: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: "x25519"]
        SecItemDelete(deleteQuery as CFDictionary)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: "x25519", kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw CredentialHandoff.HandoffError.secureStorageUnavailable }
        return Pair(publicKey: pair.publicKey, secretKey: pair.secretKey)
    }
    private static func read() -> Data? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: "x25519", kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?; guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }
    struct Saved: Codable { let publicKey: String; let secretKey: String }
}

private extension Data {
    var base64URLEncoded: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    init?(base64URL: String) { var s = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/"); s += String(repeating: "=", count: (4 - s.count % 4) % 4); self.init(base64Encoded: s) }
}
