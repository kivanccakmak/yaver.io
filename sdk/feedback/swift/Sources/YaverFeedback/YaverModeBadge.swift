#if canImport(UIKit)
import UIKit

/// The polite "you're running inside Yaver" mark for native iOS apps.
///
/// ─── Why detection here is NOT the same problem as on RN/web ────────────────
///
/// A native Swift app is never a Hermes guest — the Yaver container loads React
/// Native bytecode, and there is no mechanism by which a Swift app runs inside
/// it. So the RN SDK's `NativeModules.YaverInfo` probe has no counterpart here.
///
/// What DOES happen is streaming: the app runs in a simulator on a Mac box and
/// the pixels arrive on someone's phone via WebRTC. That is genuinely a "you are
/// not looking at the installed app" situation and is worth a mark.
///
/// ─── Why we do not sniff the simulator ──────────────────────────────────────
///
/// The tempting probe is `#if targetEnvironment(simulator)`. It is WRONG, and
/// wrong in the expensive direction: a developer running their own simulator
/// would be told "you are inside Yaver" when they are not. A false claim about
/// which build you are looking at is worse than no claim — it teaches people to
/// ignore the mark, which costs more than never having shown it.
///
/// So detection is EXPLICIT and fails closed:
///
///   1. the launching side sets `YAVER_STREAMED=1` in the environment (the
///      agent controls the launch when it starts the app in a remote runtime),
///   2. the host app calls ``setStreamed(_:)`` because it knows, or
///   3. no mark is shown.
///
/// Absent evidence, we say nothing.
public enum YaverModeBadge {

    private static let viewTag = 987_651
    private static let accent = UIColor(red: 124/255, green: 92/255, blue: 255/255, alpha: 1)

    /// Per-RUN dismissal. In memory on purpose: a permanently hidden mark
    /// recreates the problem it exists to prevent — a tester who cannot tell a
    /// streamed dev build from the installed app. Polite means not nagging
    /// within a session, not permanent amnesia. An app that wants it gone for
    /// good simply never calls ``attach(to:)``.
    private static var hiddenThisRun = false
    private static var streamedOverride: Bool?

    /// Tell the SDK this process is being streamed by Yaver.
    public static func setStreamed(_ streamed: Bool) {
        streamedOverride = streamed
    }

    /// Whether this process is running inside Yaver, as far as we can honestly
    /// tell. Explicit signals only — see the type docs for why the simulator
    /// check is refused.
    public static func isInsideYaver() -> Bool {
        if let override = streamedOverride { return override }
        let env = ProcessInfo.processInfo.environment["YAVER_STREAMED"]?.lowercased()
        return env == "1" || env == "true"
    }

    public static var isHidden: Bool { hiddenThisRun }

    /// Hide the mark for the rest of this run. Returns on next launch.
    public static func hide() {
        hiddenThisRun = true
        currentWindow()?.viewWithTag(viewTag)?.removeFromSuperview()
    }

    /// Bring it back — e.g. when the app enters a new streamed context.
    public static func show() {
        hiddenThisRun = false
        attach()
    }

    /// Add the mark to the key window. No-op when we cannot honestly claim the
    /// app is inside Yaver, when the user hid it, or when it is already there.
    ///
    /// Call it after your UI is up. Safe to call repeatedly.
    public static func attach(to window: UIWindow? = nil) {
        guard !hiddenThisRun, isInsideYaver() else { return }
        guard let host = window ?? currentWindow() else { return }
        guard host.viewWithTag(viewTag) == nil else { return }

        let mark = UILabel()
        mark.tag = viewTag
        mark.text = "Y"
        mark.textColor = accent
        mark.font = .systemFont(ofSize: 12, weight: .bold)
        mark.textAlignment = .center
        mark.isAccessibilityElement = true
        mark.accessibilityLabel = "Running inside Yaver"
        mark.accessibilityTraits = .button
        mark.backgroundColor = accent.withAlphaComponent(0.14)
        mark.layer.cornerRadius = 11
        mark.layer.borderWidth = 1
        mark.layer.borderColor = accent.withAlphaComponent(0.45).cgColor
        mark.layer.masksToBounds = true
        mark.alpha = 0.9
        mark.isUserInteractionEnabled = true
        mark.addGestureRecognizer(UITapGestureRecognizer(target: BadgeTarget.shared,
                                                         action: #selector(BadgeTarget.tapped)))
        mark.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(mark)

        // Bottom-LEADING: bottom-trailing is where most apps put a floating
        // action, and the mark must never compete with the app's own control.
        NSLayoutConstraint.activate([
            mark.widthAnchor.constraint(equalToConstant: 22),
            mark.heightAnchor.constraint(equalToConstant: 22),
            mark.leadingAnchor.constraint(equalTo: host.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            mark.bottomAnchor.constraint(equalTo: host.safeAreaLayoutGuide.bottomAnchor, constant: -28),
        ])
    }

    fileprivate static func explain() {
        guard let root = currentWindow()?.rootViewController else { return }
        let alert = UIAlertController(
            title: "Running inside Yaver",
            message: """
            This app is being streamed from a Yaver box — it is a development build, not the \
            version installed on a device. Anything unfinished here is work in progress, not a \
            released bug.

            The way back lives in the Yaver viewer's own chrome, outside the video, which is what \
            makes it impossible to lose.

            Hiding this mark lasts until the next launch, so nobody forgets which build they are \
            testing.
            """,
            preferredStyle: .alert
        )
        // Polite means closeable. "for now", never "don't show again".
        alert.addAction(UIAlertAction(title: "Hide for now", style: .default) { _ in hide() })
        alert.addAction(UIAlertAction(title: "Close", style: .cancel))
        root.present(alert, animated: true)
    }

    private static func currentWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
    }

    /// Kept so a caller can log what the mark decided without re-deriving it.
    public static func describeDetection() -> String {
        if let override = streamedOverride { return "explicit: setStreamed(\(override))" }
        if isInsideYaver() { return "environment YAVER_STREAMED" }
        return "no Yaver signal — no mark shown"
    }
}

/// Selector target. A gesture recogniser needs an ObjC-visible object, which an
/// enum namespace cannot be.
private final class BadgeTarget: NSObject {
    static let shared = BadgeTarget()
    @objc func tapped() { YaverModeBadge.explain() }
}
#endif
