// Keeps the finite phone-local coding/Git foreground service across
// `expo prebuild --clean`. The Kotlin implementation is force-tracked in
// SandboxService.kt; this plugin owns only the generated manifest contract.

const { AndroidConfig, withAndroidManifest } = require("@expo/config-plugins");

const SERVICE = "io.yaver.mobile.sandbox.RemotelessTaskService";
const PERMISSIONS = [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.WAKE_LOCK",
];

module.exports = function withRemotelessTasks(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest["uses-permission"] = manifest["uses-permission"] || [];
    for (const permission of PERMISSIONS) {
      const exists = manifest["uses-permission"].some(
        (entry) => entry.$?.["android:name"] === permission,
      );
      if (!exists) manifest["uses-permission"].push({ $: { "android:name": permission } });
    }

    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.service = app.service || [];
    const existing = app.service.find((entry) => entry.$?.["android:name"] === SERVICE);
    const attrs = {
      "android:name": SERVICE,
      "android:exported": "false",
      "android:foregroundServiceType": "dataSync",
    };
    if (existing) existing.$ = { ...existing.$, ...attrs };
    else app.service.push({ $: attrs });
    return cfg;
  });
};
