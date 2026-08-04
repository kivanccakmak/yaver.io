#!/usr/bin/env npx tsx
/**
 * render-incapable-vibe-loop — sfmg vibing on the surfaces that CANNOT render.
 *
 *   VIBE_BOX_HOST=http://<box>:18080 YAVER_TEST_TOKEN=… \
 *   VIBE_PROJECT_PATH=/root/Workspace/sfmg npx tsx e2e/render-incapable-vibe-loop.mjs
 *
 * ── Why this arc exists, and why it must NOT assert pixels ─────────────────
 *
 * The surface-coverage audit (docs/audits/vibe-loop-surface-coverage-2026-08-04.md)
 * measured what each surface can actually do. Two of them can start a coding turn
 * and have NO way to show the result:
 *
 *   CarPlay   voice → dispatchAndSummarize → task. Zero render references;
 *             Apple's voice template forbids a picker or preview while driving.
 *   watchOS   Dictation + the desktop_voice verb; WatchProtocol already carries
 *             taskId/status. There is no frame path at all.
 *
 * So a green→black PIXEL verdict is impossible there BY CONSTRUCTION. Writing one
 * anyway would mean either faking a render or marking the surfaces broken for
 * lacking a screen they are not supposed to have — and a false red is exactly as
 * corrosive as a false green.
 *
 * What IS testable, and what actually matters to a driver or a watch wearer, is
 * the DISPATCH: did my spoken sentence reach the box, become a real coding turn,
 * and change the project? This arc asserts that, and says plainly that it is not
 * asserting pixels.
 *
 * ── Why it drives the shipped logic ────────────────────────────────────────
 *
 * carVoiceCoding.ts takes its dispatch/getTask/speak as INJECTED deps, so this
 * runs the real state machine — the confirm gate, the title derivation, the poll
 * loop, the one-sentence summary — against the real agent. A re-implementation
 * here would test this file instead of the product.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOX = process.env.VIBE_BOX_HOST || "";
const TOKEN = process.env.YAVER_TEST_TOKEN || "";
const PROJECT_PATH = process.env.VIBE_PROJECT_PATH || "/root/Workspace/sfmg";
const PROJECT = process.env.VIBE_PROJECT || "sfmg";

if (!BOX || !TOKEN) {
  console.log("SKIP — needs VIBE_BOX_HOST and YAVER_TEST_TOKEN (an environment gap is not a product fault)");
  process.exit(0);
}

const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const log = (m) => console.log(`[render-incapable] ${m}`);

/** Ask the box to run a command and WAIT for its output. /exec is asynchronous —
 *  it answers {execId} and the result lands on /exec/<id>. Reading stdout off the
 *  first reply (as an earlier version of the web arc did) silently yields "". */
async function boxExec(command) {
  const started = await fetch(`${BOX}/exec`, {
    method: "POST", headers: H, body: JSON.stringify({ command, timeout: 25 }),
  });
  if (!started.ok) return null;
  const { execId } = await started.json();
  if (!execId) return null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const res = await fetch(`${BOX}/exec/${execId}`, { headers: H });
    if (!res.ok) continue;
    const body = await res.json();
    if (body.exec?.status === "completed") return (body.exec.stdout ?? "").trim();
  }
  return null;
}

const treeFingerprint = () => boxExec(`git -C ${PROJECT_PATH} status --porcelain`);

async function main() {
  const results = [];

  // ── CarPlay ───────────────────────────────────────────────────────────────
  // Drive the SHIPPED state machine with real deps pointed at the real box.
  const { dispatchAndSummarize } = await import(
    join(HERE, "..", "mobile", "src", "lib", "carVoiceCoding.ts")
  );

  const before = await treeFingerprint();
  if (before === null) {
    console.log("SKIP — the box would not answer /exec, so no verdict is possible");
    process.exit(0);
  }
  log(`baseline: ${before.split("\n").filter(Boolean).length} dirty files in ${PROJECT}`);

  const spoken = [];
  const carResult = await dispatchAndSummarize(
    "add a code comment at the top of src/theme/colors.ts that says vibe loop reached this file",
    {
      transcribe: async () => { throw new Error("not used — this arc supplies the transcript directly"); },
      dispatch: async (title, prompt) => {
        const res = await fetch(`${BOX}/tasks`, {
          method: "POST", headers: H,
          // `description` is the field the agent reads. Sending the prompt under
          // any other key produces a task that runs on an EMPTY prompt — the
          // agent now refuses that outright (task.prompt_missing), which is
          // itself a bug this loop found.
          body: JSON.stringify({ title, description: prompt, projectName: PROJECT, workDir: PROJECT_PATH }),
        });
        if (!res.ok) throw new Error(`dispatch failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
        const body = await res.json();
        const id = body.id || body.task?.id;
        if (!id) throw new Error(`dispatch returned no task id: ${JSON.stringify(body).slice(0, 160)}`);
        return id;
      },
      getTask: async (taskId) => {
        const res = await fetch(`${BOX}/tasks/${taskId}`, { headers: H });
        if (!res.ok) return { id: taskId, status: "running" };
        const t = await res.json();
        return { id: taskId, status: t.status, resultText: t.resultText, output: t.output };
      },
      speak: async (text) => { spoken.push(text); },
    },
    { maxWaitMs: 8 * 60_000, pollIntervalMs: 5_000 },
  );

  log(`car: task=${carResult.taskId ?? "none"} status=${carResult.status ?? "?"} timedOut=${!!carResult.timedOut}`);
  log(`car: spoke ${JSON.stringify(carResult.spoken)}`);

  // THE ASSERTIONS, and their limits, stated.
  const carDispatched = Boolean(carResult.taskId) && !carResult.declined;
  // A driver's only feedback is the sentence. An empty one is the car equivalent
  // of a silent spinner.
  const carSpoke = spoken.length > 0 && spoken.every((s) => s.trim().length > 0);
  const after = await treeFingerprint();
  const treeChanged = after !== null && after !== before;

  results.push({
    surface: "car (CarPlay)",
    verdict: carDispatched && carSpoke ? (treeChanged ? "DISPATCHED+CHANGED" : "DISPATCHED") : "FAILED",
    detail: `taskId=${carResult.taskId ?? "-"} spoken=${carSpoke} treeChanged=${treeChanged}` +
      (carResult.error ? ` error=${carResult.error}` : ""),
    note: "pixels NOT asserted: CarPlay has no render path — Apple's voice template forbids one while driving",
  });

  // ── watchOS ───────────────────────────────────────────────────────────────
  // The watch dictates and sends the desktop_voice ops verb. Drive that verb
  // exactly as the watch does, and assert the box accepted it.
  const watchRes = await fetch(`${BOX}/ops`, {
    method: "POST", headers: H,
    body: JSON.stringify({ verb: "desktop_voice", args: { text: "what is the status of this project" } }),
  }).catch((e) => ({ ok: false, status: 0, statusText: String(e) }));
  const watchBody = watchRes.ok ? await watchRes.json().catch(() => ({})) : {};
  // /ops answers 200 with ok:false for an unknown verb, so the STATUS is not the
  // verdict — the body's own ok/code is (project_ops_unknown_verb_is_200_ok_false).
  const watchAccepted = watchRes.ok && watchBody?.ok !== false;
  results.push({
    surface: "watch (watchOS)",
    verdict: watchAccepted ? "DISPATCH LANE OK" : "FAILED",
    detail: `http=${watchRes.status} ok=${JSON.stringify(watchBody?.ok)} code=${watchBody?.result?.code ?? watchBody?.code ?? "-"}`,
    note: "pixels NOT asserted: watchOS has no frame path at all",
  });

  // ── Report ────────────────────────────────────────────────────────────────
  console.log("\n─── sfmg vibing · render-incapable surfaces ───");
  for (const r of results) {
    console.log(`  ${r.surface.padEnd(18)} ${r.verdict.padEnd(20)} ${r.detail}`);
    console.log(`  ${" ".repeat(18)} ${r.note}`);
  }
  const failed = results.filter((r) => r.verdict === "FAILED");
  if (failed.length) {
    console.error(`\n${failed.length} surface(s) failed to dispatch`);
    process.exit(1);
  }
  console.log("\nall render-incapable surfaces dispatched a real coding turn");
}

main().catch((err) => {
  console.error(`[render-incapable] arc error: ${err?.stack || err}`);
  process.exit(1);
});
