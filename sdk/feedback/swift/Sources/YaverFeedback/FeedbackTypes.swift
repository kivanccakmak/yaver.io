import Foundation

/// Wire types for the Yaver Feedback SDK.
///
/// ⚠️ THESE KEY NAMES ARE THE CONTRACT. They mirror `FeedbackReport` in
/// `desktop/agent/feedback.go`, and the agent decodes by name. Renaming one
/// here does not fail a build — it fails silently at runtime, with the agent
/// receiving a report missing the field it needed. If that struct changes, this
/// file and the Kotlin equivalent change with it.
///
/// Dictionaries rather than `Codable` so the emitted key names are visible in
/// one place next to the Go struct they must match.

public struct FeedbackConfig {
    /// Yaver agent base URL, usually `http://<host>:18080`.
    public let agentURL: String

    /// SDK token — **not** a user session token.
    ///
    /// SDK tokens are scoped to feedback submission. A session token shipped in
    /// an app given to third parties would hand them the user's full agent
    /// authority, which is a categorically different exposure than "can file a
    /// bug report".
    public let authToken: String

    public let shakeEnabled: Bool
    public let captureScreenshot: Bool
    public let captureErrors: Bool
    /// Optional project slug so the agent can attribute the report.
    public let projectSlug: String?

    /// Is this a DEVELOPMENT build?
    ///
    /// Gates the reload controls (`YaverReloadControl`, `reloadActions()`),
    /// which must never appear in a shipped app. The default is resolved from
    /// the SDK's own `#if DEBUG` at the point `FeedbackConfig` is constructed,
    /// which is the honest reading for the overwhelmingly common case.
    ///
    /// Pass it explicitly if your app ships a debug-configuration build to
    /// testers, or builds the SDK in release inside a debug app.
    public let devBuild: Bool

    public init(
        agentURL: String,
        authToken: String,
        shakeEnabled: Bool = true,
        captureScreenshot: Bool = true,
        captureErrors: Bool = true,
        projectSlug: String? = nil,
        devBuild: Bool = FeedbackConfig.compiledInDebug
    ) {
        self.agentURL = agentURL
        self.authToken = authToken
        self.shakeEnabled = shakeEnabled
        self.captureScreenshot = captureScreenshot
        self.captureErrors = captureErrors
        self.projectSlug = projectSlug
        self.devBuild = devBuild
    }

    /// Whether THIS SDK was compiled with `-DDEBUG`.
    ///
    /// Named rather than inlined so the default is greppable and so a caller
    /// reading `devBuild: FeedbackConfig.compiledInDebug` can see exactly
    /// which build's flag they are inheriting — the SDK's, not their app's.
    public static var compiledInDebug: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }
}

/// A timestamped annotation, seconds from the start of the session.
public struct TimelineEvent {
    public let time: TimeInterval
    /// "voice" | "screenshot" | "annotation" | "crash"
    public let type: String
    public let text: String?
    public let file: String?

    public init(time: TimeInterval, type: String, text: String? = nil, file: String? = nil) {
        self.time = time
        self.type = type
        self.text = text
        self.file = file
    }

    func toDictionary() -> [String: Any] {
        var d: [String: Any] = ["time": time, "type": type]
        if let text { d["text"] = text }
        if let file { d["file"] = file }
        return d
    }
}

public struct CapturedError {
    public let message: String
    public let stack: String?
    public let timestamp: String

    func toDictionary() -> [String: Any] {
        var d: [String: Any] = ["message": message, "timestamp": timestamp]
        if let stack { d["stack"] = stack }
        return d
    }
}

public struct DeviceInfo {
    public let platform: String
    public let osVersion: String
    public let model: String
    public let screenWidth: Int
    public let screenHeight: Int

    func toDictionary() -> [String: Any] {
        [
            "platform": platform,
            "osVersion": osVersion,
            "model": model,
            "screenWidth": screenWidth,
            "screenHeight": screenHeight,
        ]
    }
}

public struct FeedbackReport {
    public let id: String
    /// Always `"in-app-sdk"` from here.
    ///
    /// The agent uses this to distinguish a report the USER filed from inside
    /// their app from one the Yaver viewer triggered remotely (`"yaver-app"`).
    /// They mean different things when triaging: one is a user hitting a
    /// problem, the other is a developer inspecting.
    public let source: String
    public let screenshots: [String]
    public let timeline: [TimelineEvent]
    public let errors: [CapturedError]
    public let deviceInfo: DeviceInfo
    public let appVersion: String?
    public let buildId: String?
    public let note: String?
    public let createdAt: String

    init(
        id: String,
        source: String = "in-app-sdk",
        screenshots: [String] = [],
        timeline: [TimelineEvent] = [],
        errors: [CapturedError] = [],
        deviceInfo: DeviceInfo,
        appVersion: String? = nil,
        buildId: String? = nil,
        note: String? = nil,
        createdAt: String
    ) {
        self.id = id
        self.source = source
        self.screenshots = screenshots
        self.timeline = timeline
        self.errors = errors
        self.deviceInfo = deviceInfo
        self.appVersion = appVersion
        self.buildId = buildId
        self.note = note
        self.createdAt = createdAt
    }

    func toDictionary() -> [String: Any] {
        var d: [String: Any] = [
            "id": id,
            "source": source,
            "deviceInfo": deviceInfo.toDictionary(),
            "createdAt": createdAt,
        ]
        if !screenshots.isEmpty { d["screenshots"] = screenshots }
        if !timeline.isEmpty { d["timeline"] = timeline.map { $0.toDictionary() } }
        if !errors.isEmpty { d["errors"] = errors.map { $0.toDictionary() } }
        if let appVersion { d["appVersion"] = appVersion }
        if let buildId { d["buildId"] = buildId }
        // The Go struct calls the free-text field `transcript` — it predates
        // typed notes and carries whatever the user said, typed or spoken.
        if let note { d["transcript"] = note }
        return d
    }
}
