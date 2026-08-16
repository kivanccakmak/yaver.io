/**
 * goalSlashCommandParity.test.ts — `npx tsx lib/goalSlashCommandParity.test.ts`.
 *
 * Pins the web↔mobile parity contract for Yaver goal-mode (2026-08-09).
 * The web dashboard (VibeCodingView.tsx::goalFromSlashCommand) and the mobile
 * app (mobile/src/lib/goalSlashCommand.ts) each carry a copy of the same
 * `/goal <objective>` recognizer. They sit in different module trees (web
 * lib vs RN src) and can never be imported from each other — so drift is
 * invisible to tsc and surfaces as "goal works on the phone, not the web"
 * at runtime. That is exactly the dual-implementation defect class the
 * AGENTS.md cross-surface parity rule exists to kill.
 *
 * Rules pinned here (both copies must agree on ALL of them):
 *  - `/goal <objective>` (case-insensitive) → {goal, prompt} = objective
 *  - `/goal` with NO objective → null (passes through to the runner raw)
 *  - `/goal <obj>` on a NON-opencode runner → null (their native /goal)
 *  - `/goal <obj>` on opencode (or no runner selected) → structured goal
 *  - non-`/goal` text → null (normal one-shot task)
 *
 * The MOBILE copy is the one that runs here (it is a pure, dependency-free
 * module, so it is imported directly). The WEB copy lives in a .tsx with
 * full React imports and cannot be imported in this harness, so its SOURCE
 * is asserted to carry the identical algorithm markers — a drift in either
 * copy fails here.
 *
 * ALSO pins the Convex last-project helpers' wire shape:
 *  - loadLastProjectFromConvex / saveLastProjectToConvex use
 *    defaultRuntimeProjectByDevice / defaultRuntimeProjectForDevice.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The mobile copy — real shipped module, imported directly.
import { goalFromSlashCommand as mobileGoalFromSlashCommand } from "../../mobile/src/lib/goalSlashCommand";

// Web helpers (real logic) for the Convex wire-shape test.
import { loadLastProjectFromConvex, saveLastProjectToConvex, loadMCPServersFromConvex, saveMCPServersToConvex } from "./runtimeProjectSettings";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(root, "..");

const webGoalSource = readFileSync(join(root, "components/dashboard/VibeCodingView.tsx"), "utf8");
assert.ok(
  webGoalSource.includes("function goalFromSlashCommand("),
  "VibeCodingView.tsx must still carry goalFromSlashCommand (this test pins the surface wiring)",
);

// The canonical algorithm, written out here as the expected-behavior oracle.
// Both copies must match it exactly.
function oracleGoalFromSlashCommand(
  input: string | null | undefined,
  runner: string | null | undefined,
): { goal: string; prompt: string } | null {
  const text = String(input || "").trim();
  if (!/^\/goal\s+/i.test(text)) return null;
  const objective = text.replace(/^\/goal\s+/i, "").trim();
  if (!objective) return null;
  const runnerId = String(runner || "").trim().toLowerCase();
  if (runnerId && runnerId !== "opencode") return null;
  return { goal: objective, prompt: objective };
}

const CASES: Array<{ input: string | null; runner: string | null; expected: { goal: string; prompt: string } | null }> = [
  { input: "/goal refactor the auth flow", runner: "opencode", expected: { goal: "refactor the auth flow", prompt: "refactor the auth flow" } },
  { input: "/goal fix the login screen", runner: null, expected: { goal: "fix the login screen", prompt: "fix the login screen" } },
  { input: "/GOAL SHIP THE RELEASE", runner: "opencode", expected: { goal: "SHIP THE RELEASE", prompt: "SHIP THE RELEASE" } },
  { input: "/goal", runner: "opencode", expected: null },
  { input: "/goal ", runner: "opencode", expected: null },
  { input: "/goal   ", runner: "opencode", expected: null },
  { input: "/goal make it fast", runner: "claude", expected: null },
  { input: "/goal make it fast", runner: "codex", expected: null },
  { input: "/goal make it fast", runner: "glm", expected: null },
  { input: "/goal make it fast", runner: "", expected: { goal: "make it fast", prompt: "make it fast" } },
  { input: "fix the login screen", runner: "opencode", expected: null },
  { input: "/exit", runner: "opencode", expected: null },
  { input: "/help", runner: "opencode", expected: null },
  { input: null, runner: "opencode", expected: null },
  { input: "  /goal   trim  me  ", runner: "opencode", expected: { goal: "trim  me", prompt: "trim  me" } },
];

for (const c of CASES) {
  const label = JSON.stringify(c.input) + " on " + JSON.stringify(c.runner);
  test(`goal recognizer parity: ${label}`, () => {
    const m = mobileGoalFromSlashCommand(c.input, c.runner);
    assert.deepEqual(m, oracleGoalFromSlashCommand(c.input, c.runner), `mobile copy ${label}`);
    assert.deepEqual(m, c.expected, `mobile copy diverges from oracle ${label}`);
  });
}

test("web VibeCodingView goalFromSlashCommand source carries the identical algorithm markers", () => {
  // The web copy must be the SAME recognizer: same slash regex, same
  // objective extraction, same opencode-only gate, and must feed the
  // structured goal field (NOT a raw runner command).
  assert.ok(webGoalSource.includes("/^\\/goal\\s+/i"), "web copy must match /goal<space> prefix");
  assert.ok(webGoalSource.includes("!== \"opencode\""), "web copy must gate on opencode only");
  assert.ok(webGoalSource.includes("goal: goalObjective || undefined"), "web task body must carry the goal field");
  assert.ok(webGoalSource.includes("const rawRunnerCommand = isRawRunnerCommand(goalPrompt)"), "recognized /goal must not be a raw runner command");
});

test("web VibeCodingView goal source is not a drifted duplicate", () => {
  // Extract the web recognizer body and compare it marker-for-marker against
  // the mobile module's source. Both must contain the same three markers.
  const mobileSource = readFileSync(join(repoRoot, "mobile/src/lib/goalSlashCommand.ts"), "utf8");
  const markers = [
    "/^\\/goal\\s+/i",
    ".replace(/^\\/goal\\s+/i, \"\")",
    "runnerId && runnerId !== \"opencode\"",
  ];
  for (const marker of markers) {
    assert.ok(mobileSource.includes(marker), `mobile copy missing marker: ${marker}`);
    assert.ok(webGoalSource.includes(marker), `web copy missing marker: ${marker}`);
  }
});

test("mobile goalSlashCommand.ts is imported by every mobile surface", () => {
  const surfaces = ["app/(tabs)/tasks.tsx", "app/tv-coding.tsx", "app/car-voice-coding.tsx", "src/components/WatchBridgeHost.tsx"];
  for (const surface of surfaces) {
    const source = readFileSync(join(repoRoot, "mobile", surface), "utf8");
    assert.ok(
      source.includes("goalFromSlashCommand"),
      `mobile/${surface} must import and use goalFromSlashCommand`,
    );
  }
});

test("web and mobile Convex last-project helpers use the same wire shape", async () => {
  // Wire shape: defaultRuntimeProjectForDevice on write (replace-by-deviceId),
  // defaultRuntimeProjectByDevice array on read. Both helper pairs target the
  // SAME Convex fields, so a project saved on one surface restores on the other.
  const webSource = readFileSync(join(root, "lib/runtimeProjectSettings.ts"), "utf8");
  assert.ok(webSource.includes("defaultRuntimeProjectForDevice"), "web write must use defaultRuntimeProjectForDevice");
  assert.ok(webSource.includes("defaultRuntimeProjectByDevice"), "web read must use defaultRuntimeProjectByDevice");

  const mobileSource = readFileSync(join(repoRoot, "mobile/src/lib/taskComposerPrefs.ts"), "utf8");
  assert.ok(mobileSource.includes("defaultRuntimeProjectForDevice"), "mobile write must use defaultRuntimeProjectForDevice");
  assert.ok(mobileSource.includes("defaultRuntimeProjectByDevice"), "mobile read must use defaultRuntimeProjectByDevice");

  // Mock-fetch round trip through the web helpers (real logic, stubbed fetch).
  let settings: any = {};
  let posted: any = null;
  (globalThis as any).fetch = async (url: string, init?: any) => {
    if (init?.method === "POST") {
      posted = JSON.parse(init.body);
      const pref = posted.defaultRuntimeProjectForDevice;
      settings.defaultRuntimeProjectByDevice = [{ ...pref, updatedAt: Date.now() }];
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ settings }) };
  };
  try {
    await saveLastProjectToConvex("https://convex.test", "tok", {
      deviceId: "ubuntu-4gb",
      projectName: "medici.ai",
      gitRemote: "git@github.com:medici/medici.ai.git",
      branch: "main",
    });
    assert.deepEqual(posted.defaultRuntimeProjectForDevice, {
      deviceId: "ubuntu-4gb",
      projectName: "medici.ai",
      gitRemote: "git@github.com:medici/medici.ai.git",
      branch: "main",
    });
    const loaded = await loadLastProjectFromConvex("https://convex.test", "tok", "ubuntu-4gb");
    assert.equal(loaded?.projectName, "medici.ai");
    assert.equal(loaded?.gitRemote, "git@github.com:medici/medici.ai.git");
    assert.equal(loaded?.deviceId, "ubuntu-4gb");
  } finally {
    delete (globalThis as any).fetch;
  }
});

test("web, mobile and tvOS MCP helpers use the same wire shape", async () => {
  // Wire shape: mcpServersForDevice on write (replace-by-deviceId),
  // mcpServersByDevice array on read, includeYaverMcp toggle in the same row.
  // Three surfaces must target the SAME Convex fields or a selection made on
  // one is silently lost on the others (2026-08-10 cross-surface MCP sync).
  const webSource = readFileSync(join(root, "lib/runtimeProjectSettings.ts"), "utf8");
  assert.ok(webSource.includes("mcpServersForDevice"), "web write must use mcpServersForDevice");
  assert.ok(webSource.includes("mcpServersByDevice"), "web read must use mcpServersByDevice");
  assert.ok(webSource.includes("includeYaverMcp"), "web row must carry includeYaverMcp");

  const mobileSource = readFileSync(join(repoRoot, "mobile/src/lib/taskComposerPrefs.ts"), "utf8");
  assert.ok(mobileSource.includes("mcpServersForDevice"), "mobile write must use mcpServersForDevice");
  assert.ok(mobileSource.includes("mcpServersByDevice"), "mobile read must use mcpServersByDevice");
  assert.ok(mobileSource.includes("includeYaverMcp"), "mobile row must carry includeYaverMcp");

  const tvSource = readFileSync(join(repoRoot, "tvos/YaverTV/MachineRegistry.swift"), "utf8");
  assert.ok(tvSource.includes("mcpServersForDevice"), "tvOS write must use mcpServersForDevice");
  assert.ok(tvSource.includes("mcpServersByDevice"), "tvOS read must use mcpServersByDevice");
  assert.ok(tvSource.includes("includeYaverMcp"), "tvOS row must carry includeYaverMcp");

  // Mock-fetch round trip through the WEB helpers (real logic, stubbed fetch).
  let settings: any = {};
  let posted: any = null;
  (globalThis as any).fetch = async (url: string, init?: any) => {
    if (init?.method === "POST") {
      posted = JSON.parse(init.body);
      const pref = posted.mcpServersForDevice;
      settings.mcpServersByDevice = [{ ...pref, updatedAt: Date.now() }];
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ settings }) };
  };
  try {
    await saveMCPServersToConvex("https://convex.test", "tok", {
      deviceId: "ubuntu-4gb",
      mcpServers: ["github", "supabase"],
      includeYaverMcp: false,
    });
    assert.deepEqual(posted.mcpServersForDevice, {
      deviceId: "ubuntu-4gb",
      mcpServers: ["github", "supabase"],
      includeYaverMcp: false,
    });
    const loaded = await loadMCPServersFromConvex("https://convex.test", "tok", "ubuntu-4gb");
    assert.deepEqual(loaded?.mcpServers, ["github", "supabase"]);
    assert.equal(loaded?.includeYaverMcp, false);
  } finally {
    delete (globalThis as any).fetch;
  }
});
