"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const main = readFileSync(join(__dirname, "..", "src", "main.js"), "utf8");
const preload = readFileSync(join(__dirname, "..", "src", "preload.js"), "utf8");

test("ready lifecycle starts the embedded agent and availability policy", () => {
  const ready = main.slice(main.indexOf("app.whenReady()"), main.indexOf("app.on(\"before-quit\""));
  assert.match(ready, /reconcileKeepAwake\(\)/);
  assert.match(ready, /reconcileLaunchAtLogin\(\)/);
  assert.match(ready, /if \(!storeClientOnly\) startEmbeddedAgent\(\)/);
  assert.match(ready, /setMacDockIcon\(\)/);
  assert.match(ready, /reconcileAutomaticUpdates\(\)/);
});

test("Mac App Store build is an honest sandboxed client, never a local agent", () => {
  assert.match(main, /const storeClientOnly = process\.mas === true/);
  assert.match(main, /storeClientOnly \? "client-only" : "starting"/);
  assert.match(main, /distribution: storeClientOnly \? "mac-app-store" : "direct"/);
  assert.match(main, /port: storeClientOnly \? null : 18080/);
});

test("automation cannot weaken packaged keychain storage", () => {
  assert.match(main, /!app\.isPackaged && process\.env\.YAVER_ELECTRON_AUTOMATION === "1"/);
  assert.match(main, /appendSwitch\("use-mock-keychain"\)/);
  assert.match(main, /path\.isAbsolute\(isolatedUserData\)/);
});

test("desktop keeps the native rounded operating-system frame", () => {
  const windowOptions = main.slice(main.indexOf("mainWindow = new BrowserWindow"), main.indexOf("webPreferences:"));
  assert.match(windowOptions, /frame:\s*true/);
  assert.match(windowOptions, /hasShadow:\s*true/);
  assert.match(windowOptions, /roundedCorners:\s*true/);
  assert.match(windowOptions, /titleBarStyle:\s*"default"/);
  assert.match(windowOptions, /titleBarSeparatorStyle:\s*"line"/);
  assert.match(windowOptions, /thickFrame:\s*true/);
});

test("quit lifecycle releases power and stops only the child we supervise", () => {
  const quit = main.slice(main.indexOf("app.on(\"before-quit\""));
  assert.match(quit, /stopKeepAwake\(\)/);
  assert.match(quit, /agentManager\.stop\(\)/);
});

test("renderer bridge exposes structured task and agent lifecycle seams", () => {
  assert.match(preload, /taskStatus\(payload\)/);
  assert.match(preload, /getDesktopStatus\(\)/);
  assert.match(preload, /onAgentStatus\(listener\)/);
  assert.match(preload, /setAutomaticUpdates\(enabled\)/);
  assert.match(preload, /checkForUpdates\(\)/);
  assert.match(preload, /onUpdateStatus\(listener\)/);
});

test("direct updater is signed-release, architecture-aware, and excluded from MAS", () => {
  assert.match(main, /if \(storeClientOnly \|\| !app\.isPackaged\) return false/);
  assert.match(main, /require\("electron-updater"\)/);
  assert.match(main, /autoUpdater\.channel = `latest-\$\{process\.arch\}`/);
  assert.match(main, /process\.platform === "linux" && !process\.env\.APPIMAGE/);
  assert.match(main, /settings\.automaticUpdates = Boolean\(enabled\)/);
});

test("live interceptor strips URLs in onBeforeRequest and only injects headers later", () => {
  const interceptor = main.slice(main.indexOf("function installAuthInterceptor"), main.indexOf("// Notifications"));
  assert.match(interceptor, /onBeforeRequest/);
  assert.match(interceptor, /redirectURL: stripped\.url/);
  assert.match(interceptor, /onBeforeSendHeaders/);
  assert.ok(
    interceptor.indexOf("redirectURL: stripped.url") < interceptor.indexOf("ses.webRequest.onBeforeSendHeaders"),
    "URL redirect must happen before the header-only phase",
  );
  assert.equal((interceptor.match(/redirectURL/g) || []).length, 1);
  assert.match(interceptor, /setPermissionRequestHandler/);
  assert.match(interceptor, /clipboard-sanitized-write/);
  assert.match(interceptor, /fullscreen/);
  assert.match(interceptor, /APP_ORIGINS\.has/);
});

test("preload bridge is absent on third-party OAuth provider pages", () => {
  assert.match(preload, /yaver:is-trusted-renderer-origin/);
  assert.match(preload, /if \(trustedRenderer\) contextBridge\.exposeInMainWorld/);
  assert.match(main, /senderOrigin === claimedOrigin && APP_ORIGINS\.has\(senderOrigin\)/);
});

test("renderer failures become visible and recoverable instead of a black window", () => {
  assert.match(main, /renderer_load_failed/);
  assert.match(main, /renderer_process_gone/);
  assert.match(main, /showRendererFailure\(lastRendererFailure\)/);
  assert.match(main, /Yaver could not open the dashboard/);
  assert.match(main, /location\.reload\(\)/);
  assert.match(main, /Open in browser/);
});

test("tray navigation has a safe fallback when the current page URL is empty or non-HTTP", () => {
  assert.match(main, /function dashboardUrlForTab\(tab\)/);
  assert.match(main, /tray_navigation_fallback/);
  assert.match(main, /DASHBOARD_PRODUCTION_URL\}\?tab=/);
  assert.doesNotMatch(main, /const origin = new URL\(mainWindow\.webContents\.getURL\(\)\)\.origin/);
});

test("recovery page strips auth params from the browser-bound URL (M3)", () => {
  const recovery = main.slice(main.indexOf("function showRendererFailure"), main.indexOf("function trayIcon"));
  // The failing URL is stripped before it is embedded into the recovery HTML.
  assert.match(recovery, /stripAuthFromUrl\(failure\.url\)/);
  const safeUrlIdx = recovery.indexOf("const safeUrl = JSON.stringify(browserUrl)");
  assert.ok(
    recovery.indexOf("stripAuthFromUrl(failure.url)") < safeUrlIdx,
    "browserUrl must be stripped before safeUrl is built",
  );
});

test("external navigation never opens a token-bearing URL (M3)", () => {
  const lock = main.slice(main.indexOf("const enforceNavigationLock"), main.indexOf("// Top-level navigations"));
  assert.match(lock, /stripAuthFromUrl\(target\)\.url/);
  assert.match(lock, /shell\.openExternal\(externalUrl\)/);
  assert.doesNotMatch(lock, /shell\.openExternal\(target\)/);
});

test("GUI_FAILURE_FIXTURE makes load and crash failures deterministic (DP9)", () => {
  assert.match(main, /GUI_FAILURE_FIXTURE \|\| ""\)\.trim\(\)/);
  const url = main.slice(main.indexOf("async function resolveDashboardUrl"), main.indexOf("// Auth capture"));
  assert.match(url, /guifailure\.invalid/);
  const windowCreate = main.slice(main.indexOf("async function createWindow"), main.indexOf("function showRendererFailure"));
  assert.match(windowCreate, /forcefullyCrashRenderer\(\)/);
  assert.match(main, /rendererRecoveryAttempts < 1/);
});
