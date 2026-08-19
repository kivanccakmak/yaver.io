import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("device removal is wired through every account-management surface", () => {
  const contracts = [
    ["web", "web/components/dashboard/RecycleBoxDialog.tsx", "/devices/remove"],
    ["mobile/tablet", "mobile/src/context/DeviceContext.tsx", "/devices/remove"],
    ["desktop", "desktop/app/src/renderer/index.html", "removeAccountDevice"],
    ["tvOS", "tvos/YaverTV/MachineRegistry.swift", "devices/remove"],
    ["visionOS", "visionos/YaverVision/Views/VisionDashboardView.swift", "removeSelectedMachine"],
    ["watchOS", "watch/YaverWatch/Backend.swift", "devices/remove"],
    ["Wear OS", "wear/app/src/main/kotlin/io/yaver/wear/Backend.kt", "/devices/remove"],
    ["CLI", "desktop/agent/main.go", "yaver devices remove <device-id>"],
  ];
  for (const [surface, path, marker] of contracts) {
    assert.match(source(path), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${surface} removal route missing`);
  }
});

test("read-only car and glass surfaces consume the tombstone-filtered shared registry", () => {
  assert.match(source("mobile/app/car-voice-coding.tsx"), /useDevice/);
  assert.match(source("mobile/app/glass-workspace.tsx"), /useDevice/);
  assert.match(source("backend/convex/devices.ts"), /activeDeviceRows\(/);
});

test("BYO removal never enters snapshot or provider decommission policy", () => {
  const policy = source("web/lib/deviceRemovalPolicy.ts");
  assert.match(policy, /device\.hosting === "yaver-hosted"/);
  assert.match(policy, /return device\.hosting === "yaver-hosted" \? "cloud-decommission" : "account-forget"/);
});
