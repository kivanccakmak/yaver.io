import UIKit
import React

/// Why this file exists (2026-07-26 incident):
///
/// Info.plist declares a `UIApplicationSceneManifest` for the CarPlay scene
/// (`YaverCarPlaySceneDelegate`). The mere PRESENCE of that manifest flips the
/// whole app into scene-based lifecycle — and with NO
/// `UIWindowSceneSessionRoleApplication` entry, the phone UI ran in an
/// anonymous window scene with no scene delegate. In that state UIKit routes
/// URL opens and NSUserActivity to the (nonexistent) scene delegate and NEVER
/// calls `AppDelegate.application(_:open:options:)` — so every `yaver://` deep
/// link app-wide was silently dropped: `?selectDevice=`, the car-voice home
/// screen quick action, all integrations. Verified with
/// `xcrun simctl openurl booted "yaver://car-voice-coding"` doing nothing on
/// build 474 while the exact same forwarding code sat unreached in
/// AppDelegate.
///
/// The fix is this delegate plus its `UIWindowSceneSessionRoleApplication`
/// declaration in Info.plist. It deliberately owns NOTHING:
///   - The window and the single React instance are still created by
///     `AppDelegate.didFinishLaunching` (which runs before any scene
///     connects). We only adopt that window into the scene — creating a
///     second React root here would double-boot the bridge.
///   - URL / user-activity / quick-action events are forwarded to the SAME
///     AppDelegate methods that handled them pre-scenes, so the car-voice
///     pending flag and RCTLinkingManager wiring stay in exactly one place.
final class YaverSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate? {
    UIApplication.shared.delegate as? AppDelegate
  }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }

    // Adopt the window AppDelegate already built (didFinishLaunching runs
    // before the first scene connects). Never build a second React instance.
    if let existing = appDelegate?.window {
      if existing.windowScene !== windowScene {
        existing.windowScene = windowScene
      }
      existing.makeKeyAndVisible()
      window = existing
    }

    // Cold-launch payloads arrive here instead of launchOptions under the
    // scene lifecycle — forward them through the one shared path.
    for context in connectionOptions.urlContexts {
      forward(url: context.url)
    }
    for activity in connectionOptions.userActivities {
      forward(userActivity: activity)
    }
    if let shortcut = connectionOptions.shortcutItem {
      appDelegate?.application(
        UIApplication.shared, performActionFor: shortcut, completionHandler: { _ in })
    }
  }

  /// Warm `yaver://` opens (app already running).
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      forward(url: context.url)
    }
  }

  /// Universal links / handoff while running.
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    forward(userActivity: userActivity)
  }

  /// Home-screen quick actions also route to the scene under scene lifecycle.
  func windowScene(
    _ windowScene: UIWindowScene,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    guard let appDelegate else {
      completionHandler(false)
      return
    }
    appDelegate.application(
      UIApplication.shared, performActionFor: shortcutItem, completionHandler: completionHandler)
  }

  private func forward(url: URL) {
    NSLog("[YaverSceneDelegate] forwarding URL open: %@", url.absoluteString)
    if let appDelegate {
      // Reuses RCTLinkingManager forwarding AND the car-voice pending flag.
      _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
    } else {
      _ = RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
    }
  }

  private func forward(userActivity: NSUserActivity) {
    _ = RCTLinkingManager.application(
      UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}
