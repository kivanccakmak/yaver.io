import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tasks = readFileSync(join(mobileRoot, "app/(tabs)/tasks.tsx"), "utf8");
const boxPicker = readFileSync(join(mobileRoot, "src/components/RemoteBoxPickerModal.tsx"), "utf8");
const inlinePicker = readFileSync(join(mobileRoot, "src/components/NoMachineEmpty.tsx"), "utf8");
const deviceContext = readFileSync(join(mobileRoot, "src/context/DeviceContext.tsx"), "utf8");

assert.match(tasks, /accessibilityLabel="Coding agent choices"/,
  "the composer must render a browser-tappable runner chooser");
assert.match(tasks, /setShowComposerRunnerChoices\(\(shown\) => !shown\)/,
  "the coding-agent chip must open the in-app chooser");
assert.match(tasks, /Use \$\{displayRunnerLabel\(runnerId\)\} on \$\{runnerSelectionDevice\?\.name/,
  "each choice must name the machine that will run it");
assert.match(tasks, /accessibilityLabel="Tasks banner coding agent choices"/,
  "Tasks overview must switch runners without opening a task or composer");
assert.match(tasks, /add\(runnerSelectionDeviceId, "explicit"\);[\s\S]{0,120}add\(machineRoles\?\.runnerDeviceId, "primary"\);/,
  "the visible Tasks box must dispatch before any hidden legacy runner role");
assert.match(tasks, /setShowBannerRunnerChoices\(\(shown\) => !shown\)/,
  "the existing runner status line must open the overview chooser");
assert.match(boxPicker, /setMachineRolesFavorite\(\{[\s\S]{0,160}runnerDeviceId: target\.id,[\s\S]{0,80}renderDeviceId: target\.id/,
  "choosing a remote box must route work to that box, not only focus it");
assert.match(inlinePicker, /setMachineRolesFavorite\(\{ runnerDeviceId: deviceId, renderDeviceId: deviceId \}\)/,
  "the inline no-machine picker must update execution roles as well as focus");
assert.match(deviceContext, /setMachineRolesState\(row\);[\s\S]{0,450}const persistence = saveUserSettings[\s\S]{0,500}setTimeout\(resolve, 5000\)/,
  "machine switching must apply locally before bounded roaming persistence");
assert.match(tasks, /const tmuxRunnerClient = useCallback\([\s\S]{0,260}connectionManager\.clientFor\(runnerSelectionDeviceId\)/,
  "tmux discovery and adoption must target the machine visible in Tasks");
assert.match(tasks, /const runnerClient = tmuxRunnerClient\(\);[\s\S]{0,180}runnerClient\.adoptTmuxSession/,
  "tmux adoption must reuse the explicitly scoped inventory client");
assert.match(tasks, /legacyAdoptedTaskId[\s\S]{0,500}setSelectedTask\(existingTask\)/,
  "legacy agents that adopted despite an error must route to the existing task");
assert.match(tasks, /const command = adoptedRunnerControlCommand\(selectedTask\.runnerId\)/,
  "an adopted runner chip must resolve its native interactive command");
assert.match(tasks, /client\.sendTmuxInput\(selectedTask\.id, command\)/,
  "an adopted Codex runner chip must open the live /model chooser");

console.log("Task runner picker contract ok");
