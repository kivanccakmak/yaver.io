"use strict";

/**
 * Yaver GUI — main process.
 *
 * A hardened desktop shell around the Yaver web dashboard. Design rules from
 * docs/audits/webui-chat-vibing-gui-2026-08-12.md:
 *
 *  1. The GUI is a shell, not a fork — it loads the real dashboard
 *     (https://yaver.io/dashboard, localhost:3000 in dev) so chat + vibing
 *     always match the deployed web app.
 *  2. Fixes the web-only "token in SSE URL" finding in the shell, where
 *     EventSource cannot be fixed: intercept requests, strip ?token=/?__rp=
 *     from stream URLs, re-inject as Authorization / X-Relay-Password
 *     headers (the agent's CORS allowlist already accepts both — see
 *     desktop/agent/httpserver.go:3231).
 *  3. Hardened window: contextIsolation, sandbox, nodeIntegration off,
 *     navigation allowlist, external links to the system browser.
 *  4. Native value the web cannot provide: tray with task-notification
 *     toggle, yaver:// deep links, task-completion notifications, and a
 *     window that survives relay flapping.
 */

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, session, nativeImage, powerSaveBlocker } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { APP_ORIGINS, isAllowedAppUrl, inPageNavigationDecision } = require("./navigation-policy");
const { AgentManager } = require("./agent-manager");
const { normalizeSettings, isLoginItemSupported, linuxAutostartEntry } = require("./desktop-runtime-policy");
const { stripAuthFromUrl, applyKnownAuthHeaders } = require("./auth-interceptor");
const { DesktopLog } = require("./desktop-log");

const DASHBOARD_PRODUCTION_URL = "https://yaver.io/dashboard";
const DEV_SERVER_URL = "http://localhost:3000";
// A Mac App Store binary is obligatorily sandboxed. It can be the full Yaver
// client surface, but it cannot honestly promise the direct build's arbitrary
// repo access, CLI spawning, incoming agent listener, capture, or automation.
// Electron defines process.mas only in a MAS build. Keep that distribution
// client-only and leave the signed/notarized DMG as the full runner/renderer.
const storeClientOnly = process.mas === true;

// Chromium's secure-storage backend uses the macOS login keychain. An
// unpackaged Electron binary has Electron's development identity, not the
// stable signed Yaver identity, so repeated automated launches can trigger an
// OS keychain prompt that no headless driver can answer. Keep production on
// the OS-protected store; only unpackaged automation gets Chromium's mock
// keychain and an isolated profile. Packaged builds cannot opt into this path.
const automationMode = !app.isPackaged && process.env.YAVER_ELECTRON_AUTOMATION === "1";
if (automationMode) {
  app.commandLine.appendSwitch("use-mock-keychain");
  const isolatedUserData = process.env.YAVER_ELECTRON_USER_DATA_DIR;
  if (isolatedUserData && path.isAbsolute(isolatedUserData)) {
    app.setPath("userData", isolatedUserData);
  }
}

const desktopLog = new DesktopLog({ directory: path.join(app.getPath("userData"), "logs") });
desktopLog.write("info", "process_start", `version=${app.getVersion()} platform=${process.platform} arch=${process.arch} packaged=${app.isPackaged}`);
process.on("uncaughtExceptionMonitor", (error) => desktopLog.write("error", "uncaught_exception", error?.stack || error?.message || String(error)));
process.on("unhandledRejection", (reason) => desktopLog.write("error", "unhandled_rejection", reason?.stack || reason?.message || String(reason)));

let mainWindow = null;
let tray = null;
let isQuitting = false;
let launchHidden = process.argv.includes("--hidden");
/** Embedded yaver Go agent supervisor — makes this desktop a yaver node. */
let agentManager = null;
let agentStatus = storeClientOnly ? "client-only" : "starting";
let agentStatusDetail = storeClientOnly
  ? "Mac App Store sandbox: connect to a Yaver agent on this or another machine"
  : null;
let keepAwakeBlockerId = null;
let updateTimer = null;
let directAutoUpdater = null;
let updateStatus = storeClientOnly
  ? { state: "store-managed", detail: "Updates are managed by the Mac App Store" }
  : { state: "idle", detail: null };

/** Captured auth material, per origin: { token, relayPassword }.
 *  Persisted for the process lifetime only (never written to disk). */
const authByOrigin = new Map();

// Read only the non-secret device identity needed to label this exact node in
// the desktop shell. Never return or log the rest of config.json: it contains
// bearer/relay material. The Go agent uses the same runtime-resolved path.
function localAgentDeviceId() {
  try {
    const override = String(process.env.YAVER_CONFIG_DIR || "").trim();
    const configDir = override && path.isAbsolute(override)
      ? override
      : path.join(app.getPath("home"), ".yaver");
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
    return typeof parsed.device_id === "string" ? parsed.device_id.trim().slice(0, 200) : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Settings (persisted to userData; never secrets)
// ---------------------------------------------------------------------------

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath(), "utf8")));
  } catch {
    return normalizeSettings(null);
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("[yaver-gui] could not persist settings:", err.message);
    desktopLog.write("error", "settings_write_failed", err.message);
  }
}

let settings = loadSettings();

function publishUpdateStatus(state, detail = null) {
  updateStatus = { state, detail };
  if (tray) rebuildTray();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("yaver:update-status", updateStatus);
  }
}

function directUpdaterSupported() {
  if (storeClientOnly || !app.isPackaged) return false;
  // electron-updater performs in-place Linux updates for AppImage. deb/rpm
  // installations belong to the OS package manager and must not be silently
  // replaced with a second installation format.
  return process.platform !== "linux" || Boolean(process.env.APPIMAGE);
}

function ensureDirectUpdater() {
  if (!directUpdaterSupported()) return null;
  if (directAutoUpdater) return directAutoUpdater;
  // Lazy loading keeps MAS/TestFlight builds from initializing a direct
  // updater inside Apple's sandbox.
  const { autoUpdater } = require("electron-updater");
  directAutoUpdater = autoUpdater;
  autoUpdater.channel = `latest-${process.arch}`;
  autoUpdater.allowPrerelease = false;
  autoUpdater.autoDownload = settings.automaticUpdates;
  autoUpdater.autoInstallOnAppQuit = settings.automaticUpdates;
  autoUpdater.on("checking-for-update", () => publishUpdateStatus("checking", "Checking signed Yaver releases…"));
  autoUpdater.on("update-not-available", () => publishUpdateStatus("current", "Yaver is up to date"));
  autoUpdater.on("update-available", (info) => publishUpdateStatus("available", `Yaver ${info.version} is available`));
  autoUpdater.on("download-progress", (progress) => publishUpdateStatus("downloading", `Downloading ${Math.round(progress.percent || 0)}%`));
  autoUpdater.on("update-downloaded", (info) => {
    publishUpdateStatus("ready", `Yaver ${info.version} will install when the app quits`);
    if (Notification.isSupported()) {
      const notice = new Notification({
        title: "Yaver update ready",
        body: `Version ${info.version} will install when Yaver quits.`,
        icon: path.join(__dirname, "..", "assets", "icon.png"),
      });
      notice.on("click", () => {
        isQuitting = true;
        autoUpdater.quitAndInstall(false, true);
      });
      notice.show();
    }
  });
  autoUpdater.on("error", (err) => {
    desktopLog.write("error", "updater_failed", err?.message || "Update check failed");
    publishUpdateStatus("error", err?.message || "Update check failed");
  });
  return autoUpdater;
}

async function checkForDesktopUpdate({ manual = false } = {}) {
  if (storeClientOnly) {
    publishUpdateStatus("store-managed", "Updates are managed by the Mac App Store");
    return updateStatus;
  }
  if (!app.isPackaged) {
    publishUpdateStatus("development", "Updates are disabled for unpackaged development builds");
    return updateStatus;
  }
  if (process.platform === "linux" && !process.env.APPIMAGE) {
    publishUpdateStatus("package-manager", "Update this deb/rpm install with your Linux package manager");
    return updateStatus;
  }
  const updater = ensureDirectUpdater();
  if (!updater) return updateStatus;
  // A manual click is explicit permission for this one download even when
  // background updates are disabled.
  updater.autoDownload = manual || settings.automaticUpdates;
  updater.autoInstallOnAppQuit = manual || settings.automaticUpdates;
  try {
    await updater.checkForUpdates();
  } catch (err) {
    publishUpdateStatus("error", err?.message || "Update check failed");
  }
  return updateStatus;
}

function reconcileAutomaticUpdates() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = null;
  if (storeClientOnly) {
    publishUpdateStatus("store-managed", "Updates are managed by the Mac App Store");
    return;
  }
  if (!settings.automaticUpdates) {
    if (directAutoUpdater) {
      directAutoUpdater.autoDownload = false;
      directAutoUpdater.autoInstallOnAppQuit = false;
    }
    publishUpdateStatus("disabled", "Automatic updates are off");
    return;
  }
  void checkForDesktopUpdate();
  updateTimer = setInterval(() => void checkForDesktopUpdate(), 6 * 60 * 60 * 1000);
  updateTimer.unref?.();
}

/** Keep the GUI/agent available without changing a global Windows power plan.
 * Electron's blocker is process-scoped and automatically disappears on crash
 * or quit; the tray checkbox gives the user an immediate opt-out. */
function reconcileKeepAwake() {
  if (settings.keepAwake) {
    if (keepAwakeBlockerId === null || !powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
      keepAwakeBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    }
    return;
  }
  if (keepAwakeBlockerId !== null && powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
    powerSaveBlocker.stop(keepAwakeBlockerId);
  }
  keepAwakeBlockerId = null;
}

function stopKeepAwake() {
  if (keepAwakeBlockerId !== null && powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
    powerSaveBlocker.stop(keepAwakeBlockerId);
  }
  keepAwakeBlockerId = null;
}

function reconcileLaunchAtLogin() {
  if (!isLoginItemSupported()) return;
  try {
    if (process.platform === "linux") {
      const autostartDir = path.join(app.getPath("home"), ".config", "autostart");
      const autostartFile = path.join(autostartDir, "io.yaver.gui.desktop");
      if (!settings.launchAtLogin) {
        fs.rmSync(autostartFile, { force: true });
        return;
      }
      fs.mkdirSync(autostartDir, { recursive: true });
      // AppImage mounts under a transient /tmp path; APPIMAGE points back to
      // the stable user-installed file. deb/rpm installs use process.execPath.
      const executable = process.env.APPIMAGE || process.execPath;
      fs.writeFileSync(autostartFile, linuxAutostartEntry(executable), { mode: 0o600 });
      return;
    }
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      // Windows should start as a tray node, not steal focus at sign-in.
      args: process.platform === "win32" ? ["--hidden"] : [],
      ...(process.platform === "darwin" ? { openAsHidden: true } : {}),
    });
  } catch (err) {
    desktopLog.write("error", "launch_at_login_failed", err.message);
    console.error("[yaver-gui] could not update start-at-login:", err.message);
  }
}

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

function envDashboardUrl() {
  const u = process.env.YAVER_DASHBOARD_URL;
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.toString();
  } catch {
    /* fall through to defaults */
  }
  return null;
}

/** Dev mode: localhost:3000 wins when it answers, so `yarn dev` in web/
 *  is picked up automatically (chat + vibing iterate fastest there). */
function probeDevServer(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(DEV_SERVER_URL + "/", { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function resolveDashboardUrl() {
  const explicit = envDashboardUrl();
  if (explicit) return explicit;
  if (process.env.YAVER_DEV === "1") {
    const up = await probeDevServer();
    return up ? DEV_SERVER_URL : DASHBOARD_PRODUCTION_URL;
  }
  return DASHBOARD_PRODUCTION_URL;
}

// ---------------------------------------------------------------------------
// Auth capture + header injection (the token-in-URL fix)
// ---------------------------------------------------------------------------

function installAuthInterceptor() {
  const ses = session.defaultSession;

  // URL mutation belongs to onBeforeRequest. onBeforeSendHeaders cannot
  // redirect; putting `url` in that callback's result is silently ignored by
  // Electron and would send the secret-bearing EventSource URL unchanged.
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      const stripped = stripAuthFromUrl(details.url);
      if (!stripped.token && !stripped.rp) {
        callback({});
        return;
      }
      const origin = new URL(stripped.url).origin;
      const entry = authByOrigin.get(origin) || {};
      if (stripped.token) entry.token = stripped.token;
      if (stripped.rp) entry.rp = stripped.rp;
      authByOrigin.set(origin, entry);
      callback({ redirectURL: stripped.url });
    } catch {
      callback({});
    }
  });

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({
      requestHeaders: applyKnownAuthHeaders({
        url: details.url,
        headers: details.requestHeaders,
        authByOrigin,
      }),
    });
  });

  // The remote dashboard is not allowed to turn this developer shell into a
  // camera/microphone/location/device-permission broker. Receiving WebRTC
  // video and using WebAuthn do not require these grants. Keep only sanitized
  // clipboard writes for the dashboard's explicit Copy buttons.
  const permissionAllowed = (permission, rawOrigin) => {
    if (permission !== "clipboard-sanitized-write" && permission !== "fullscreen") return false;
    try { return APP_ORIGINS.has(new URL(rawOrigin).origin); } catch { return false; }
  };
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => (
    permissionAllowed(permission, requestingOrigin)
  ));
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(permissionAllowed(permission, details?.requestingUrl || webContents.getURL()));
  });
}

// ---------------------------------------------------------------------------
// Notifications (task completion, from preload observer)
// ---------------------------------------------------------------------------

const sentTaskNotifications = new Map();

function sendTaskNotification(kind, title, taskId = "") {
  if (!settings.taskNotifications) return;
  const now = Date.now();
  const key = `${kind}:${taskId || title}`;
  const previous = sentTaskNotifications.get(key) || 0;
  if (now - previous < 45_000) return;
  sentTaskNotifications.set(key, now);
  for (const [oldKey, at] of sentTaskNotifications) {
    if (now - at > 5 * 60_000) sentTaskNotifications.delete(oldKey);
  }
  if (Notification.isSupported()) {
    new Notification({
      title: kind === "completed" ? "Task completed" : `Task ${kind}`,
      body: title || "Yaver finished working.",
      icon: path.join(__dirname, "..", "assets", "icon.png"),
      silent: false,
    }).show();
  }
}

ipcMain.on("yaver:task-status", (_event, payload) => {
  const { kind, title, taskId } = payload || {};
  if (typeof kind !== "string") return;
  sendTaskNotification(
    kind,
    typeof title === "string" ? title.slice(0, 240) : "",
    typeof taskId === "string" ? taskId.slice(0, 160) : "",
  );
});

ipcMain.on("yaver:set-task-notifications", (_event, enabled) => {
  settings.taskNotifications = Boolean(enabled);
  saveSettings(settings);
  if (tray) rebuildTray();
});

ipcMain.on("yaver:set-keep-awake", (_event, enabled) => {
  settings.keepAwake = Boolean(enabled);
  saveSettings(settings);
  reconcileKeepAwake();
  if (tray) rebuildTray();
});

ipcMain.on("yaver:set-launch-at-login", (_event, enabled) => {
  settings.launchAtLogin = Boolean(enabled);
  saveSettings(settings);
  reconcileLaunchAtLogin();
  if (tray) rebuildTray();
});

ipcMain.handle("yaver:set-automatic-updates", (_event, enabled) => {
  if (storeClientOnly) return { enabled: true, managedByStore: true, ...updateStatus };
  settings.automaticUpdates = Boolean(enabled);
  saveSettings(settings);
  reconcileAutomaticUpdates();
  return { enabled: settings.automaticUpdates, managedByStore: false, ...updateStatus };
});

ipcMain.handle("yaver:check-for-updates", () => checkForDesktopUpdate({ manual: true }));

ipcMain.handle("yaver:open-diagnostic-logs", () => {
  desktopLog.flush();
  shell.showItemInFolder(desktopLog.filePath);
  return { ok: true };
});

ipcMain.handle("yaver:get-desktop-status", () => ({
  surface: "desktop-gui",
  localDeviceId: localAgentDeviceId() || null,
  appVersion: app.getVersion(),
  distribution: storeClientOnly ? "mac-app-store" : "direct",
  agent: { state: agentStatus, detail: agentStatusDetail, port: storeClientOnly ? null : 18080 },
  keepAwake: settings.keepAwake,
  launchAtLogin: settings.launchAtLogin,
  loginItemSupported: isLoginItemSupported(),
  updates: {
    enabled: storeClientOnly ? true : settings.automaticUpdates,
    managedByStore: storeClientOnly,
    ...updateStatus,
  },
  logs: { path: desktopLog.filePath, maxBytes: desktopLog.maxBytes, maxFiles: desktopLog.maxFiles },
}));

ipcMain.on("yaver:get-app-version", (event) => {
  event.returnValue = app.getVersion();
});

ipcMain.on("yaver:is-trusted-renderer-origin", (event, claimedOrigin) => {
  try {
    const senderOrigin = new URL(event.senderFrame.url).origin;
    event.returnValue = senderOrigin === claimedOrigin && APP_ORIGINS.has(senderOrigin);
  } catch {
    event.returnValue = false;
  }
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

async function createWindow() {
  const url = await resolveDashboardUrl();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: "#0a0a0c",
    title: "Yaver",
    // Keep the real operating-system frame. A frameless web rectangle loses
    // macOS' rounded outer corners, shadow, resize affordances and stable
    // traffic-light placement (and looks especially wrong beside Chrome or
    // Surfshark). The explicit options also stop a future title-bar styling
    // refactor from silently turning the desktop app into a square web shell.
    frame: true,
    hasShadow: true,
    roundedCorners: true,
    ...(process.platform === "darwin" ? {
      titleBarStyle: "default",
      titleBarSeparatorStyle: "line",
    } : {}),
    ...(process.platform === "win32" ? {
      thickFrame: true,
      backgroundMaterial: "mica",
    } : {}),
    // Window/taskbar icon on Windows + Linux (macOS uses the app bundle's
    // icns). Also the dock/taskbar image during the brief pre-paint window.
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // Keep the last good surface visible: hide until first paint, never flash
  // a blank window.
  mainWindow.once("ready-to-show", () => {
    if (!launchHidden) mainWindow.show();
  });

  // External links → system browser; anything else denied.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const parsed = new URL(target);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        // Keep in-window only the sign-in/app surface and the auth-provider
        // redirects; everything else is a browser tab.
        if (!isAllowedAppUrl(target)) shell.openExternal(target);
      }
    } catch {
      /* ignore malformed */
    }
    return { action: "deny" };
  });

  const enforceNavigationLock = (target) => {
    try {
      const parsed = new URL(target);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
      if (isAllowedAppUrl(target)) return;
      if (APP_ORIGINS.has(parsed.origin)) {
        // Marketing/docs/blog/pricing/… → the app's own auth gate, which
        // bounces an already-signed-in user straight to /dashboard. The GUI
        // is sign-in → app only; web-app surfaces never open in a browser.
        void mainWindow.loadURL(`${parsed.origin}/auth?return=/dashboard`);
        return;
      }
      shell.openExternal(target);
    } catch {
      /* malformed URL — leave the navigation prevented */
    }
  };

  // Top-level navigations (incl. server redirects during OAuth).
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (isAllowedAppUrl(target)) return;
    event.preventDefault();
    enforceNavigationLock(target);
  });
  mainWindow.webContents.on("will-redirect", (event, target) => {
    if (isAllowedAppUrl(target)) return;
    event.preventDefault();
    enforceNavigationLock(target);
  });
  // SPA soft-navigations (Next.js App Router pushState) land here — enforce
  // the same allowlist so an in-app link to /pricing or /docs can't open.
  // (The decision lives in navigation-policy.js and is unit-tested; the
  // historical wiring bug — a missing `isAllowedAppPath` import — silently
  // no-oped this guard and let marketing pages render in-window.)
  mainWindow.webContents.on("did-navigate-in-page", (_event, target) => {
    const decision = inPageNavigationDecision(target);
    if (decision.allow) return;
    if (decision.bounce) {
      void mainWindow.loadURL(decision.bounce);
    }
    // bounce:null → foreign origin, nothing to do in-window.
  });

  mainWindow.webContents.on("did-finish-load", () => {
    desktopLog.write("info", "renderer_loaded", mainWindow?.webContents.getURL() || "");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle("Yaver");
      mainWindow.webContents.send("yaver:agent-status", {
        state: agentStatus,
        detail: agentStatusDetail,
        port: storeClientOnly ? null : 18080,
      });
    }
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, validatedURL, isMainFrame) => {
    if (isMainFrame) desktopLog.write("error", "renderer_load_failed", `code=${code} ${description} ${validatedURL}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    desktopLog.write("error", "renderer_process_gone", JSON.stringify(details));
  });
  mainWindow.on("unresponsive", () => desktopLog.write("warn", "window_unresponsive"));

  mainWindow.on("close", (event) => {
    // Keep alive in the tray (except on real quit / macOS Cmd+Q).
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(url);
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function trayIcon() {
  const pngPath = path.join(__dirname, "..", "assets", "icon.png");
  let image = nativeImage.createFromPath(pngPath);
  if (image.isEmpty()) {
    image = nativeImage.createEmpty();
  }
  return image.resize({ width: 18, height: 18 });
}

function rebuildTray() {
  if (!tray) return;
  const agentLabel = {
    running: "Agent · running ✓",
    adopted: "Agent · running (external) ✓",
    pairing: "Agent · pair this PC",
    starting: "Agent · starting…",
    missing: "Agent · binary not found",
    crashed: "Agent · restarting…",
    stopped: "Agent · stopped",
    "client-only": "App Store client · connect to a Yaver node",
  }[agentStatus] || "Agent · " + agentStatus;
  const menu = Menu.buildFromTemplate([
    { label: "Show Yaver", click: showWindow },
    { label: agentLabel, enabled: false },
    {
      label: "Task notifications",
      type: "checkbox",
      checked: settings.taskNotifications,
      click: (item) => {
        settings.taskNotifications = item.checked;
        saveSettings(settings);
      },
    },
    ...(!storeClientOnly ? [{
      label: "Keep this PC available",
      type: "checkbox",
      checked: settings.keepAwake,
      click: (item) => {
        settings.keepAwake = item.checked;
        saveSettings(settings);
        reconcileKeepAwake();
        rebuildTray();
      },
    }] : []),
    ...(isLoginItemSupported() ? [{
      label: "Start Yaver at login",
      type: "checkbox",
      checked: settings.launchAtLogin,
      click: (item) => {
        settings.launchAtLogin = item.checked;
        saveSettings(settings);
        reconcileLaunchAtLogin();
        rebuildTray();
      },
    }] : []),
    ...(storeClientOnly ? [{
      label: "Updates · managed by App Store",
      enabled: false,
    }] : [{
      label: "Automatic updates",
      type: "checkbox",
      checked: settings.automaticUpdates,
      click: (item) => {
        settings.automaticUpdates = item.checked;
        saveSettings(settings);
        reconcileAutomaticUpdates();
        rebuildTray();
      },
    }, {
      label: updateStatus.state === "checking" ? "Checking for updates…" : "Check for updates…",
      enabled: updateStatus.state !== "checking",
      click: () => void checkForDesktopUpdate({ manual: true }),
    }]),
    { type: "separator" },
    {
      label: "Tasks",
      click: () => {
        showWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          const origin = new URL(mainWindow.webContents.getURL()).origin;
          void mainWindow.loadURL(`${origin}/dashboard?tab=chat`);
        }
      },
    },
    {
      // Doctor / diagnose — the embedded agent serves /diagnose (+ stream,
      // /agent/doctor, /net/doctor, /mobile/hermes/doctor); the dashboard's
      // HealthView tab renders them. Deep-link to that tab.
      label: "Diagnose (doctor)",
      click: () => {
        showWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          const current = mainWindow.webContents.getURL();
          const sep = current.includes("?") ? "&" : "?";
          void mainWindow.loadURL(current + sep + "tab=health");
        }
      },
    },
    {
      // First-class opencode config — the dashboard's Settings tab renders
      // OpenCodeSettingsView (provider selection, API-key entry, model
      // pickers). Deep-link straight to it from the tray so the desktop
      // app's most-reached dev setting is one click, not a tab hunt.
      label: "OpenCode settings…",
      click: () => {
        showWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          const current = mainWindow.webContents.getURL();
          const sep = current.includes("?") ? "&" : "?";
          void mainWindow.loadURL(current + sep + "tab=settings");
        }
      },
    },
    {
      label: "Reload",
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
      },
    },
    {
      label: "Open diagnostic logs…",
      click: () => {
        desktopLog.flush();
        shell.showItemInFolder(desktopLog.filePath);
      },
    },
    { type: "separator" },
    { label: "Quit Yaver", click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Yaver — AI dev machine remote (${agentLabel})`);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.on("click", showWindow);
  rebuildTray();
}

/** BrowserWindow.icon is ignored by macOS. Set the Dock image explicitly so
 * an unpackaged/dev launch never presents itself as generic Electron; signed
 * packaged builds use the same canonical artwork from the app bundle. */
function setMacDockIcon() {
  if (process.platform !== "darwin" || !app.dock) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon.png"));
  if (!icon.isEmpty()) app.dock.setIcon(icon);
}

// ---------------------------------------------------------------------------
// Embedded yaver agent (this desktop IS a yaver node)
// ---------------------------------------------------------------------------

/**
 * Start the embedded agent supervisor. The desktop can be a remote box
 * (vibed from tvOS/mobile/web/another desktop over the same device routing)
 * and a client surface (the window vibes the local agent or any other
 * device). Healthy agents already running on :18080 are adopted, not
 * duplicated — matching `yaver serve`'s own reuse semantics.
 */
function startEmbeddedAgent() {
  if (agentManager) return;
  agentManager = new AgentManager({
    onStatus: ({ state, detail }) => {
      agentStatus = state;
      agentStatusDetail = detail || null;
      desktopLog.write(state === "crashed" || state === "missing" ? "error" : "info", "agent_status", `${state}${detail ? `: ${detail}` : ""}`);
      if (tray) rebuildTray();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("yaver:agent-status", { state, detail: agentStatusDetail, port: 18080 });
      }
    },
    onLog: (line) => desktopLog.write("info", "agent", line),
  });
  void agentManager.start();
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Deep links: yaver://dashboard?tab=chat | runtime | devices | projects | health
// ---------------------------------------------------------------------------

function handleDeepLink(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "yaver:") return;
    const target = u.host || "dashboard"; // yaver://dashboard?tab=chat
    if (target !== "dashboard") return;
    const tab = u.searchParams.get("tab");
    showWindow();
    if (!mainWindow) return;
    // Let the SPA settle, then deep-link via ?tab= (the dashboard already
    // reads ?tab= on load and syncs it on navigation — page.tsx:1218-1221).
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (tab) {
        const current = mainWindow.webContents.getURL();
        const sep = current.includes("?") ? "&" : "?";
        void mainWindow.webContents.executeJavaScript(
          `window.location.search = (window.location.search ? window.location.search + "&" : "?") + ${JSON.stringify(`tab=${encodeURIComponent(tab)}`)}; true`,
        ).catch(() => {
          void mainWindow.loadURL(current + sep + `tab=${encodeURIComponent(tab)}`);
        });
      }
    }, 900);
  } catch {
    /* malformed deep link — ignore */
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    showWindow();
    const link = argv.find((a) => a.startsWith("yaver://"));
    if (link) handleDeepLink(link);
  });

  app.setAsDefaultProtocolClient("yaver");

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.whenReady().then(async () => {
    desktopLog.write("info", "app_ready");
    if (process.platform === "darwin") {
      try { launchHidden = launchHidden || app.getLoginItemSettings().wasOpenedAtLogin === true; } catch { /* visible fallback */ }
    }
    installAuthInterceptor();
    setMacDockIcon();
    if (!storeClientOnly) reconcileKeepAwake();
    reconcileLaunchAtLogin();
    createTray();
    reconcileAutomaticUpdates();
    if (!storeClientOnly) startEmbeddedAgent();
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      } else {
        showWindow();
      }
    });
  });

  app.on("before-quit", () => {
    desktopLog.write("info", "before_quit");
    isQuitting = true;
    if (updateTimer) clearInterval(updateTimer);
    updateTimer = null;
    stopKeepAwake();
    if (agentManager) {
      void agentManager.stop();
      agentManager = null;
    }
  });

  app.on("child-process-gone", (_event, details) => {
    desktopLog.write("error", "child_process_gone", JSON.stringify(details));
  });

  app.on("will-quit", () => desktopLog.close());

  app.on("window-all-closed", () => {
    // Keep the tray alive on every platform; the user quits from the tray.
    if (isQuitting) app.quit();
  });
}
