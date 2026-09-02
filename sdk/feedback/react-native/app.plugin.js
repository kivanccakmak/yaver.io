/**
 * Expo config plugin for yaver-feedback-react-native.
 *
 * Adds:
 * - iOS/Android permissions for camera + microphone (feedback screenshots/voice)
 * - iOS: YaverHotReload native module for Hermes bundle hot reload
 * - AppDelegate hook to load hot-reloaded bundles on startup
 *
 * Usage in app.json:
 *   { "expo": { "plugins": ["yaver-feedback-react-native"] } }
 */
// Resolve @expo/config-plugins from the host project's node_modules
// (not from the SDK's directory, which may be symlinked)
const configPluginsPath = require.resolve("@expo/config-plugins", {
  paths: [process.cwd()],
});
const {
  withInfoPlist,
  withAndroidManifest,
  withXcodeProject,
  withAppDelegate,
  withMainApplication,
  withMainActivity,
  withDangerousMod,
  createRunOncePlugin,
} = require(configPluginsPath);
const path = require("path");
const fs = require("fs");

const pkg = require("./package.json");

function withYaverFeedbackIOS(config) {
  return withInfoPlist(config, (config) => {
    if (!config.modResults.NSCameraUsageDescription) {
      config.modResults.NSCameraUsageDescription =
        "Used for visual feedback screenshots during development";
    }
    if (!config.modResults.NSMicrophoneUsageDescription) {
      config.modResults.NSMicrophoneUsageDescription =
        "Used for voice annotations in feedback reports during development";
    }
    const bundleId = config.ios?.bundleIdentifier;
    if (bundleId) {
      const scheme = `yaver-dogfood-${bundleId.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
      const urlTypes = config.modResults.CFBundleURLTypes || [];
      const exists = urlTypes.some((entry) => Array.isArray(entry.CFBundleURLSchemes) && entry.CFBundleURLSchemes.includes(scheme));
      if (!exists) urlTypes.push({ CFBundleURLName: `${bundleId}.yaver-dogfood`, CFBundleURLSchemes: [scheme] });
      config.modResults.CFBundleURLTypes = urlTypes;
    }
    return config;
  });
}

function withYaverFeedbackAndroid(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    if (!manifest["uses-permission"]) {
      manifest["uses-permission"] = [];
    }

    const permissions = manifest["uses-permission"];
    // Camera + mic for screenshot/voice. The rest are required to
    // make `react-native-record-screen` actually start on modern
    // Android — without FOREGROUND_SERVICE_MEDIA_PROJECTION
    // (API 34+, mandatory) startRecording throws SecurityException,
    // and without POST_NOTIFICATIONS (API 33+) the recording
    // notification fails to post which some OEMs use as a signal
    // to kill the projection a few seconds in. Inject all five
    // unconditionally — listing them does NOT trigger any user
    // prompt; the actual runtime dialogs only fire if the app
    // calls startVideoRecording().
    const requiredPermissions = [
      "android.permission.CAMERA",
      "android.permission.RECORD_AUDIO",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
      "android.permission.POST_NOTIFICATIONS",
    ];

    for (const perm of requiredPermissions) {
      const exists = permissions.some(
        (p) => p.$?.["android:name"] === perm
      );
      if (!exists) {
        permissions.push({ $: { "android:name": perm } });
      }
    }

    const packageName = config.android?.package;
    const mainActivity = manifest.application?.[0]?.activity?.find((activity) =>
      activity.$?.["android:name"]?.endsWith("MainActivity")
    );
    if (packageName && mainActivity) {
      const scheme = `yaver-dogfood-${packageName.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`;
      mainActivity["intent-filter"] = mainActivity["intent-filter"] || [];
      const exists = mainActivity["intent-filter"].some((filter) =>
        filter.data?.some((data) => data.$?.["android:scheme"] === scheme)
      );
      if (!exists) {
        mainActivity["intent-filter"].push({
          action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
          category: [
            { $: { "android:name": "android.intent.category.DEFAULT" } },
            { $: { "android:name": "android.intent.category.BROWSABLE" } },
          ],
          data: [{ $: { "android:scheme": scheme, "android:host": "activate" } }],
        });
      }
    }

    return config;
  });
}

/**
 * Copy YaverHotReload native module files into the iOS project directory
 * AND register them in project.pbxproj so Xcode actually compiles them.
 *
 * The file-copy step uses withDangerousMod; the project registration
 * uses withXcodeProject. Both are needed — if we only copy the files
 * they sit in the filesystem unreferenced, Xcode ignores them, the
 * final .ipa has no `YaverHotReload` class, and the agent's
 * `reload_bundle` broadcast silently fails to load a new Hermes bundle.
 * This is a bug we've hit repeatedly; keep both steps wired.
 */
function withYaverHotReloadNativeModule(config) {
  // Step 1 — copy source files onto disk.
  config = withDangerousMod(config, [
    "ios",
    (config) => {
      const sdkIosDir = path.resolve(__dirname, "ios");
      const appName = config.modRequest.projectName;
      if (!appName) return config;
      const targetDir = path.join(
        config.modRequest.platformProjectRoot,
        appName
      );

      const filesToCopy = [
        "YaverHotReload.swift",
        "YaverHotReload.m",
        "YaverDogfoodGesture.swift",
        "YaverDogfoodGesture.m",
      ];
      for (const fileName of filesToCopy) {
        const src = path.join(sdkIosDir, fileName);
        const dst = path.join(targetDir, fileName);
        if (fs.existsSync(src)) {
          // Always overwrite so bumping the SDK version actually
          // picks up the new native code on the next prebuild
          // instead of silently keeping a stale copy.
          fs.copyFileSync(src, dst);
        }
      }

      return config;
    },
  ]);

  // Step 2 — register the files in project.pbxproj so Xcode compiles
  // them into the app target. Without this, the files exist on disk
  // but are invisible to the build system.
  config = withXcodeProject(config, (config) => {
    const proj = config.modResults;
    const appName = config.modRequest.projectName;
    if (!appName) return config;

    // Look up the group key for the app's source folder (same group
    // that holds AppDelegate.swift). Expo's naming is consistent —
    // projectName === group name in the tree.
    const groupKey =
      proj.findPBXGroupKey({ name: appName }) ||
      proj.findPBXGroupKey({ path: appName });
    if (!groupKey) return config;

    // Target UUID — getFirstTarget is the app target in a standard
    // Expo project. For multi-target projects, users can opt out via
    // enableHotReload: false.
    const target = proj.getFirstTarget();
    if (!target || !target.uuid) return config;

    const filesToAdd = [
      "YaverHotReload.swift",
      "YaverHotReload.m",
      "YaverDogfoodGesture.swift",
      "YaverDogfoodGesture.m",
    ];
    for (const fileName of filesToAdd) {
      const relPath = `${appName}/${fileName}`;
      // addSourceFile registers PBXFileReference + PBXBuildFile, adds
      // the file to the group, and wires it into the target's
      // Sources build phase — which is exactly what we need. It's
      // idempotent in practice because the sdk-level copyFileSync
      // step always writes the file, and addSourceFile is a no-op if
      // the reference already exists.
      if (!proj.hasFile || !proj.hasFile(relPath)) {
        try {
          proj.addSourceFile(relPath, { target: target.uuid }, groupKey);
        } catch (e) {
          // If a duplicate slips through, xcode-lib throws; safe to
          // ignore since the file already being registered is the
          // desired state.
        }
      }
    }

    return config;
  });

  return config;
}

/**
 * Patch AppDelegate to:
 * 1. Return hot-reloaded bundle URL on startup (so reloaded bundle persists)
 * 2. Handle YaverHotReloadBundle notification to recreate the RN bridge
 *    with the new bundle (enables N reloads without app restart)
 *
 * Uses the same pattern as Yaver's own AppDelegate: tear down old bridge,
 * create new ExpoReactNativeFactory with overrideBundleURL, startReactNative.
 */
function withYaverAppDelegateHook(config) {
  return withAppDelegate(config, (config) => {
    const contents = config.modResults.contents;

    // Existing consumers may already have the hot-reload hook from an older
    // SDK. Still apply newer, independently-versioned native contracts.
    if (contents.includes("YaverHotReload")) {
      config.modResults.contents = patchDogfoodAppShortcut(patchHotReloadRestore(
        patchHotReloadBootConfirmation(contents)
      ));
      return config;
    }

    // For Swift AppDelegate (Expo SDK 50+)
    let patched = contents;

    // 1. Hook bundleURL() to return hot bundle on startup
    if (patched.includes("func bundleURL()")) {
      patched = patched.replace(
        /func bundleURL\(\) -> URL\? \{/,
        `func bundleURL() -> URL? {
    // Yaver Feedback SDK: load hot-reloaded bundle if available
    if let yaverBundle = YaverHotReload.bundleURL() { return yaverBundle }`
      );
    }

    // 2. Add reload notification handler and bridge recreation logic.
    //
    // Must be inserted into the AppDelegate class — NOT ReactNativeDelegate
    // (a separate class below it in the same file). The handler accesses
    // `self.window`, `self.reactNativeDelegate`, `self.reactNativeFactory`,
    // and `self.bindReactNativeFactory(...)` — all of which only exist
    // on AppDelegate. An earlier version of this plugin used
    // lastIndexOf("}"), which in modern Expo templates lands inside
    // ReactNativeDelegate, producing build errors like
    //   "cannot find 'setupYaverHotReload' in scope"
    //   "value of type 'ReactNativeDelegate' has no member 'window'"
    //
    // The anchor we want is the closing brace of the AppDelegate class
    // declaration itself. Find its opening, then walk braces to its
    // matching close.
    const classCloseIndex = findAppDelegateClassClose(patched);
    if (classCloseIndex > 0) {
      const reloadHandler = `
  // MARK: - Yaver Feedback SDK Hot Reload

  private var yaverIsReloading = false

  private func setupYaverHotReload() {
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(yaverHandleHotReload(_:)),
      name: Notification.Name("YaverHotReloadBundle"),
      object: nil
    )
    // Crash-revert safety net: only a real first React frame confirms boot.
    // Uptime is not success: JS can fail while the native process remains
    // alive on its launch screen indefinitely.
    NotificationCenter.default.addObserver(
      forName: NSNotification.Name(rawValue: "RCTContentDidAppearNotification"),
      object: nil,
      queue: .main
    ) { _ in YaverHotReload.markBootSuccessful() }
  }

  @objc private func yaverHandleHotReload(_ notification: Notification) {
    guard !yaverIsReloading else { return }
    yaverIsReloading = true

    let restoreEmbedded = notification.userInfo?["restoreEmbedded"] as? Bool == true
    if !restoreEmbedded {
      guard let bundlePath = notification.userInfo?["bundlePath"] as? String else {
        yaverIsReloading = false
        return
      }
      guard FileManager.default.fileExists(atPath: bundlePath) else {
        NSLog("[YaverHotReload] bundle not found at %@", bundlePath)
        yaverIsReloading = false
        return
      }
      NSLog("[YaverHotReload] reloading bridge with %@", bundlePath)
    } else {
      NSLog("[YaverHotReload] restoring app-bundled React Native surface")
    }

    guard let window = self.window else {
      yaverIsReloading = false
      return
    }

    // Show loading placeholder
    let placeholder = UIView(frame: window.bounds)
    placeholder.backgroundColor = .black
    let spinner = UIActivityIndicatorView(style: .large)
    spinner.color = .white
    spinner.center = placeholder.center
    spinner.startAnimating()
    placeholder.addSubview(spinner)
    window.rootViewController?.view = placeholder

    // Brief delay for old bridge to tear down
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
      guard let self = self else { return }

      // No explicit override is needed. For a normal reload bundleURL()
      // resolves the saved hot bundle; after Exit cleared it the same
      // delegate falls through to the app's embedded bundle.
      let delegate = ReactNativeDelegate()
      delegate.dependencyProvider = RCTAppDependencyProvider()

      let factory = ExpoReactNativeFactory(delegate: delegate)
      self.reactNativeDelegate = delegate
      self.reactNativeFactory = factory
      self.bindReactNativeFactory(factory)

      factory.startReactNative(
        withModuleName: "main",
        in: window,
        launchOptions: nil
      )
      self.yaverIsReloading = false
      NSLog("[YaverHotReload] bridge recreated successfully")
    }
  }
`;

      patched =
        patched.slice(0, classCloseIndex) +
        reloadHandler +
        patched.slice(classCloseIndex);
    }

    // 3. Call setupYaverHotReload() in didFinishLaunchingWithOptions
    if (patched.includes("super.application(application, didFinishLaunchingWithOptions:")) {
      patched = patched.replace(
        "super.application(application, didFinishLaunchingWithOptions:",
        "setupYaverHotReload()\n    return super.application(application, didFinishLaunchingWithOptions:"
      );
      // Remove the duplicate "return" if the original already had one
      patched = patched.replace("return setupYaverHotReload()", "setupYaverHotReload()");
    }

    config.modResults.contents = patchDogfoodAppShortcut(patchHotReloadRestore(patched));
    return config;
  });
}

/** Upgrade AppDelegates produced by SDKs before clearBundleAndReload existed.
 * The old handler required a saved bundle path, so clearing the file first
 * made Exit Dogfood incapable of recreating the embedded app. */
function patchHotReloadRestore(contents) {
  if (!contents.includes('yaverHandleHotReload') || contents.includes('restoreEmbedded')) return contents;
  let patched = contents.replace(
    `    guard let bundlePath = notification.userInfo?["bundlePath"] as? String else {
      yaverIsReloading = false
      return
    }

    let bundleURL = URL(fileURLWithPath: bundlePath)
    guard FileManager.default.fileExists(atPath: bundlePath) else {
      NSLog("[YaverHotReload] bundle not found at %@", bundlePath)
      yaverIsReloading = false
      return
    }

    NSLog("[YaverHotReload] reloading bridge with %@", bundlePath)`,
    `    let restoreEmbedded = notification.userInfo?["restoreEmbedded"] as? Bool == true
    if !restoreEmbedded {
      guard let bundlePath = notification.userInfo?["bundlePath"] as? String else {
        yaverIsReloading = false
        return
      }
      guard FileManager.default.fileExists(atPath: bundlePath) else {
        NSLog("[YaverHotReload] bundle not found at %@", bundlePath)
        yaverIsReloading = false
        return
      }
      NSLog("[YaverHotReload] reloading bridge with %@", bundlePath)
    } else {
      NSLog("[YaverHotReload] restoring app-bundled React Native surface")
    }`
  );
  patched = patched.replace(
    /\n      _ = bundleURL  \/\/ silence "unused" warning; the file path was\n                    \/\/ baked into YaverHotReload by loadBundle\(\) above/,
    ''
  );
  return patched;
}

/** Upgrade an already-generated AppDelegate from the pre-0.9.10 boot guard.
 * Older plugins treated ten seconds of process uptime as a successful React
 * boot. A JS exception can leave that process alive on the native splash, so
 * the timer reset the crash counter forever and prevented bundle rollback. */
function patchHotReloadBootConfirmation(contents) {
  let patched = contents;
  patched = patched.replace(
    /    \/\/ Crash-revert safety net: clear the boot-attempt counter once\n    \/\/ RN renders its first frame, OR after 10 s of uptime — whichever\n    \/\/ fires first\. If neither fires \(bundle crashes before render\),\n    \/\/ YaverHotReload\.bundleURL\(\) will eventually revert to the\n    \/\/ TestFlight-installed bundle after 3 failed boots\. See\n    \/\/ YaverHotReload\.swift for the full state machine\./,
    `    // Crash-revert safety net: only a real first React frame confirms boot.\n    // Uptime is not success: JS can fail while the native process remains\n    // alive on its launch screen indefinitely.`
  );
  patched = patched.replace(
    /    DispatchQueue\.main\.asyncAfter\(deadline: \.now\(\) \+ 10\) \{\n      YaverHotReload\.markBootSuccessful\(\)\n    \}\n?/g,
    ""
  );
  return patched;
}

/** Wire the dynamic iOS Home Screen shortcut into the SDK native module.
 * The shortcut itself is created at runtime only after backend ACL success;
 * this hook merely consumes a user-selected action on warm/cold launch. */
function patchDogfoodAppShortcut(contents) {
  if (contents.includes("Yaver Feedback SDK Dogfood Shortcut")) return contents;
  let patched = contents;

  // Cold launch: UIKit supplies the shortcut in launchOptions before RN/JS.
  const setupAnchor = "    setupYaverHotReload()";
  if (patched.includes(setupAnchor)) {
    patched = patched.replace(
      setupAnchor,
      `    if let yaverShortcut = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem,
       yaverShortcut.type == YaverHotReload.dogfoodShortcutType {
      YaverHotReload.markDogfoodShortcutPending()
    }
${setupAnchor}`
    );
  }

  const classCloseIndex = findAppDelegateClassClose(patched);
  if (classCloseIndex > 0) {
    const handler = `
  // MARK: - Yaver Feedback SDK Dogfood Shortcut

  public override func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    if shortcutItem.type == YaverHotReload.dogfoodShortcutType {
      YaverHotReload.markDogfoodShortcutPending()
      completionHandler(true)
      return
    }
    super.application(application, performActionFor: shortcutItem, completionHandler: completionHandler)
  }
`;
    patched = patched.slice(0, classCloseIndex) + handler + patched.slice(classCloseIndex);
  }
  return patched;
}

/** Scene-based iOS apps receive Home Screen quick actions through their
 * UIWindowSceneDelegate, not AppDelegate. A CarPlay scene manifest is enough
 * to opt an otherwise ordinary Expo app into that lifecycle, so patch the
 * phone scene delegate when a host has one. */
function withYaverSceneDelegateShortcut(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const appName = config.modRequest.projectName;
      if (!appName) return config;
      const sourceDir = path.join(config.modRequest.platformProjectRoot, appName);
      if (!fs.existsSync(sourceDir)) return config;

      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith("SceneDelegate.swift")) continue;
        const sourcePath = path.join(sourceDir, entry.name);
        const source = fs.readFileSync(sourcePath, "utf8");
        if (!source.includes("UIWindowSceneDelegate")) continue;
        const patched = patchDogfoodSceneDelegate(source);
        if (patched !== source) fs.writeFileSync(sourcePath, patched);
      }
      return config;
    },
  ]);
}

function patchDogfoodSceneDelegate(contents) {
  if (contents.includes("Yaver Feedback SDK Dogfood Scene Shortcut")) return contents;

  let patched = insertAtEndOfMethod(
    contents,
    "options connectionOptions: UIScene.ConnectionOptions",
    `
    // Yaver Feedback SDK Dogfood Scene Shortcut: cold launch.
    if let yaverShortcut = connectionOptions.shortcutItem,
       yaverShortcut.type == YaverHotReload.dogfoodShortcutType {
      YaverHotReload.markDogfoodShortcutPending()
    }
`
  );

  // A custom scene delegate may already forward quick actions to the patched
  // AppDelegate. Keep that host-owned behavior instead of declaring a second
  // method with the same Swift selector.
  if (patched.includes("performActionFor shortcutItem")) return patched;

  const classCloseIndex = findWindowSceneDelegateClassClose(patched);
  if (classCloseIndex < 0) return patched;
  const handler = `
  // MARK: - Yaver Feedback SDK Dogfood Scene Shortcut

  func windowScene(
    _ windowScene: UIWindowScene,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    guard shortcutItem.type == YaverHotReload.dogfoodShortcutType else {
      completionHandler(false)
      return
    }
    YaverHotReload.markDogfoodShortcutPending()
    completionHandler(true)
  }
`;
  return patched.slice(0, classCloseIndex) + handler + patched.slice(classCloseIndex);
}

function findWindowSceneDelegateClassClose(contents) {
  const headerMatch = contents.match(/class\s+\w+\s*:[^{]*UIWindowSceneDelegate[^{]*\{/);
  if (!headerMatch) return -1;
  const bodyStart = headerMatch.index + headerMatch[0].length - 1;
  let depth = 0;
  for (let i = bodyStart; i < contents.length; i++) {
    if (contents[i] === "{") depth++;
    else if (contents[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Locate the closing brace of `class AppDelegate: ...` in an Expo
// Swift AppDelegate file. Returns the index of the matching `}` for
// the AppDelegate class's opening `{`, or -1 if not found. We need
// this because Expo's modern template declares TWO classes in the
// same file (AppDelegate + ReactNativeDelegate), and the SDK's
// reload handler only makes sense on the AppDelegate one.
function findAppDelegateClassClose(contents) {
  // Match both `public class AppDelegate` and `class AppDelegate`,
  // with either inheritance colon or a plain body.
  const headerMatch = contents.match(/class\s+AppDelegate\s*[:{][^{]*\{/);
  if (!headerMatch) return -1;
  const bodyStart = headerMatch.index + headerMatch[0].length - 1; // index of the opening `{`
  // Walk braces to find the matching close. Minimal — we don't try
  // to parse strings/comments because the file is machine-generated
  // by Expo, so braces inside strings are not a realistic concern
  // at this layer.
  let depth = 0;
  for (let i = bodyStart; i < contents.length; i++) {
    const ch = contents[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Copy Android native module source files and register the package.
 * Also patches MainApplication to use hot-reloaded bundle on startup.
 */
function withYaverAndroidHotReload(config) {
  // Copy Java source files
  config = withDangerousMod(config, [
    "android",
    (config) => {
      const sdkAndroidDir = path.resolve(__dirname, "android", "src", "main", "java", "io", "yaver", "feedback");
      const targetDir = path.join(
        config.modRequest.platformProjectRoot,
        "app", "src", "main", "java", "io", "yaver", "feedback"
      );

      if (fs.existsSync(sdkAndroidDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
        for (const file of fs.readdirSync(sdkAndroidDir)) {
          fs.copyFileSync(
            path.join(sdkAndroidDir, file),
            path.join(targetDir, file)
          );
        }
      }
      return config;
    },
  ]);

  // Patch MainApplication to register the package and use hot bundle.
  //
  // MainApplication is Kotlin on React Native 0.73+ (every current Expo
  // template) and Java before that. The two need genuinely different code —
  // `new Foo()`, `final`, and `@Override` are all syntax errors in Kotlin —
  // so branch on the language Expo reports rather than assuming.
  config = withMainApplication(config, (config) => {
    if (config.modResults.contents.includes("YaverHotReload")) {
      return config;
    }
    config.modResults.contents =
      config.modResults.language === "kt"
        ? patchMainApplicationKotlin(config.modResults.contents)
        : patchMainApplicationJava(config.modResults.contents);
    return config;
  });

  // ReactActivity forwards warm-launch intents to RN but does not update
  // Activity.getIntent(). The native module consumes the explicit shortcut
  // extra from getIntent(), so retain the latest intent for warm launches.
  config = withMainActivity(config, (config) => {
    let contents = config.modResults.contents;
    if (contents.includes("yaverDogfoodShortcutIntent")) return config;
    const classClose = contents.lastIndexOf("}");
    if (classClose < 0) return config;
    const method = config.modResults.language === "kt"
      ? `
  // Yaver Feedback SDK: retain dynamic Dogfood shortcut warm-launch intent.
  override fun onNewIntent(yaverDogfoodShortcutIntent: android.content.Intent) {
    setIntent(yaverDogfoodShortcutIntent)
    super.onNewIntent(yaverDogfoodShortcutIntent)
  }
`
      : `
  // Yaver Feedback SDK: retain dynamic Dogfood shortcut warm-launch intent.
  @Override public void onNewIntent(android.content.Intent yaverDogfoodShortcutIntent) {
    setIntent(yaverDogfoodShortcutIntent);
    super.onNewIntent(yaverDogfoodShortcutIntent);
  }
`;
    config.modResults.contents = contents.slice(0, classClose) + method + contents.slice(classClose);
    return config;
  });

  return config;
}

/**
 * Insert `snippet` immediately before the closing brace of the method whose
 * signature contains `anchor`, by matching braces from the method's opening
 * one.
 *
 * The boot guard has to run at the END of onCreate: it touches
 * reactNativeHost, and reaching that before super.onCreate() and
 * SoLoader.init() would initialise React before its native libraries are
 * loaded. Returns the contents unchanged if the anchor isn't found — a
 * missing safety net is survivable, a corrupted MainApplication is not.
 */
function insertAtEndOfMethod(contents, anchor, snippet) {
  const anchorIdx = contents.indexOf(anchor);
  if (anchorIdx === -1) return contents;
  const open = contents.indexOf("{", anchorIdx);
  if (open === -1) return contents;

  let depth = 0;
  for (let i = open; i < contents.length; i++) {
    const ch = contents[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return contents.slice(0, i) + snippet + contents.slice(i);
      }
    }
  }
  return contents;
}

/** Kotlin MainApplication (React Native 0.73+). */
function patchMainApplicationKotlin(contents) {
  // Imports. Kotlin takes no semicolons.
  contents = contents.replace(
    "import com.facebook.react.ReactApplication",
    "import com.facebook.react.ReactApplication\nimport io.yaver.feedback.YaverHotReloadModule\nimport io.yaver.feedback.YaverHotReloadPackage"
  );

  // Register the package. Anchor on `return packages` rather than on
  // `packages.add(` — the template's only occurrence of that is inside a
  // commented-out example line.
  contents = contents.replace(
    /(\n([ \t]*)return packages\n)/,
    "\n$2packages.add(YaverHotReloadPackage())\n$1"
  );

  // Load a hot-pushed bundle when one is present. Inserted before
  // getJSMainModuleName, which every Expo template defines.
  if (!contents.includes("getJSBundleFile")) {
    contents = contents.replace(
      /(\n([ \t]*)override fun getJSMainModuleName\(\))/,
      `
$2override fun getJSBundleFile(): String? {
$2  // Yaver Feedback SDK: load hot-reloaded bundle if available
$2  val hotBundle = YaverHotReloadModule.getSavedBundleFile(application.applicationContext)
$2  return hotBundle?.absolutePath ?: super.getJSBundleFile()
$2}
$1`
    );
  }

  // Crash-revert safety net: clear the boot-attempt counter once the React
  // context initialises (bundle loaded successfully), AND via a 10-s fallback
  // in case that listener never fires (e.g. an infinite loop in the root
  // component). If neither fires, YaverHotReloadModule.getSavedBundleFile()
  // reverts to the APK-bundled bundle after 3 failed cold starts. Parity with
  // YaverHotReload.swift on iOS.
  if (!contents.includes("yaverHotReloadBootListener")) {
    contents = insertAtEndOfMethod(
      contents,
      "override fun onCreate()",
      `
    // Yaver Feedback SDK hot-reload crash-revert safety net
    val yaverHotReloadCtx: android.content.Context = applicationContext
    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
      { YaverHotReloadModule.markBootSuccessful(yaverHotReloadCtx) },
      10000
    )
    try {
      // Anonymous object, not a lambda: SAM conversion needs a Java interface
      // or a Kotlin \`fun interface\`, and as of RN 0.81
      // com.facebook.react.ReactInstanceEventListener is a plain Kotlin
      // interface (ReactInstanceEventListener.kt). A lambda there fails
      // :app:compileReleaseKotlin with "Argument type mismatch: actual type is
      // 'Function0<Unit>'" — i.e. the host app cannot build a release AAB at
      // all. The Java path below already did this correctly.
      reactNativeHost.reactInstanceManager.addReactInstanceEventListener(
        object : com.facebook.react.ReactInstanceEventListener {
          override fun onReactContextInitialized(
            context: com.facebook.react.bridge.ReactContext
          ) {
            YaverHotReloadModule.markBootSuccessful(yaverHotReloadCtx)
          }
        }
      )
    } catch (yaverHotReloadBootListener: Throwable) {
      // Bridgeless / New Architecture does not expose reactInstanceManager;
      // the 10-s fallback above still covers us.
    }
`
    );
  }

  return contents;
}

/** Java MainApplication (React Native < 0.73). */
function patchMainApplicationJava(contents) {
    // Add import
    contents = contents.replace(
      "import com.facebook.react.ReactApplication",
      "import com.facebook.react.ReactApplication;\nimport io.yaver.feedback.YaverHotReloadPackage;\nimport io.yaver.feedback.YaverHotReloadModule;"
    );

    // Register package in getPackages()
    if (contents.includes("packages.add(")) {
      // Find the last packages.add() and add ours after
      const lastAdd = contents.lastIndexOf("packages.add(");
      const lineEnd = contents.indexOf("\n", lastAdd);
      contents =
        contents.slice(0, lineEnd + 1) +
        "      packages.add(new YaverHotReloadPackage());\n" +
        contents.slice(lineEnd + 1);
    }

    // Override getJSBundleFile to check for hot bundle
    if (contents.includes("getJSMainModuleName()") && !contents.includes("getJSBundleFile")) {
      const mainModuleIdx = contents.indexOf("getJSMainModuleName()");
      const methodStart = contents.lastIndexOf("@Override", mainModuleIdx);
      contents =
        contents.slice(0, methodStart) +
        `@Override
    protected String getJSBundleFile() {
      // Yaver Feedback SDK: load hot-reloaded bundle if available
      java.io.File hotBundle = YaverHotReloadModule.getSavedBundleFile(getApplicationContext());
      if (hotBundle != null) return hotBundle.getAbsolutePath();
      return super.getJSBundleFile();
    }

    ` +
        contents.slice(methodStart);
    }

    // Crash-revert safety net: clear the boot-attempt counter once
    // the React context initializes (bundle loaded successfully), AND
    // via a 10-s fallback Handler in case that listener never fires
    // (e.g. infinite loop in root component). If neither fires,
    // YaverHotReloadModule.getSavedBundleFile() reverts to the
    // APK-bundled bundle after 3 failed cold starts. Parity with
    // YaverHotReload.swift on iOS.
    if (contents.includes("onCreate()") && !contents.includes("yaverHotReloadBootListener")) {
      const onCreateIdx = contents.indexOf("onCreate()");
      const braceIdx = contents.indexOf("{", onCreateIdx);
      const insertionPoint = braceIdx + 1;
      const bootGuard = `
    // Yaver Feedback SDK hot-reload crash-revert safety net
    final android.content.Context yaverHotReloadCtx = getApplicationContext();
    new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
        new Runnable() {
          @Override public void run() {
            io.yaver.feedback.YaverHotReloadModule.markBootSuccessful(yaverHotReloadCtx);
          }
        },
        10000
    );
    try {
      com.facebook.react.ReactInstanceManager yaverRim = getReactNativeHost().getReactInstanceManager();
      yaverRim.addReactInstanceEventListener(new com.facebook.react.ReactInstanceEventListener() {
        @Override public void onReactContextInitialized(com.facebook.react.bridge.ReactContext ctx) {
          io.yaver.feedback.YaverHotReloadModule.markBootSuccessful(yaverHotReloadCtx);
        }
      });
    } catch (Throwable yaverHotReloadBootListener) {
      // Older/newer RN versions may not expose ReactInstanceEventListener
      // exactly like this; the 10-s fallback above still covers us.
    }
`;
      contents =
        contents.slice(0, insertionPoint) + bootGuard + contents.slice(insertionPoint);
    }

  return contents;
}

function withYaverFeedback(config, props) {
  config = withYaverFeedbackIOS(config);
  config = withYaverFeedbackAndroid(config);

  // Hot reload native module is ON by default — it's the SDK's whole
  // point. TestFlight / Play Store standalone builds have no Metro
  // dev server, so without the YaverHotReload native module the
  // agent's `reload_bundle` broadcast silently no-ops: the SDK falls
  // through to DevSettings.reload() which does nothing in Release
  // builds. Apps that specifically don't want the plugin mutating
  // their AppDelegate / MainApplication can opt out with
  //   ["yaver-feedback-react-native", { "enableHotReload": false }]
  const enableHotReload = props?.enableHotReload !== false;
  if (enableHotReload) {
    config = withYaverHotReloadNativeModule(config);
    config = withYaverAppDelegateHook(config);
    config = withYaverSceneDelegateShortcut(config);
    config = withYaverAndroidHotReload(config);
  }

  return config;
}

const yaverFeedbackPlugin = createRunOncePlugin(
  withYaverFeedback,
  pkg.name,
  pkg.version
);

// Pure transforms are exposed for contract tests only. Keeping the test at the
// config-plugin seam catches template drift before a consumer discovers it in
// an archive build.
yaverFeedbackPlugin.__test = {
  patchHotReloadBootConfirmation,
  patchHotReloadRestore,
  patchDogfoodAppShortcut,
  patchDogfoodSceneDelegate,
  findAppDelegateClassClose,
  findWindowSceneDelegateClassClose,
};
module.exports = yaverFeedbackPlugin;
