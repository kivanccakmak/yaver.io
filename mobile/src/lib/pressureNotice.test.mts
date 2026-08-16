// pressureNotice.test.mts — the storage_pressure push must be spent, not
// sampled. Run: npx tsx src/lib/pressureNotice.test.mts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pressureBody, pressureRoute } from "./pressureNotice.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("the agent's deepLink decides the destination", () => {
  assert.equal(pressureRoute("yaver://storage"), "/storage");
  assert.equal(pressureRoute("yaver://devices"), "/(tabs)/devices");
});

test("an unknown or missing deepLink still lands somewhere useful", () => {
  // A push from a NEWER agent naming a screen this build lacks must not become
  // a button that does nothing.
  assert.equal(pressureRoute("yaver://some-future-screen"), "/(tabs)/devices");
  assert.equal(pressureRoute(undefined), "/(tabs)/devices");
  assert.equal(pressureRoute(""), "/(tabs)/devices");
});

test("the body states HOW full, not just that something is wrong", () => {
  // usedPct/freeGb were produced and dropped, so the alert could say "running
  // out of space" while withholding the only numbers that quantify it.
  const body = pressureBody({
    alerts: ["/ is 95% full"],
    usedPct: 95.4,
    freeGb: 3.2,
    reclaimable: "12.4 GB",
  });
  assert.match(body, /95% used/);
  assert.match(body, /3\.2 GB free/);
  assert.match(body, /12\.4 GB of build caches/);
  assert.match(body, /\/ is 95% full/);
});

test("missing figures degrade quietly instead of printing undefined", () => {
  const body = pressureBody({ alerts: ["/ is 95% full"] });
  assert.equal(body, "/ is 95% full");
  assert.doesNotMatch(body, /undefined|NaN/);
});

test("a zero reclaimable figure is not offered as an action", () => {
  const body = pressureBody({ alerts: ["x"], reclaimable: "0 B" });
  assert.doesNotMatch(body, /reclaimed/);
});

test("WIRE CONTRACT: every field the agent sends is consumed here", () => {
  // The guard that would have caught this. storage_pressure.go builds one map;
  // the phone read three of its five keys and nothing said so. Enumerate the
  // producer's keys and require each to appear in this module — a new fact the
  // agent starts sending now fails here instead of being silently ignored.
  const goSrc = readFileSync(join(repoRoot, "desktop/agent/storage_pressure.go"), "utf8");
  const keys = new Set<string>();
  for (const m of goSrc.matchAll(/data\["([a-zA-Z]+)"\]\s*=/g)) keys.add(m[1]);
  for (const m of goSrc.matchAll(/^\s*"([a-zA-Z]+)":\s+/gm)) keys.add(m[1]);
  assert.ok(keys.size >= 5, `expected the storage_pressure payload keys, found ${[...keys].join(",")}`);

  const consumed = readFileSync(join(repoRoot, "mobile/src/lib/pressureNotice.ts"), "utf8");
  for (const key of keys) {
    assert.match(
      consumed,
      new RegExp(`\\b${key}\\b`),
      `storage_pressure.go sends "${key}" and pressureNotice.ts never mentions it — the agent measured something no user will see`,
    );
  }
});
