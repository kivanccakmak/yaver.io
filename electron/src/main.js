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

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, session, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { APP_ORIGINS, isAllowedAppUrl, inPageNavigationDecision } = require("./navigation-policy");
const { AgentManager } = require("./agent-manager");

const DASHBOARD_PRODUCTION_URL = "https://yaver.io/dashboard";
const DEV_SERVER_URL = "http://localhost:3000";

let mainWindow = null;
let tray = null;
let isQuitting = false;
/** Embedded yaver Go agent supervisor — makes this desktop a yaver node. */
let agentManager = null;
let agentStatus = "starting";

/** Captured auth material, per origin: { token, relayPassword }.
 *  Persisted for the process lifetime only (never written to disk). */
const authByOrigin = new Map();

// ---------------------------------------------------------------------------
// Settings (persisted to userData; never secrets)
// ---------------------------------------------------------------------------

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return { taskNotifications: true };
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("[yaver-gui] could not persist settings:", err.message);
  }
}

let settings = loadSettings();

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

function stripAuthFromUrl(urlString) {
  const u = new URL(urlString);
  const token = u.searchParams.get("token");
  const rp = u.searchParams.get("__rp");
  if (token || rp) {
    if (token) u.searchParams.delete("token");
    if (rp) u.searchParams.delete("__rp");
    return { url: u.toString(), token, rp };
  }
  return { url: urlString, token: null, rp: null };
}

function installAuthInterceptor() {
  const ses = session.defaultSession;

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    let url = details.url;
    let token = null;
    let rp = null;
    try {
      const stripped = stripAuthFromUrl(url);
      url = stripped.url;
      token = stripped.token;
      rp = stripped.rp;
    } catch {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }

    const headers = { ...details.requestHeaders };
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return null;
      }
    })();

    // Capture auth material seen in URLs (EventSource can't set headers, so
    // the web app passes them as query params). Remember it per-origin so
    // follow-up stream requests to the same agent get the header too.
    if (origin) {
      const entry = authByOrigin.get(origin) || {};
      if (token) entry.token = token;
      if (rp) entry.rp = rp;
      authByOrigin.set(origin, entry);
    }

    // Inject as headers whenever we know the material for this origin.
    const known = origin ? authByOrigin.get(origin) : null;
    if (known && known.token && !headers["Authorization"]) {
      headers["Authorization"] = `Bearer ${known.token}`;
    }
    if (known && known.rp && !headers["X-Relay-Password"]) {
      headers["X-Relay-Password"] = known.rp;
    }

    // Never let a stray token reach the network in a URL.
    if (url !== details.url) {
      callback({
        requestHeaders: headers,
        // redirects to the stripped URL so the address bar / proxy logs never
        // see the secret even if the renderer held onto the original string.
        url,
      });
      return;
    }
    callback({ requestHeaders: headers });
  });
}

// ---------------------------------------------------------------------------
// Notifications (task completion, from preload observer)
// ---------------------------------------------------------------------------

function sendTaskNotification(kind, title) {
  if (!settings.taskNotifications) return;
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
  const { kind, title } = payload || {};
  if (typeof kind !== "string") return;
  sendTaskNotification(kind, typeof title === "string" ? title : "");
});

ipcMain.on("yaver:set-task-notifications", (_event, enabled) => {
  settings.taskNotifications = Boolean(enabled);
  saveSettings(settings);
  if (tray) rebuildTray();
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
  mainWindow.once("ready-to-show", () => mainWindow.show());

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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle("Yaver");
    }
  });

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
    starting: "Agent · starting…",
    missing: "Agent · binary not found",
    crashed: "Agent · restarting…",
    stopped: "Agent · stopped",
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
    { type: "separator" },
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
      label: "Reload",
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
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
  agentManager = new AgentManager({
    onStatus: ({ state }) => {
      agentStatus = state;
      if (tray) rebuildTray();
    },
    onLog: (line) => console.log(line),
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
    installAuthInterceptor();
    createTray();
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
    isQuitting = true;
  });

  app.on("window-all-closed", () => {
    // Keep the tray alive on every platform; the user quits from the tray.
    if (isQuitting) app.quit();
  });
}
