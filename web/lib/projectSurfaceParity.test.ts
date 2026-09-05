import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(webRoot, "..");
const projectsView = readFileSync(join(webRoot, "components/dashboard/ProjectsView.tsx"), "utf8");
const dashboard = readFileSync(join(webRoot, "app/dashboard/page.tsx"), "utf8");
const mobileProjects = readFileSync(join(repoRoot, "mobile/app/(tabs)/apps.tsx"), "utf8");
const desktopMain = readFileSync(join(repoRoot, "electron/src/main.js"), "utf8");
const desktopAgentManager = readFileSync(join(repoRoot, "electron/src/agent-manager.js"), "utf8");
const repoProducer = readFileSync(join(repoRoot, "desktop/agent/repos_http.go"), "utf8");
const gitLock = readFileSync(join(repoRoot, "desktop/agent/git_operation_lock.go"), "utf8");
const gitView = readFileSync(join(webRoot, "components/dashboard/GitView.tsx"), "utf8");

// Desktop GUI intentionally renders the real web dashboard, so this one
// ProjectsView is the executable project-picker contract for both surfaces.
assert.match(desktopMain, /DASHBOARD_PRODUCTION_URL = "https:\/\/yaver\.io\/dashboard"/);
assert.match(projectsView, /from "@\/lib\/projectInventory"/);
assert.match(
  dashboard,
  /<ProjectsView client=\{projectSurfaceClient\} key=\{connectedDevice!\.id\} connectedDeviceId=\{connectedDevice!\.id\}/,
  "Desktop/Web Projects must be explicitly bound to the selected agent",
);
assert.match(projectsView, /\[client, connectedDeviceId, connectionState\]/);
assert.match(projectsView, /client\.on\("connectionState", setConnectionState\)/);
assert.match(gitView, /client\.on\("connectionState", setConnectionState\)/);
assert.match(projectsView, /loadGenerationRef\.current/);
assert.match(projectsView, /client\.connectedDeviceId !== expectedDeviceId/);
assert.match(dashboard, /agentClientPool\.peek\(connectedDevice\.id\)/);
assert.match(dashboard, /deviceConnectQueueRef\.current[\s\S]*\.then\(\(\) => connectToDeviceNow\(device\)\)/);
assert.match(dashboard, /isThisDesktopDevice\(device\.id, desktopSurface\)/);
assert.match(dashboard, /connectionHost = localDesktopTarget \? "127\.0\.0\.1" : device\.host/);

// Mobile already had the desired behavior: select the active device's pooled
// client and tear down/restart the project poll whenever that device changes.
assert.match(mobileProjects, /const deviceId = activeDevice\?\.id;/);
assert.match(mobileProjects, /connectionManager\.clientFor\(deviceId\)/);
assert.match(mobileProjects, /activeDevice\?\.id\]\);/);

// The producer identifies repository roots from .git and rejects the runtime-
// resolved HOME itself. No surface is allowed to invent a project from a
// username, a conventional checkout directory, or the daemon's CWD.
assert.match(repoProducer, /func isGitRepositoryRoot\(path string\) bool/);
assert.match(repoProducer, /os\.Stat\(filepath\.Join\(path, "\.git"\)\)/);
assert.match(repoProducer, /home, _ := os\.UserHomeDir\(\)/);
assert.match(repoProducer, /!sameRuntimePath\(wd, home\)/);

// Source control is a first-class dashboard surface, but its repo actions stay
// on the selected device's stable client. The Go agent serializes a full
// mutation transaction by the nearest runtime-discovered .git marker.
assert.match(dashboard, /\{ id: "git", label: "Source"/);
assert.match(dashboard, /<GitView[\s\S]*client=\{projectSurfaceClient\}[\s\S]*connectedDeviceId=\{connectedDevice!\.id\}/);
assert.match(gitView, /client\.gitCommitPush\(/);
assert.match(gitView, /client\.gitPull\(/);
assert.match(gitView, /client\.gitPush\(/);
assert.match(gitLock, /filepath\.Join\(candidate, "\.git"\)/);
assert.match(gitLock, /\*sync\.RWMutex/);

// Desktop may supervise its own Go agent or coexist with a standalone one.
// Startup is single-flight, healthy external agents are adopted, and only an
// owned child is ever stopped/restarted.
assert.match(desktopAgentManager, /if \(this\.startPromise\) return this\.startPromise/);
assert.match(desktopAgentManager, /return \{ ok: false, error: "This agent is managed by an external service/);

console.log("desktop, web, mobile project-surface parity checks passed");
