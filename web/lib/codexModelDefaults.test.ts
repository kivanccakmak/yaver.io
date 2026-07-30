import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd());

function assert(condition: unknown, message: string) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${message}`);
  }
}

const devicesView = readFileSync(join(root, "components/dashboard/DevicesView.tsx"), "utf8");
const runtimeLab = readFileSync(join(root, "components/dashboard/RuntimeLabView.tsx"), "utf8");

assert(/codex:\s*"gpt-5\.4"/.test(devicesView), "DevicesView codex default is gpt-5.4");
const modelOptionsStart = devicesView.indexOf("export const MODEL_OPTIONS_BY_RUNNER");
const modelOptionsBody = modelOptionsStart >= 0 ? devicesView.slice(modelOptionsStart) : devicesView;
assert(!/gpt-5\.3-codex/.test(modelOptionsBody), "DevicesView model picker does not offer stale gpt-5.3-codex");
assert(!/gpt-5\.3-codex/.test(runtimeLab), "RuntimeLab fallback catalogue does not offer stale gpt-5.3-codex");
assert(/OBSOLETE_MODEL_IDS[\s\S]*gpt-5\.3-codex/.test(devicesView), "DevicesView drops stale saved Codex model preferences");
assert(/usableSavedModelForRunner\(row\.runnerId, row\.model\)/.test(devicesView), "primary runner settings loader filters stale models before Vibe sees them");

const dashboardPage = readFileSync(join(root, "app/dashboard/page.tsx"), "utf8");
assert(/probeDeviceStatus\(\{[\s\S]*deviceId: d\.id[\s\S]*usableTunnelUrls/.test(dashboardPage), "dashboard auto-connect probes the real browser transport");
assert(!/d\.online === true/.test(dashboardPage.slice(dashboardPage.indexOf("const autoConnectTriedRef"), dashboardPage.indexOf("const refreshConnectedRunners"))), "dashboard auto-connect does not treat heartbeat-only online as browser-reachable");

const vibeView = readFileSync(join(root, "components/dashboard/VibeCodingView.tsx"), "utf8");
assert(/const explicitInstalled = explicitRunner \? installed\.find/.test(vibeView), "Vibe keeps the machine primary runner selected when it is installed");
assert(/!selectedRunner \|\| !selectedStillAvailable/.test(vibeView), "Vibe only falls forward when the selected runner is absent, not merely blocked");
assert(/activeFailureSignInRunner/.test(vibeView), "Vibe failed task card exposes runner sign-in recovery for auth failures");
