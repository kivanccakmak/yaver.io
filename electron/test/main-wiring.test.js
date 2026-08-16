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
