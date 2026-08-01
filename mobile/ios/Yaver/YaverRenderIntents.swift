import AppIntents
import UIKit

@available(iOS 16.0, *)
private enum YaverIntentLink {
  static func render(project: String, device: String?, mode: String?) -> URL? {
    var components = URLComponents()
    components.scheme = "yaver"
    components.host = "render"
    var items = [URLQueryItem]()
    let p = project.trimmingCharacters(in: .whitespacesAndNewlines)
    if !p.isEmpty {
      items.append(URLQueryItem(name: "project", value: p))
    }
    let d = (device ?? "primary").trimmingCharacters(in: .whitespacesAndNewlines)
    if !d.isEmpty {
      items.append(URLQueryItem(name: "device", value: d))
    }
    let m = (mode ?? "auto").trimmingCharacters(in: .whitespacesAndNewlines)
    if !m.isEmpty {
      items.append(URLQueryItem(name: "mode", value: m))
    }
    components.queryItems = items
    return components.url
  }

  static func shortcut(id: String) -> URL? {
    var components = URLComponents()
    components.scheme = "yaver"
    components.host = "shortcut"
    components.queryItems = [URLQueryItem(name: "id", value: id.trimmingCharacters(in: .whitespacesAndNewlines))]
    return components.url
  }

  @MainActor
  static func open(_ url: URL) {
    UIApplication.shared.open(url)
  }
}

@available(iOS 16.0, *)
struct YaverRenderProjectIntent: AppIntent {
  static var title: LocalizedStringResource = "Render Project"
  static var description = IntentDescription("Open a project in Yaver on the primary or named device.")
  static var openAppWhenRun = true

  @Parameter(title: "Project")
  var project: String

  @Parameter(title: "Device", default: "primary")
  var device: String

  @Parameter(title: "Mode", default: "auto")
  var mode: String

  static var parameterSummary: some ParameterSummary {
    Summary("Render \(\.$project) on \(\.$device)")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let url = YaverIntentLink.render(project: project, device: device, mode: mode) else {
      return .result(dialog: "I could not build the Yaver render link.")
    }
    await YaverIntentLink.open(url)
    let name = project.trimmingCharacters(in: .whitespacesAndNewlines)
    return .result(dialog: name.isEmpty ? "Opening Yaver." : "Rendering \(name) in Yaver.")
  }
}

@available(iOS 16.0, *)
struct YaverOpenShortcutIntent: AppIntent {
  static var title: LocalizedStringResource = "Run Yaver Shortcut"
  static var description = IntentDescription("Run a saved Yaver shortcut.")
  static var openAppWhenRun = true

  @Parameter(title: "Shortcut")
  var shortcut: String

  static var parameterSummary: some ParameterSummary {
    Summary("Run \(\.$shortcut)")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let url = YaverIntentLink.shortcut(id: shortcut) else {
      return .result(dialog: "I could not build the Yaver shortcut link.")
    }
    await YaverIntentLink.open(url)
    return .result(dialog: "Running \(shortcut) in Yaver.")
  }
}

@available(iOS 16.0, *)
struct YaverAppShortcuts: AppShortcutsProvider {
  // Phrases carry NO parameters.
  //
  // These used to interpolate \(\.$project), \(\.$device) and \(\.$shortcut),
  // which failed the archive of build 497 with five halting errors from
  // appintentsmetadataprocessor:
  //
  //     Invalid parameter type. AppEntity and AppEnum are the only allowed
  //     types for project
  //     Multiple parameters detected in phrase. A single phrase can only use a
  //     single parameter.
  //
  // Both rules are Apple's and neither is negotiable: a spoken phrase may embed
  // at most one parameter, and only an AppEntity or AppEnum — never a String,
  // because Siri has no vocabulary to resolve free text against. Our three
  // parameters are all String (a project slug, a device id, a shortcut id), so
  // none of them can appear in a phrase as written.
  //
  // Dropping them from the phrases costs nothing the user can feel: the
  // parameters still exist on the intents, so the Shortcuts app prompts for
  // them and Siri asks for the value after the phrase matches. Turning them
  // into AppEntities is the richer fix — it would let "Render sfmg in Yaver"
  // match by voice — and it needs a real EntityQuery backed by the project and
  // device lists, which is a feature, not a build repair.
  //
  // The failure mode to avoid repeating: this whole target is metadata-only, so
  // the errors do not name a compiler diagnostic and `xcodebuild` reports a
  // bare "(2 failures)". The five real lines are only in the full log.
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: YaverRenderProjectIntent(),
      phrases: [
        "Render a project in \(.applicationName)",
        "Render in \(.applicationName)",
      ],
      shortTitle: "Render Project",
      systemImageName: "play.rectangle"
    )
    AppShortcut(
      intent: YaverOpenShortcutIntent(),
      phrases: [
        "Run a \(.applicationName) shortcut",
        "Run \(.applicationName) shortcut",
      ],
      shortTitle: "Run Shortcut",
      systemImageName: "bolt"
    )
  }
}

