const { withInfoPlist, withDangerousMod, withAndroidManifest } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const POD_LINE = "  # Local STT/TTS native bridge for tvOS\n  pod 'YaverSpeech', :path => '../local-pods/YaverSpeech'\n";
const MODULE_SRC = path.join(__dirname, "../local-pods/YaverSpeech/android/YaverSpeechModule.kt");
const PACKAGE_SRC = path.join(__dirname, "../local-pods/YaverSpeech/android/YaverSpeechPackage.kt");

/** Adds YaverSpeech (STT/TTS) to iOS/tvOS (pod + permissions) and Android (Kotlin module). */
module.exports = function withTvSpeech(config) {
  // iOS / tvOS: mic + speech usage descriptions
  config = withInfoPlist(config, (config) => {
    config.modResults.NSMicrophoneUsageDescription =
      "Yaver uses the microphone so you can speak tasks and instructions to your AI agent on Apple TV.";
    config.modResults.NSSpeechRecognitionUsageDescription =
      "Yaver uses speech recognition to transcribe what you say into tasks for your AI agent.";
    return config;
  });

  // iOS / tvOS: add the YaverSpeech pod to the Podfile
  config = withDangerousMod(config, ["ios", async (config) => {
    const podfile = path.join(config.modRequest.platformProjectRoot, "Podfile");
    if (fs.existsSync(podfile)) {
      let src = fs.readFileSync(podfile, "utf8");
      if (!src.includes("YaverSpeech")) {
        if (src.includes("use_native_modules!(config_command)")) {
          src = src.replace("use_native_modules!(config_command)", "use_native_modules!(config_command)\n" + POD_LINE);
        } else if (src.includes("use_react_native!")) {
          src = src.replace("use_react_native!", POD_LINE + "  use_react_native!");
        }
        fs.writeFileSync(podfile, src);
      }
    }
    return config;
  }]);

  // Android: copy the Kotlin module + package, register it, add RECORD_AUDIO
  config = withDangerousMod(config, ["android", async (config) => {
    const appDir = config.modRequest.platformProjectRoot;
    const javaDir = path.join(appDir, "app/src/main/java/io/yaver/mobile");
    fs.mkdirSync(javaDir, { recursive: true });
    if (fs.existsSync(MODULE_SRC)) fs.copyFileSync(MODULE_SRC, path.join(javaDir, "YaverSpeechModule.kt"));
    if (fs.existsSync(PACKAGE_SRC)) fs.copyFileSync(PACKAGE_SRC, path.join(javaDir, "YaverSpeechPackage.kt"));

    // Register the package in MainApplication.kt
    const mainApp = path.join(javaDir, "MainApplication.kt");
    if (fs.existsSync(mainApp)) {
      let src = fs.readFileSync(mainApp, "utf8");
      if (!src.includes("YaverSpeechPackage")) {
        src = src.replace(
          "val packages = PackageList(this).packages",
          "val packages = PackageList(this).packages\n            packages.add(YaverSpeechPackage())"
        );
        fs.writeFileSync(mainApp, src);
      }
    }
    return config;
  }]);

  // Android: RECORD_AUDIO permission
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    if (manifest.manifest["uses-permission"]) {
      const has = manifest.manifest["uses-permission"].some(
        (p) => p.$["android:name"] === "android.permission.RECORD_AUDIO"
      );
      if (!has) {
        manifest.manifest["uses-permission"].push({
          $: { "android:name": "android.permission.RECORD_AUDIO" },
        });
      }
    }
    return config;
  });

  return config;
};
