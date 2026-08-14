const { withInfoPlist, withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const POD_LINE = "  # Local STT/TTS native bridge for tvOS\n  pod 'YaverSpeech', :path => '../local-pods/YaverSpeech'\n";

/** Adds the YaverSpeech native pod + mic/speech usage descriptions for tvOS. */
module.exports = function withTvSpeech(config) {
  config = withInfoPlist(config, (config) => {
    config.modResults.NSMicrophoneUsageDescription =
      "Yaver uses the microphone so you can speak tasks and instructions to your AI agent on Apple TV.";
    config.modResults.NSSpeechRecognitionUsageDescription =
      "Yaver uses speech recognition to transcribe what you say into tasks for your AI agent.";
    return config;
  });

  config = withDangerousMod(config, ["ios", async (config) => {
    const podfile = path.join(config.modRequest.platformProjectRoot, "Podfile");
    if (!fs.existsSync(podfile)) return config;
    let src = fs.readFileSync(podfile, "utf8");
    if (!src.includes("YaverSpeech")) {
      if (src.includes("use_native_modules!(config_command)")) {
        src = src.replace(
          "use_native_modules!(config_command)",
          "use_native_modules!(config_command)\n" + POD_LINE
        );
      } else if (src.includes("use_react_native!")) {
        src = src.replace("use_react_native!", POD_LINE + "  use_react_native!");
      }
      fs.writeFileSync(podfile, src);
    }
    return config;
  }]);

  return config;
};
