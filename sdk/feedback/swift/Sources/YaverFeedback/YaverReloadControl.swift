import Foundation
#if canImport(UIKit)
import UIKit
#endif

// ─── The in-app reload control for native Swift apps ─────────────────────────
//
// Every other Yaver feedback SDK ships a Hot Reload button inside its overlay.
// This SDK deliberately has no overlay at all — it is fire-and-forget, so a
// feedback submission never blocks the host app's UI — which left native Swift
// as the one stack where a developer could not reload the app they were
// looking at without leaving it.
//
// So this is the smallest thing that closes that gap honestly:
//
//   • `YaverFeedback.reload(_:)`   — programmatic, one line, wire it to your
//                                    own debug menu / gesture / shortcut.
//   • `YaverReloadControl`         — a floating two-button panel you can
//                                    install in one call when you don't want
//                                    to build one.
//
// Both refuse to exist in a release build. `FeedbackConfig.devBuild` defaults
// to the SDK's own `#if DEBUG`, and `ReloadActions.build` returns an EMPTY
// list when it is false — there is no code path that renders a reload button
// in a shipped app.

extension YaverFeedback {

    /// Result of a reload request.
    public enum ReloadOutcome {
        /// The machine accepted the request. Carries the line to show a human.
        case requested(String)
        /// It did not happen, and this NAMES why — never "reload failed".
        case failed(String)
    }

    /// Read the dev server's state so a UI can decide WHICH reload actions to
    /// offer, and disable the rest with a reason.
    ///
    /// Hands back nil when the machine cannot be reached at all — which the
    /// caller must render as "not connected", never as "no dev server". Those
    /// are two different problems with two different fixes.
    public static func devServerStatus(completion: @escaping (DevServerSnapshot?) -> Void) {
        guard let cfg = shared.config,
              let url = URL(string: cfg.agentURL.reloadTrimmedTrailingSlash + ReloadActions.statusPath)
        else {
            completion(nil)
            return
        }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(cfg.authToken)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 8

        URLSession.shared.dataTask(with: req) { data, response, _ in
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
                  let data = data,
                  let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else {
                completion(nil)
                return
            }
            completion(DevServerSnapshot(json: json))
        }.resume()
    }

    /// The reload actions this app may currently offer.
    ///
    /// Empty in a release build — that is the guard, and it is pinned by
    /// `ReloadActionsTests`.
    public static func reloadActions(snapshot: DevServerSnapshot?) -> [ReloadAction] {
        guard let cfg = shared.config else { return [] }
        return ReloadActions.build(
            snapshot: snapshot,
            isDevBuild: cfg.devBuild,
            connected: snapshot != nil,
            machineLabel: URL(string: cfg.agentURL)?.host
        )
    }

    /// Ask the machine's dev server to reload.
    ///
    /// `.fast` is the framework's cheapest refresh; `.full` is a
    /// framework-level restart (on Flutter the agent maps these to stdin "r"
    /// and "R" respectively).
    ///
    /// Unlike feedback submission, this is NOT fire-and-forget: the developer
    /// pressed a button and is waiting to see whether the app reloads, so a
    /// silent failure here is exactly the defect this SDK exists to avoid.
    /// Every failure path yields `.failed` with a named cause.
    ///
    /// Auth: the SAME bearer used for the feedback POST. `/dev/reload` is
    /// registered under `authSDKOrGuest` on the agent and is already inside
    /// the `guest-reload` SDK-token scope — no new secret, no widened gate.
    public static func reload(
        _ mode: ReloadWireMode = .fast,
        snapshot: DevServerSnapshot? = nil,
        completion: ((ReloadOutcome) -> Void)? = nil
    ) {
        guard let cfg = shared.config else {
            completion?(.failed("YaverFeedback.initialize() has not been called yet."))
            return
        }
        guard cfg.devBuild else {
            // Not an error the user should ever see — a release build has no
            // button to press. Stated anyway so a caller wiring this by hand
            // is told why nothing happened, instead of nothing happening.
            completion?(.failed("Reload is a development-build feature and is disabled in this build."))
            return
        }
        guard let url = URL(string: cfg.agentURL.reloadTrimmedTrailingSlash + ReloadActions.reloadPath),
              let body = try? JSONSerialization.data(withJSONObject: ["mode": mode.rawValue])
        else {
            completion?(.failed("Could not build the reload request — check agentURL."))
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(cfg.authToken)", forHTTPHeaderField: "Authorization")
        req.httpBody = body
        req.timeoutInterval = 30

        URLSession.shared.dataTask(with: req) { data, response, error in
            if let error = error {
                // Status 0 = the request never reached anything. A different
                // problem from a 5xx, so it gets a different sentence.
                completion?(.failed(ReloadActions.describeFailure(
                    status: 0, body: error.localizedDescription, snapshot: snapshot)))
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200...299).contains(status) else {
                let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                completion?(.failed(ReloadActions.describeFailure(
                    status: status, body: text, snapshot: snapshot)))
                return
            }
            completion?(.requested(mode == .full ? "Full reload requested." : "Hot reload requested."))
        }.resume()
    }
}

private extension String {
    var reloadTrimmedTrailingSlash: String {
        hasSuffix("/") ? String(dropLast()) : self
    }
}

#if canImport(UIKit)

/// A floating Hot Reload / Full Reload panel for native Swift apps.
///
/// One call installs it:
///
/// ```swift
/// YaverFeedback.initialize(FeedbackConfig(agentURL: ..., authToken: ...))
/// YaverReloadControl.install()
/// ```
///
/// It renders NOTHING in a release build — `install()` returns immediately
/// when `FeedbackConfig.devBuild` is false, so there is no window, no timer
/// and no network traffic in a shipped app.
public final class YaverReloadControl {

    private static var shared: YaverReloadControl?

    private var window: UIWindow?
    private var stack: UIStackView?
    private var statusLabel: UILabel?
    private var timer: Timer?
    private var snapshot: DevServerSnapshot?
    private var inFlight: ReloadActionID?

    /// Install the floating control. No-op in a release build, and no-op if
    /// already installed.
    @discardableResult
    public static func install() -> Bool {
        guard shared == nil else { return true }
        guard YaverFeedback.reloadActionsAvailable else { return false }
        let control = YaverReloadControl()
        shared = control
        control.attach()
        return true
    }

    /// Remove the control and stop its poll timer.
    public static func remove() {
        shared?.timer?.invalidate()
        shared?.window?.isHidden = true
        shared?.window = nil
        shared = nil
    }

    private func attach() {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
            ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
        else { return }

        let w = UIWindow(windowScene: scene)
        // A control panel above the app but BELOW system alerts, and
        // non-interactive outside its own buttons — a debug affordance must
        // never swallow the touches of the app it is helping you debug.
        w.windowLevel = .alert - 1
        w.backgroundColor = .clear
        w.isHidden = false

        let root = PassthroughViewController()
        w.rootViewController = root

        let panel = UIView()
        panel.translatesAutoresizingMaskIntoConstraints = false
        panel.backgroundColor = UIColor.black.withAlphaComponent(0.78)
        panel.layer.cornerRadius = 12

        let status = UILabel()
        status.translatesAutoresizingMaskIntoConstraints = false
        status.numberOfLines = 0
        status.font = .systemFont(ofSize: 11)
        status.textColor = UIColor.white.withAlphaComponent(0.75)
        status.text = "Checking the dev server…"

        let row = UIStackView()
        row.translatesAutoresizingMaskIntoConstraints = false
        row.axis = .horizontal
        row.spacing = 8
        row.distribution = .fillEqually

        let column = UIStackView(arrangedSubviews: [row, status])
        column.translatesAutoresizingMaskIntoConstraints = false
        column.axis = .vertical
        column.spacing = 6

        panel.addSubview(column)
        root.view.addSubview(panel)

        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: panel.topAnchor, constant: 10),
            column.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 12),
            column.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -12),
            column.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -10),
            panel.leadingAnchor.constraint(
                greaterThanOrEqualTo: root.view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            panel.trailingAnchor.constraint(
                equalTo: root.view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            panel.bottomAnchor.constraint(
                equalTo: root.view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
        ])

        self.window = w
        self.stack = row
        self.statusLabel = status
        render()

        // Poll while installed. A reload button whose enabled state was
        // decided once, at install, reads as broken the moment the dev server
        // comes up — the user sees "no dev server is running" against a
        // running dev server and concludes Yaver is lying.
        let t = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        RunLoop.main.add(t, forMode: .common)
        self.timer = t
        refresh()
    }

    private func refresh() {
        YaverFeedback.devServerStatus { [weak self] snapshot in
            DispatchQueue.main.async {
                self?.snapshot = snapshot
                self?.render()
            }
        }
    }

    private func render() {
        guard let row = stack else { return }
        let actions = YaverFeedback.reloadActions(snapshot: snapshot)

        row.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for action in actions {
            let button = UIButton(type: .system)
            button.setTitle(inFlight == action.id ? "…" : action.label, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
            // Greyed but still TAPPABLE when blocked — the tap is how we get
            // to say why. A control that silently does nothing is the defect.
            button.setTitleColor(action.enabled ? .white : UIColor.white.withAlphaComponent(0.45),
                                 for: .normal)
            button.backgroundColor = UIColor.white.withAlphaComponent(action.enabled ? 0.16 : 0.06)
            button.layer.cornerRadius = 8
            button.contentEdgeInsets = UIEdgeInsets(top: 7, left: 12, bottom: 7, right: 12)
            button.addAction(UIAction { [weak self] _ in self?.run(action) }, for: .touchUpInside)
            row.addArrangedSubview(button)
        }

        if let first = actions.first {
            statusLabel?.text = first.enabled ? first.hint : first.disabledReason
        } else {
            statusLabel?.text = nil
        }
        window?.isHidden = actions.isEmpty
    }

    private func run(_ action: ReloadAction) {
        guard action.enabled else {
            statusLabel?.text = action.disabledReason
            return
        }
        inFlight = action.id
        statusLabel?.text = "\(action.label)…"
        render()

        YaverFeedback.reload(action.mode, snapshot: snapshot) { [weak self] outcome in
            DispatchQueue.main.async {
                switch outcome {
                case .requested(let message):
                    self?.statusLabel?.text = message
                case .failed(let reason):
                    // describeFailure already produced a named cause. Show it
                    // verbatim rather than replacing it with "Reload failed".
                    self?.statusLabel?.text = reason
                }
                self?.inFlight = nil
                self?.render()
                self?.refresh()
            }
        }
    }
}

/// Root controller whose view passes touches through to the app underneath,
/// except where one of our own subviews is.
private final class PassthroughViewController: UIViewController {
    override func loadView() {
        view = PassthroughView()
        view.backgroundColor = .clear
    }
}

private final class PassthroughView: UIView {
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        for subview in subviews where !subview.isHidden
            && subview.alpha > 0
            && subview.frame.contains(point) {
            return true
        }
        return false
    }
}

#endif

extension YaverFeedback {
    /// True when this build may show reload controls at all.
    ///
    /// Reads the SAME `devBuild` flag `ReloadActions.build` gates on, so the
    /// installer and the renderer can never disagree about whether a shipped
    /// app gets a reload button.
    static var reloadActionsAvailable: Bool {
        shared.config?.devBuild == true
    }
}
