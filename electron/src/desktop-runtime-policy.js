"use strict";

/**
 * Non-secret desktop runtime settings shared by main-process wiring and tests.
 *
 * A GUI node is useful as a remote box only while the process remains alive.
 * These defaults therefore keep the machine awake and start Yaver at login,
 * while leaving both choices visible and reversible from the tray. We never
 * mutate the OS power plan and never require administrator privileges.
 */
const DEFAULT_SETTINGS = Object.freeze({
  taskNotifications: true,
  keepAwake: true,
  launchAtLogin: true,
  automaticUpdates: true,
});

function normalizeSettings(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    taskNotifications: typeof raw.taskNotifications === "boolean"
      ? raw.taskNotifications
      : DEFAULT_SETTINGS.taskNotifications,
    keepAwake: typeof raw.keepAwake === "boolean"
      ? raw.keepAwake
      : DEFAULT_SETTINGS.keepAwake,
    launchAtLogin: typeof raw.launchAtLogin === "boolean"
      ? raw.launchAtLogin
      : DEFAULT_SETTINGS.launchAtLogin,
    automaticUpdates: typeof raw.automaticUpdates === "boolean"
      ? raw.automaticUpdates
      : DEFAULT_SETTINGS.automaticUpdates,
  };
}

function isLoginItemSupported(platform = process.platform) {
  return platform === "win32" || platform === "darwin" || platform === "linux";
}

function linuxAutostartEntry(executable) {
  const escaped = String(executable || "").replace(/([\\"`$])/g, "\\$1");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Yaver",
    "Comment=Keep this computer available as a Yaver development node",
    `Exec=\"${escaped}\" --hidden`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

module.exports = { DEFAULT_SETTINGS, normalizeSettings, isLoginItemSupported, linuxAutostartEntry };
