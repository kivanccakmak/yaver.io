#!/usr/bin/env node
/**
 * native-headless-vibe.mjs — the tvOS / visionOS colour loop, HEADLESS.
 *
 *   YAVER_TEST_TOKEN=… npx tsx e2e/native-headless-vibe.mjs [tv|vision]
 *
 * (tsx, not node: it imports the SHARED classifier from web/lib/vibeVerdict.ts,
 *  so the TV verdict and the browser verdict can never drift apart.)
 *
 * ── Why headless comes first (CLAUDE.md) ───────────────────────────────────
 *
 * "Headless first, then closed loop." This arc drives the EXACT endpoints the
 * native client calls — POST /tasks (AgentClient.createTask, landed 2026-08-03)
 * and the preview-frame flow — with no simulator, no XCUITest, no Xcode. It
 * answers in seconds whether the SERVER half of a TV/headset vibe works, so a
 * later UI failure can only be the UI.
 *
 * Running the simulator arc first would have cost ~20 minutes per attempt to
 * learn things a 90-second HTTP exchange proves. That lesson was paid for on
 * 2026-08-02: three 25-minute browser runs chased harness bugs while one
 * `codex exec` would have named the real cause immediately.
 *
 * ── What it proves, in order ───────────────────────────────────────────────
 *
 *   1. the box answers and the session is valid          (GET /info)
 *   2. a task can be CREATED the way the native client creates one
 *   3. the runner actually edits the file (git diff on the box)
 *   4. the preview frame the TV would render changes colour  → PIXELS
 *   5. a SECOND task reverts it, and the frame goes back
 *
 * Step 4 is the honest part. tvOS has no browser, so its verdict is a STREAMED
 * FRAME — /vibing/preview/snapshot + /vibing/preview/frames/{hash}, the same
 * flow AgentClient already implements. visionOS can additionally use a real
 * WKWebView, but sharing this verdict keeps the two surfaces comparable.
 *
 * NOT a substitute for the UI arc. It cannot see a layout, a stuck spinner, or
 * a control that does not exist — which is exactly why the phased plan puts the
 * simulator loop after it, never instead of it.
 * See docs/planning/native-surface-vibe-and-closed-loop-plan-2026-08-03.md
 */
import { classifyVibeColor } from "../web/lib/vibeVerdict.ts";

const SURFACE = (process.argv[2] || "tv").toLowerCase();
const TOKEN = process.env.YAVER_TEST_TOKEN || "";
const BOX = process.env.VIBE_BOX_HOST || "http://100.75.123.78:18080";
const WORKDIR = process.env.VIBE_PROJECT_PATH || "/root/Workspace/yaver.io/mobile";
const PROJECT = process.env.VIBE_PROJECT_NAME || "mobile";
const BUDGET_MS = Number(process.env.VIBE_BUDGET_MS || 12 * 60_000);

if (!TOKEN) {
  // An environment gap is not a product defect — say so and skip, exactly as
  // the browser arcs do, so a fresh checkout never cries wolf.
  console.log("SKIP: set YAVER_TEST_TOKEN (a session token for the box's owner)");
  process.exit(0);
}

const h = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${BOX}${path}`, { ...init, headers: { ...h, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} → HTTP ${res.status}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.arrayBuffer();
}

/** Step 2 — the same body AgentClient.createTask sends. runner/model omitted on
 *  purpose: the agent applies the account's per-device primary, so this arc can
 *  never drift onto a model the subscription cannot run. */
async function startVibe(description) {
  const t = await api("/tasks", {
    method: "POST",
    body: JSON.stringify({ title: description.slice(0, 60), description, workDir: WORKDIR }),
  });
  return t.task?.id || t.id;
}

/**
 * Boot the capture pipeline. PROBED, not guessed (2026-08-03): a first draft
 * polled GET /vibing/preview/snapshot and got {"error":"method not allowed"},
 * while /vibing/preview/status reported sessions: [] — nothing was capturing at
 * all. The authoritative shape is tvOS AgentClient's own flow:
 *
 *   POST /dev/web-preview/start   → boot the static server for the project
 *   POST /vibing/preview/start    → headless Chrome starts capturing it
 *   POST /vibing/preview/snapshot → newest frame's hash   (POST, not GET)
 *   GET  /vibing/preview/frames/{hash} → the bytes
 */
async function startCapture(project) {
  const boot = await api("/dev/web-preview/start", { method: "POST", body: "{}" }).catch(() => ({}));
  const targetUrl = boot.webUrl || (boot.port ? `http://127.0.0.1:${boot.port}` : "");
  await api("/vibing/preview/start", {
    method: "POST",
    body: JSON.stringify({ project, targetUrl, mode: "live", width: 1280, height: 800 }),
  });
  return targetUrl;
}

// The newest frame, kept on disk so the text oracle can read the SAME pixels the
// colour verdict judged. Reading a different capture would let the two disagree
// about what was on screen, which is worse than having no text at all.
let lastFramePath = "";

/** Step 4 — the frame a TV would be rendering, as pixels. */
async function frameColor(project) {
  const snap = await api("/vibing/preview/snapshot", {
    method: "POST",
    body: JSON.stringify({ project }),
  }).catch(() => null);
  const hash = snap?.hash;
  if (!hash) return null;
  const buf = await api(`/vibing/preview/frames/${hash}`);
  try {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    if (!lastFramePath) lastFramePath = join(mkdtempSync(join(tmpdir(), "yaver-frame-")), "frame.png");
    writeFileSync(lastFramePath, Buffer.from(buf));
  } catch { /* persisting is a convenience for the oracle, never the verdict */ }
  const px = Array.from(new Uint8Array(buf));
  const triples = [];
  for (let i = 0; i + 2 < px.length; i += 3) triples.push([px[i], px[i + 1], px[i + 2]]);
  return triples.length ? classifyVibeColor(triples) : null;
}

async function waitForColor(want, project) {
  const deadline = Date.now() + BUDGET_MS;
  let last = "unknown";
  while (Date.now() < deadline) {
    last = (await frameColor(project).catch(() => null)) || last;
    if (last === want) return { ok: true, color: last };
    await sleep(20_000);
  }
  return { ok: false, color: last };
}

/**
 * THE TEXT ORACLE — why this arc can reach NAMED, not only PIXELS/SILENT.
 *
 * A colour verdict says the screen changed. It cannot say WHY a screen that did
 * not change is stuck: "expo server ready — loading page…", a runner refusal, a
 * sign-in wall and a blank preview are all just "black". On surfaces with a DOM
 * the harness reads the text; tvOS and visionOS have none, so until now their
 * only failing verdict was SILENT.
 *
 * Apple's Vision framework turns any FRAME into text on-device in ~500ms, free
 * and offline, which makes the ladder surface-agnostic instead of DOM-agnostic.
 * See docs/architecture/APPLE_VISION_TEXT_ORACLE.md.
 *
 * OPPORTUNISTIC, NEVER LOAD-BEARING (§4, the Linux non-regression contract):
 * macOS-only, and its absence must never fail an arc — it only ever ADDS a
 * reason to a failure the colour verdict already reached.
 */
async function readFrameText(pngPath) {
  if (process.platform !== "darwin") return null;
  const helper = new URL("../desktop/agent/screenread/screenread", import.meta.url).pathname;
  const { existsSync } = await import("node:fs");
  if (!existsSync(helper)) return null;
  try {
    const { execFileSync } = await import("node:child_process");
    const out = JSON.parse(execFileSync(helper, [pngPath], { encoding: "utf8", timeout: 30_000 }));
    return out.ok ? out.blocks.map((b) => b.text).join(" | ") : null;
  } catch {
    return null; // the oracle failing is not the product failing
  }
}

const log = (m) => console.log(`[${SURFACE}] ${m}`);
let failed = false;

try {
  const info = await api("/info");
  log(`box ok — agent ${info.version || "?"}`);

  log("booting the capture pipeline (web-preview → headless capture)…");
  const target = await startCapture(PROJECT);
  log(`capturing ${target || "(project default)"}`);

  log("starting the colour turn…");
  await startVibe(
    "Change the login screen so its VISIBLE background is red. Every container that paints " +
    "the full-screen background must be red, so the whole screen reads red. Only the login screen.",
  );
  const red = await waitForColor("red", PROJECT);
  log(`red: ${red.ok ? "PASS" : `FAIL (last ${red.color})`}`);
  if (!red.ok && lastFramePath) {
    // SILENT → NAMED: say what the screen was actually showing.
    const seen = await readFrameText(lastFramePath);
    if (seen) log(`the frame said: ${seen.slice(0, 300)}`);
  }
  failed ||= !red.ok;

  log("reverting as a SEPARATE task (the new-task render path, same as web)…");
  await startVibe("Revert the login screen background back to black.");
  const black = await waitForColor("black", PROJECT);
  log(`black: ${black.ok ? "PASS" : `FAIL (last ${black.color})`}`);
  failed ||= !black.ok;
} catch (err) {
  // Never report a green on a arc that did not run.
  console.error(`[${SURFACE}] ARC ERROR: ${err.message}`);
  failed = true;
}

console.log(failed ? `\n${SURFACE}: FAILED` : `\n${SURFACE}: ALL PASS`);
process.exit(failed ? 1 : 0);
