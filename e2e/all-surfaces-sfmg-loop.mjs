#!/usr/bin/env node
/**
 * all-surfaces-sfmg-loop.mjs — load and vibe a REAL project on EVERY client
 * surface, one after another, against one remote box.
 *
 *   VIBE_BOX_HOST=http://<box>:18080 YAVER_TEST_TOKEN=… \
 *     node e2e/all-surfaces-sfmg-loop.mjs
 *
 * ── Two projects, on purpose ───────────────────────────────────────────────
 *
 *   sfmg   — a THIRD-PARTY Expo app. The ordinary case: load it, vibe it,
 *            watch the pixels change.
 *   yaver  — Yaver itself. The SELF-DEVELOPMENT case, which is not ordinary:
 *            loading Yaver's own Hermes bundle into the Yaver container puts
 *            two identical shake/exit owners in one RN process, so the preview
 *            cannot be exited. The agent must REFUSE that lane and route the
 *            user to browser/WebRTC instead.
 *
 * The second is included because a refusal is a product path with a UI, not an
 * error case to be skipped. On TestFlight build 500 (2026-08-03) that path
 * shipped broken in a way no arc could see: the agent refused correctly, and
 * the phone rendered the refusal PLUS a contradictory "Hermes bytecode version
 * mismatch" — because it classified the failure by grepping the agent's prose
 * for "hermes", which every message in a Hermes product contains. Then it
 * offered a single OK button while the agent had sent a machine-readable
 * `remedy` naming the lane that works.
 *
 * So this runner asserts the refusal's SHAPE, not just that it happened.
 *
 * ── Sequential, deliberately ───────────────────────────────────────────────
 *
 * The box serves ONE preview session at a time — it is a singleton, and a
 * second surface taking it over is an open defect (task #16). Running these in
 * parallel would have each surface stealing the previous one's dev server and
 * every verdict would describe a session someone else owned. Sequential is
 * correctness here, not politeness.
 *
 * ── Verdicts ───────────────────────────────────────────────────────────────
 *
 *   PIXELS  — the surface rendered the project and the vibe changed it.
 *   NAMED   — it did not, and the run says exactly why (missing simulator,
 *             signed-out app, no toolchain). A precondition, not a defect.
 *   SILENT  — it did not, and nothing can say why. The ONLY failing verdict.
 *
 * A NAMED skip is reported as a skip and never as a pass. The whole point of
 * this suite is that a green which did not measure anything is a lie.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BOX = process.env.VIBE_BOX_HOST || "";
const TOKEN = process.env.YAVER_TEST_TOKEN || "";
const RUN_ID = process.env.LOOP_RUN_ID || "all-surfaces";
const HERE = new URL("./", import.meta.url).pathname;
const RUN_DIR = join(HERE, "test-results", "loops", RUN_ID);
const ONLY = (process.env.ONLY_SURFACES || "").split(",").map((s) => s.trim()).filter(Boolean);

const log = (m) => console.log(`[all-surfaces] ${m}`);

if (!BOX) {
  console.log("[all-surfaces] SKIP — set VIBE_BOX_HOST (e.g. http://<your-box>:18080)");
  process.exit(0);
}
if (!TOKEN) {
  console.log("[all-surfaces] SKIP — set YAVER_TEST_TOKEN (a session token for the box's owner)");
  process.exit(0);
}

/**
 * The projects, and what each one is for.
 *
 * `selfDevelopment` marks the Yaver-in-Yaver case, whose Hermes lane MUST be
 * refused. Everything else about it is an ordinary preview.
 */
const PROJECTS = [
  {
    name: process.env.VIBE_PROJECT_NAME || "sfmg",
    path: process.env.VIBE_PROJECT_PATH || "/root/Workspace/sfmg",
    selfDevelopment: false,
  },
  {
    name: "yaver",
    path: process.env.YAVER_PROJECT_PATH || "/root/Workspace/yaver.io/mobile",
    selfDevelopment: true,
  },
];

/**
 * The surfaces, in the order they run.
 *
 * Cheapest and most diagnostic first: the headless arc needs no simulator at
 * all, so when it fails the later surfaces' failures are already explained and
 * a reader does not have to guess which layer broke. This is the same
 * HEADLESS-FIRST ordering CLAUDE.md mandates for investigation, applied to a
 * suite: never spend a 20-minute UI run to learn a fact an API call answers.
 */
const SURFACES = [
  { id: "headless", script: "native-headless-vibe.mjs", env: { SURFACE: "headless" } },
  { id: "tvos", script: "tvos-sim-vibe-loop.mjs", env: {} },
  { id: "visionos", script: "visionos-sim-loop.mjs", env: {} },
  { id: "ios", script: "ios-sim-preview-narration.mjs", env: {} },
  { id: "android", script: "android-emu-vibe-loop.mjs", env: {} },
];

mkdirSync(RUN_DIR, { recursive: true });

/** Ask the box directly, before spending a single simulator minute. */
async function preflight() {
  const res = await fetch(`${BOX}/info`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    .catch((e) => ({ ok: false, statusText: e.message }));
  if (!res.ok) throw new Error(`the box did not answer /info: ${res.status || ""} ${res.statusText || ""}`);
  const info = await res.json();
  log(`box ${info.hostname} · agent ${info.version}`);
  return info;
}

/**
 * The self-development refusal, probed headlessly.
 *
 * This is the fix from 2026-08-03 under test. It runs as an API call rather
 * than through a UI because the CONTRACT is what matters — a `code` a surface
 * can switch on and a `remedy` it can render as a button. A phone that has to
 * regex the sentence will drift, and did.
 */
async function probeSelfDevelopmentRefusal(project) {
  const res = await fetch(`${BOX}/dev/build-native`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath: project.path, platform: "ios" }),
  }).catch((e) => null);
  if (!res) return { ok: false, why: "the box did not answer /dev/build-native" };
  const body = await res.json().catch(() => ({}));

  if (body.code !== "YAVER_SELF_DEVELOPMENT_RECURSION") {
    return {
      ok: false,
      why: `expected the Hermes lane to be refused with YAVER_SELF_DEVELOPMENT_RECURSION, got `
        + `${JSON.stringify(body.code || body.status || body.error || body).slice(0, 200)}`,
    };
  }
  // A refusal with no route is the defect that shipped: the user is told what
  // will not work and given no way to reach what will.
  if (!body.remedy) {
    return { ok: false, why: "the refusal carried no `remedy`, so no surface can offer a route out of it" };
  }
  return { ok: true, why: `refused correctly · code=${body.code} · remedy=${body.remedy}` };
}

/**
 * Release the box's preview session before handing it to the next surface.
 *
 * MEASURED 2026-08-03, and this is why the runner needs it: the box serves ONE
 * preview per project. Surface 1 (headless) opened sfmg, and every surface
 * after it was refused —
 *
 *   tvOS:     "Preview unavailable · preview session for project \"sfmg\"
 *              already active; stop it first · [Try again]"
 *   visionOS: the same wall, same wording.
 *
 * So a sequential runner is NOT automatically safe: without an explicit
 * release, surfaces 2..N cannot render at all and every one of their verdicts
 * describes a session the first surface still holds. The suite would report
 * four surfaces as broken when the truth is one lock and no key.
 *
 * The route exists and always did — POST /vibing/preview/stop, and every
 * client already wraps it (mobile/src/lib/vibePreview.ts:153,
 * web/lib/agent-client.ts:5281, tvos/YaverTV/AgentClient.swift:354). What is
 * missing is any UI offering it from the error that names it; the screens
 * offer "Try again", which cannot succeed while the lock is held. That is a
 * product defect (task #16), tracked separately. This function is the runner
 * refusing to be blocked by it.
 */
async function releasePreview(project) {
  for (const path of ["/vibing/preview/stop", "/dev/web-preview/stop"]) {
    await fetch(`${BOX}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ project: project.name }),
    }).catch(() => null);
  }
  // The stop is asynchronous on the box; give the port a moment to actually
  // free before the next surface tries to claim it. Probing the operation
  // would be better than sleeping, but there is no "is it released" verb yet —
  // that gap is worth an ops verb (HEADLESS FIRST: a question you can only
  // answer by waiting is a missing endpoint).
  await new Promise((r) => setTimeout(r, 4000));
}

/** Run one surface arc to completion and classify what it said. */
function runSurface(surface, project) {
  const script = join(HERE, surface.script);
  if (!existsSync(script)) {
    return { verdict: "NAMED", reason: `no arc for this surface yet (${surface.script} is missing)` };
  }
  const started = Date.now();
  // RUN UNDER tsx, NOT BARE node.
  //
  // These arcs import the SHARED verdict/viewport modules straight from
  // web/lib/*.ts on purpose — the colour classifier and the surface table that
  // ship are the ones the loops must judge with, never a re-typed copy. Node
  // cannot load .ts, so `node arc.mjs` dies with ERR_UNKNOWN_FILE_EXTENSION
  // before the arc runs a single line.
  const out = spawnSync("npx", ["tsx", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...surface.env,
      VIBE_BOX_HOST: BOX,
      YAVER_TEST_TOKEN: TOKEN,
      VIBE_PROJECT_NAME: project.name,
      VIBE_PROJECT_PATH: project.path,
      LOOP_RUN_ID: `${RUN_ID}/${project.name}-${surface.id}`,
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  const text = `${out.stdout || ""}\n${out.stderr || ""}`;
  const elapsed = Math.round((Date.now() - started) / 1000);

  // Read the arc's OWN verdict line rather than its exit code. An arc that
  // skipped exits 0 on purpose, and treating that as a pass is precisely the
  // false green this suite exists to remove (it already happened once, when
  // xcodebuild exited 0 for "1 skipped").
  const line = (text.match(/^\s*[a-z0-9-]+:\s*(PIXELS|NARRATED|NAMED|SKIPPED|SILENT).*$/gim) || []).pop() || "";
  let verdict = "SILENT";
  if (/PIXELS|NARRATED/i.test(line)) verdict = "PIXELS";
  else if (/SKIPPED|NAMED/i.test(line)) verdict = "NAMED";

  // WHEN THERE IS NO VERDICT, QUOTE THE FAULT — NOT THE LAST LINE.
  //
  // The last line of a crashed Node process is its version banner, so the
  // first run of this orchestrator reported `SILENT — Node.js v22.12.0` for a
  // module-resolution error it had the full text of. A runner that discards
  // the cause it was handed is the same defect as a phone that flattens a
  // structured error to prose; it just happens to be ours.
  const fault = (text.match(/^(?:\w*Error|Uncaught|TypeError|ReferenceError)[^\n]*/m) || [])[0];
  const reason = line.replace(/^\s*[a-z0-9-]+:\s*/i, "").trim()
    || fault
    || (text.trim().split("\n").filter((l) => l.trim()).pop() || "the arc printed no verdict line at all");
  return { verdict, reason: reason.slice(0, 300), elapsed, output: text.slice(-4000) };
}

// ── Run ─────────────────────────────────────────────────────────────────────
const results = [];
try {
  await preflight();
} catch (err) {
  console.log(`\n[all-surfaces] SKIP — ${err.message}`);
  console.log("\nall-surfaces: SKIPPED (NAMED)");
  process.exit(0);
}

for (const project of PROJECTS) {
  log(`\n═══ project ${project.name} (${project.path}) ═══`);

  if (project.selfDevelopment) {
    const probe = await probeSelfDevelopmentRefusal(project);
    results.push({
      project: project.name, surface: "hermes-refusal",
      verdict: probe.ok ? "PIXELS" : "SILENT", reason: probe.why,
    });
    log(`hermes-refusal: ${probe.ok ? "OK" : "FAILED"} — ${probe.why}`);
  }

  for (const surface of SURFACES) {
    if (ONLY.length && !ONLY.includes(surface.id)) continue;
    log(`── ${project.name} on ${surface.id} …`);
    // Claim a clean session for THIS surface, never an inherited one.
    await releasePreview(project);
    const r = runSurface(surface, project);
    results.push({ project: project.name, surface: surface.id, ...r });
    log(`   ${r.verdict} — ${r.reason}`);

    // A surface that hit the lock anyway is reported as what it is, so the
    // summary can never read as "this surface is broken".
    if (/already active|stop it first/i.test(r.reason)) {
      r.verdict = "NAMED";
      r.reason = `blocked by the preview singleton (task #16), not by this surface: ${r.reason}`;
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(78));
console.log("ALL-SURFACES SEQUENTIAL LOOP");
console.log("═".repeat(78));
for (const r of results) {
  const mark = r.verdict === "PIXELS" ? "✓" : r.verdict === "NAMED" ? "·" : "✗";
  console.log(`${mark} ${(r.project + "/" + r.surface).padEnd(28)} ${r.verdict.padEnd(7)} ${r.reason}`);
}

const pixels = results.filter((r) => r.verdict === "PIXELS").length;
const named = results.filter((r) => r.verdict === "NAMED").length;
const silent = results.filter((r) => r.verdict === "SILENT");

console.log("═".repeat(78));
console.log(`${pixels} reached PIXELS · ${named} NAMED (precondition missing) · ${silent.length} SILENT`);
if (named) {
  console.log("\nNAMED is NOT a pass. Each of these measured nothing and said so:");
  for (const r of results.filter((x) => x.verdict === "NAMED")) {
    console.log(`  ${r.project}/${r.surface}: ${r.reason}`);
  }
}

try {
  writeFileSync(join(RUN_DIR, "summary.json"),
    JSON.stringify({ runId: RUN_ID, box: BOX, results }, null, 2));
  log(`summary: ${join(RUN_DIR, "summary.json")}`);
} catch { /* artifacts never change a verdict */ }

// Only SILENT fails. A missing simulator is a precondition; a surface that
// cannot explain itself is a product defect.
process.exit(silent.length ? 1 : 0);
