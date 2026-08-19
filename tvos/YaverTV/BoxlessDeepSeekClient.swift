// BoxlessDeepSeekClient.swift — the native tvOS Yaver Code lane.
//
// tvOS has no shell, package manager, filesystem workspace, or OpenCode
// process. It therefore must not claim to run OpenCode locally. This lane is
// deliberately provider-direct: DeepSeek V4 Flash answers chat/deep-audit
// prompts, while Git edits, builds, and execution remain on the remote runner.

import Foundation
import Security

enum BoxlessDeepSeekError: LocalizedError {
    case missingKey
    case invalidResponse
    case provider(String)

    var errorDescription: String? {
        switch self {
        case .missingKey: return "No DeepSeek credential is available. Approve access from the Yaver iPhone app or select a remote Yaver machine."
        case .invalidResponse: return "DeepSeek returned an unreadable response."
        case .provider(let message): return message
        }
    }
}

enum BoxlessDeepSeekKeyStore {
    private static let service = "io.yaver.tv.deepseek"
    private static let account = "api-key"

    static func load() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else { return "" }
        return value
    }

    static func save(_ value: String) {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            clear()
            return
        }
        let data = Data(normalized.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            attrs.forEach { insert[$0.key] = $0.value }
            _ = SecItemAdd(insert as CFDictionary, nil)
        }
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        _ = SecItemDelete(query as CFDictionary)
    }
}

struct BoxlessDeepSeekClient {
    let session: URLSession
    var apiKey: String
    var model: String = "deepseek-v4-flash"

    init(apiKey: String, session: URLSession = .shared) {
        self.apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        self.session = session
    }

    func answer(prompt: String, mode: String = "chat") async throws -> String {
        guard !apiKey.isEmpty else { throw BoxlessDeepSeekError.missingKey }
        let system = """
        You are Yaver Code on Apple TV. You are a provider-direct DeepSeek V4 Flash assistant, not OpenCode. You have no shell, filesystem, simulator, package manager, or deploy capability. For deep audits, reason carefully, identify evidence needed, cite likely file/symbol locations only when supplied by the user, separate facts from hypotheses, and end with the smallest next action. For Git or coding execution, explain that a remote Yaver runner is required and give the exact handoff needed. Mode: \(mode).
        """
        let body: [String: Any] = [
            "model": model,
            "messages": [
                ["role": "system", "content": system],
                ["role": "user", "content": prompt],
            ],
            "temperature": 0.1,
            "stream": false,
        ]
        var request = URLRequest(url: URL(string: "https://api.deepseek.com/chat/completions")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw BoxlessDeepSeekError.invalidResponse }
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard (200..<300).contains(http.statusCode) else {
            let message = ((object?["error"] as? [String: Any])?["message"] as? String)
                ?? "DeepSeek returned HTTP \(http.statusCode)."
            throw BoxlessDeepSeekError.provider(message)
        }
        guard let choices = object?["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any],
              let content = message["content"] as? String,
              !content.isEmpty else { throw BoxlessDeepSeekError.invalidResponse }
        return content
    }
}
