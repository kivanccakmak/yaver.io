import Foundation
import Security

/// This-device-only Keychain vault for provider and Git credentials. Inventory
/// returns kinds only; plaintext is scoped to a callback and its Data buffer is
/// cleared immediately afterward.
enum CredentialStore {
    static let allowedKinds: Set<String> = [
        "deepseek-api-key", "openai-api-key", "anthropic-api-key", "glm-api-key",
        "github-token", "gitlab-token", "bitbucket-token",
    ]
    private static let service = "io.yaver.tv.credentials.v1"

    static func save(kind: String, value: Data) throws {
        guard allowedKinds.contains(kind), !value.isEmpty, value.count <= 32 * 1024 else { throw StoreError.invalidCredential }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: kind]
        let attrs: [String: Any] = [kSecValueData as String: value, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query; attrs.forEach { insert[$0.key] = $0.value }
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw StoreError.unavailable }
        } else if status != errSecSuccess { throw StoreError.unavailable }
    }

    static func withCredential<T>(kind: String, _ body: (Data) throws -> T) throws -> T? {
        guard allowedKinds.contains(kind) else { throw StoreError.invalidCredential }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: kind, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, var data = item as? Data else { throw StoreError.unavailable }
        defer { data.resetBytes(in: 0..<data.count) }
        return try body(data)
    }

    static func availableKinds() -> Set<String> {
        Set(allowedKinds.filter { kind in (try? withCredential(kind: kind) { _ in true }) ?? false })
    }

    enum StoreError: Error { case invalidCredential, unavailable }
}
