#!/usr/bin/env node
/**
 * native-headless-vibe.mjs — the tvOS / visionOS colour loop, HEADLESS.
 *
 *   YAVER_TEST_TOKEN=… npx tsx e2e/native-headless-vibe.mjs [tv|vision]
 *
 * (tsx, not node: it imports the SHARED classifier from web/lib/vibeVerdict.ts
 *  and the SHARED profile table from web/lib/surfaceViewports.ts, so the TV
 *  verdict and the browser verdict can never drift apart.)
 *
 * ── Why headless comes first (CLAUDE.md) ───────────────────────────────────
 *
 * "Headless first, then closed loop." This arc drives the EXACT endpoints the
 * native client calls — POST /tasks (AgentClient.createTask) and the
 * preview-frame flow — with no simulator, no XCUITest, no Xcode. It answers in
 * seconds whether the SERVER half of a TV/headset vibe works, so a later UI
 * failure can only be the UI.
 *
 * ── What it proves, in order ───────────────────────────────────────────────
 *
 *   0. the agent is new enough to have the fixes this arc needs   → NAMED skip
 *   0b. this box can ACTUALLY launch a capture browser            → NAMED skip
 *   1. the box answers and the session is valid                   (GET /info)
 *   2. a task can be CREATED the way the native client creates one
 *   3. the preview is RENDERING something, not an empty panel
 *   4. the frame the TV would show changes colour                 → PIXELS
 *   5. a SECOND task reverts it, and the frame goes back
 *
 * Step 4 is the honest part. tvOS has no browser, so its verdict is a STREAMED
 * FRAME — /vibing/preview/snapshot + /vibing/preview/frames/{hash}, the same
 * flow AgentClient already implements. visionOS could additionally use a real
 * WKWebView, but sharing this verdict keeps the two surfaces comparable.
 *
 * ── Three defects this file was rebuilt around (2026-08-03) ────────────────
 *
 * The arc had NEVER RUN, because the box could not launch a browser. When the
 * pixels path was finally read closely, it could not have passed even then:
 *
 *   1. It walked the COMPRESSED PNG three bytes at a time and called the
 *      result RGB. Every colour it produced was sampled from a zlib stream.
 *   2. It handed an array OF triples to `classifyVibeColor`, which takes a
 *      FLAT [r,g,b] — so the guard rejected it and returned "unknown" for
 *      every frame, forever. A 12-minute budget spent to print a confident,
 *      structurally impossible failure.
 *   3. It never asked whether the box COULD capture. The agent already knew —
 *      /project/preview-capabilities?probe=true said "chromium is on PATH but
 *      failed to launch" — and the arc waited 12 minutes for a frame that
 *      could never arrive, then blamed the colour.
 *
 * (1) and (2) are fixed by e2e/_framePixels.mjs, which decodes for real and is
 * round-tripped against known pixels. (3) is fixed by the preflight below.
 * A test that is wrong in the direction of FAILURE is not harmless — it sends
 * real investigations after systems that work.
 *
 * NOT a substitute for the UI arc. It cannot see a layout, a stuck spinner, or
 * a control that does not exist — which is exactly why the phased plan puts the
 * simulator loop after it, never instead of it.
 */
import { classifyVibeColor, looksRendered, modalColor, samplePoints, verdictFor } from "../web/lib/vibeVerdict.ts";
import { profileFor } from "../web/lib/surfaceViewports.ts";
import { decodePng, samplePixels } from "./_framePixels.mjs";
import * as oracle from "./_visionOracle.mjs";

const SURFACE = (process.argv[2] || "tv").toLowerCase();
const TOKEN = process.env.YAVER_TEST_TOKEN || "";
// The box address has NO DEFAULT, deliberately.
//
// It used to fall back to one machine's tailnet IP. That is the single-user bug
// CLAUDE.md forbids wearing a test's clothes: every arc silently targeted one
// person's box, so anyone else's run measured a machine they do not own, and a
// real overlay address sat in a PUBLIC repo. Unset is unset — say so and skip.
const BOX = process.env.VIBE_BOX_HOST || "";
const WORKDIR = process.env.VIBE_PROJECT_PATH || "/root/Workspace/yaver.io/mobile";
const PROJECT = process.env.VIBE_PROJECT_NAME || "mobile";
const BUDGET_MS = Number(process.env.VIBE_BUDGET_MS || 12 * 60_000);

/**
 * The oldest agent that can pass this arc.
 *
 * 1.99.400 carries the launch-PROBING Chrome resolver. Before it, a box whose
 * `chromium` is a confined snap could not capture a single frame even when a
 * working /usr/bin/google-chrome sat right next to it — so the arc failed for
 * an agent reason and said "the colour never changed", which is a lie about
 * where the fault is.
 *
 * Asserting this is the cheapest fix in the whole session: on 2026-08-02 the
 * tvOS arc ran against 1.99.397, failed on a bug fixed in 1.99.399, and
 * NOTHING in the output said the box was stale. One GET turns a confusing red
 * into a named skip with the exact command that fixes it.
 */
const MIN_AGENT_VERSION = process.env.VIBE_MIN_AGENT_VERSION || "1.99.400";

/**
 * Surfaces this arc can drive, and what a frame-capture verdict DOES and DOES
 * NOT prove for each.
 *
 * Being explicit here matters more than it looks. A frame captured from the
 * box's headless browser at a surface's geometry proves the SERVER half — the
 * runner edited the code, the dev server rebuilt, and the render pipeline
 * produced those pixels at that size. It proves nothing about the native app:
 * not its layout, not its focus engine, not whether the control you need even
 * exists. Letting this arc quietly accept a surface it cannot honestly speak
 * for is how a suite starts reporting green about something it never tested.
 *
 * web / mobile / tablet are deliberately ABSENT: they have a real DOM and a
 * real driveable app, so they belong to e2e/tests/vibe-color-loop.spec.ts,
 * which drives them in a true device context. Substituting a frame capture
 * there would be strictly worse evidence.
 */
const FRAME_CAPTURE_SURFACES = {
  tv: "tvOS has no browser at all, so a streamed frame is its ONLY pixel evidence.",
  vision: "visionOS could use a WKWebView, but sharing the TV verdict keeps the two comparable.",
  watch: "watchOS/Wear render a companion view; this proves the render half at watch geometry, NOT the native watch UI.",
};

if (!FRAME_CAPTURE_SURFACES[SURFACE]) {
  const domSurfaces = ["web", "mobile", "tablet"];
  if (domSurfaces.includes(SURFACE)) {
    console.log(
      `SKIP: "${SURFACE}" has a real DOM and a driveable app — it belongs to\n` +
      `      e2e/tests/vibe-color-loop.spec.ts, which drives it in a true device\n` +
      `      context. A frame capture would be weaker evidence for the same claim.`,
    );
    process.exit(0);
  }
  console.log(`SKIP: unknown surface "${SURFACE}" — use one of: ${Object.keys(FRAME_CAPTURE_SURFACES).join(", ")}`);
  process.exit(0);
}
if (!TOKEN) {
  // An environment gap is not a product defect — say so and skip, exactly as
  // the browser arcs do, so a fresh checkout never cries wolf.
  console.log("SKIP: set YAVER_TEST_TOKEN (a session token for the box's owner)");
  process.exit(0);
}

const PROFILE = profileFor(SURFACE);
const h = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${SURFACE}] ${m}`);

async function api(path, init = {}) {
  const res = await fetch(`${BOX}${path}`, { ...init, headers: { ...h, ...(init.headers || {}) } });
  if (!res.ok) {
    // Carry the BODY into the error. "HTTP 400" sent a previous session
    // hunting; "HTTP 400: chrome failed to start: cannot create temporary
    // directory" names the fix in the same breath.
    const body = await res.text().catch(() => "");
    throw new Error(`${init.method || "GET"} ${path} → HTTP ${res.status}${body ? `: ${body.slice(0, 400)}` : ""}`);
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.arrayBuffer();
}

/** Compare dotted versions without pulling in semver. */
function versionAtLeast(have, want) {
  const a = String(have).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const b = String(want).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

/**
 * NAMED skip — the arc did not run, and it says exactly why and what fixes it.
 *
 * Deliberately exit 0. A skip is not a product failure, and reporting one as
 * red is how a suite trains its readers to ignore it.
 */
function skip(reason, remedy) {
  console.log(`\n[${SURFACE}] SKIP — ${reason}`);
  if (remedy) console.log(`[${SURFACE}] fix: ${remedy}`);
  console.log(`\n${SURFACE}: SKIPPED (NAMED)`);
  process.exit(0);
}

if (!BOX) {
  skip("set VIBE_BOX_HOST (e.g. http://<your-box>:18080)",
    "yaver devices — then use that machine's reachable address");
}

/** Step 0b — can this box actually capture? Ask the agent, do not find out in 12 minutes. */
async function preflightCapture() {
  const caps = await api(
    `/project/preview-capabilities?workDir=${encodeURIComponent(WORKDIR)}&probe=true`,
  ).catch((err) => {
    // An older agent has no such route. Not fatal: fall through and let the
    // capture start speak for itself. Never turn a missing diagnostic into a
    // failure.
    log(`(preview-capabilities unavailable: ${err.message.slice(0, 120)})`);
    return null;
  });
  if (!caps?.options) return null;

  const streaming = caps.options.find((o) => o.id === "remote-runtime");
  const devServer = caps.options.find((o) => o.id === "dev-server");
  log(`framework ${caps.framework || "?"} · dev-server ${devServer?.supported ? "yes" : "no"} · streaming ${streaming?.supported ? "yes" : "no"}`);

  // The BROWSER is what this arc needs — it captures frames through headless
  // Chrome regardless of which option a user would pick in the UI. If the
  // agent has already probed it as unlaunchable, stop here.
  if (streaming && !streaming.supported && /launch|chrome|chromium|browser/i.test(streaming.reason || "")) {
    skip(
      `the box cannot launch a capture browser, so no frame can exist: ${streaming.reason}`,
      "install an unconfined Chrome on the box: `apt-get install -y google-chrome-stable`",
    );
  }
  return caps;
}

/**
 * Boot the capture pipeline. PROBED, not guessed: a first draft polled GET
 * /vibing/preview/snapshot and got {"error":"method not allowed"}, while
 * /vibing/preview/status reported sessions: [] — nothing was capturing at all.
 * The authoritative shape is tvOS AgentClient's own flow:
 *
 *   POST /dev/web-preview/start   → boot the static server for the project
 *   POST /vibing/preview/start    → headless Chrome starts capturing it
 *   POST /vibing/preview/snapshot → newest frame's hash   (POST, not GET)
 *   GET  /vibing/preview/frames/{hash} → the bytes
 */
async function startCapture(project) {
  const boot = await api("/dev/web-preview/start", { method: "POST", body: "{}" }).catch(() => ({}));

  // RESOLVE THE **WEB** PORT. It is not devServer.port.
  //
  // `POST /dev/start {devMode:"web"}` builds a HYBRID: metro (dev-client) on
  // one port and `expo start --web` on ANOTHER. Measured on ubuntu-4gb,
  // 2026-08-03:
  //
  //     /info.devServer  kind=hybrid  devMode=dev-client
  //                      port=8081     ← metro; NOTHING was listening on it
  //                      webPort=19006 ← the web server, HTTP 200
  //     /dev/web-preview/start → {"port":19006,"webUrl":"/dev-web/"}
  //
  // An earlier version of this function preferred `devServer.port` and wrote a
  // confident comment explaining that `boot.port` was "Expo Web's canonical
  // 19006, not the port this server actually bound". That was backwards.
  // 19006 IS what expo-web bound; 8081 is metro. It passed once only because
  // that run happened to serve web from the metro port, and it then failed
  // twice with net::ERR_CONNECTION_REFUSED — the arc aiming a browser at a
  // port with nothing behind it. Inferred, not measured; this comment is the
  // measurement.
  //
  // Order: the web-preview boot response (it just started that server and
  // knows its port) → devServer.webPort → devServer.port for non-hybrid
  // frameworks that serve web directly. `webUrl` is AGENT-RELATIVE (a proxy
  // path) and chromedp cannot navigate it — "Cannot navigate to invalid URL
  // (-32000)" — so it is only used when it is absolute.
  //
  // Capture runs ON the box, hence 127.0.0.1.
  const info = await api("/info").catch(() => ({}));
  const ds = info?.devServer || {};
  let targetUrl = "";
  if (boot.port) targetUrl = `http://127.0.0.1:${boot.port}`;
  else if (ds.webPort) targetUrl = `http://127.0.0.1:${ds.webPort}`;
  else if (boot.webUrl && /^https?:\/\//i.test(boot.webUrl)) targetUrl = boot.webUrl;
  else if (ds.port) targetUrl = `http://127.0.0.1:${ds.port}`;

  if (!targetUrl) {
    skip(
      "no dev server port could be resolved — /info reported no devServer.port and " +
      `/dev/web-preview/start returned ${JSON.stringify(boot)}`,
      "start one first: POST /dev/start {\"framework\":\"expo\",\"workDir\":\"…\",\"devMode\":\"web\"}",
    );
  }

  // Idempotence: the manager refuses a second session for the same project, and
  // a previous aborted run leaves one behind. Stopping first makes the arc
  // re-runnable, which matters more here than anywhere — each attempt costs 12
  // minutes and a runner turn.
  await api("/vibing/preview/stop", { method: "POST", body: JSON.stringify({ project }) }).catch(() => null);

  // The viewport comes from the SHARED surface table, never a literal. A TV
  // captured at phone size is a layout no TV user ever sees.
  await api("/vibing/preview/start", {
    method: "POST",
    body: JSON.stringify({
      project,
      targetUrl,
      mode: "live",
      width: PROFILE.width,
      height: PROFILE.height,
    }),
  });
  return targetUrl;
}

/**
 * ARTIFACTS — a 25-minute run that leaves nothing behind is not reviewable.
 *
 * The browser arcs already keep video + trace ON PASS, into
 * `e2e/test-results/loops/<runId>/`, grouped by LOOP_RUN_ID — and they keep it
 * for passes precisely because on a pixel verdict the footage IS the evidence
 * (playwright.loops.config.ts; artifacts were being deleted by the next run
 * until aa93ff76b).
 *
 * This arc kept ONE frame, in a temp dir, and only so the oracle could read it
 * on failure. A passing tvOS run — the thing everyone wants to see — left
 * nothing at all. Same convention now applies here: every sampled frame, a
 * manifest of the timeline, and a timelapse when ffmpeg is around.
 *
 * The frames are the evidence; the video is a convenience. If ffmpeg is
 * missing, the run says so and the frames still stand on their own — an
 * optional encoder must never be the reason a result is unreviewable.
 */
const RUN_ID = process.env.LOOP_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = new URL(`./test-results/loops/${RUN_ID}/${SURFACE}/`, import.meta.url).pathname;

let frameSeq = 0;
const frameTimeline = [];

// The newest frame, kept on disk so the text oracle can read the SAME pixels the
// colour verdict judged. Reading a different capture would let the two disagree
// about what was on screen, which is worse than having no text at all.
let lastFramePath = "";

/**
 * Step 4 — the frame a TV would be rendering, as REAL pixels.
 *
 * Decodes the PNG, samples the same grid the web arc samples through a canvas,
 * and returns the modal colour plus whether anything was rendered at all. A
 * blank panel and a black login screen are identical to a sampler, so
 * `rendered` is what stops an empty preview from agreeing with the assertion.
 */
async function frameState(project) {
  const snap = await api("/vibing/preview/snapshot", {
    method: "POST",
    body: JSON.stringify({ project }),
  }).catch(() => null);
  const hash = snap?.hash;
  if (!hash) return null;

  // ?project= is REQUIRED — frames are project-scoped on disk. Without it the
  // endpoint returns {"error":"project query param required"} with HTTP 200-
  // shaped JSON, which the old byte-walking sampler would have happily
  // classified as a colour. The decoder refuses it by name instead; this is
  // that guard paying for itself on its first real capture.
  const buf = await api(`/vibing/preview/frames/${hash}?project=${encodeURIComponent(project)}`);
  // savedFile is per-iteration, NOT derived from lastFramePath at manifest time.
  // If a write fails, lastFramePath still points at the PREVIOUS frame, and a
  // manifest row that names a file holding different pixels is worse than a row
  // with no file at all — it is a record that quietly lies about the evidence.
  let savedFile = null;
  try {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(RUN_DIR, { recursive: true });
    // Every sampled frame, numbered so the sequence is the story. lastFramePath
    // points at the newest so the oracle reads exactly what the verdict judged.
    const name = `${String(++frameSeq).padStart(4, "0")}.png`;
    const path = join(RUN_DIR, name);
    writeFileSync(path, Buffer.from(buf));
    lastFramePath = path;
    savedFile = name;
  } catch { /* persisting is a convenience, never the verdict */ }

  let img;
  try {
    img = decodePng(buf);
  } catch (err) {
    // Never guess a pixel. A frame we cannot decode is a NAMED failure, not a
    // colour — this is the guard that makes defect (1) above unrepeatable.
    return { color: "unknown", rendered: false, decodeError: err.message };
  }
  const samples = samplePixels(img, samplePoints, 8);
  // A digest of the actual bytes, so "has the picture changed at all?" is a
  // question the arc can answer. See waitForColor: a frozen frame is a signal,
  // not something to sit through for twelve minutes.
  const { createHash } = await import("node:crypto");
  const state = {
    color: classifyVibeColor(modalColor(samples)),
    rendered: looksRendered(samples),
    width: img.width,
    height: img.height,
    size: `${img.width}x${img.height}`,
    samples: samples.length,
    digest: createHash("sha1").update(Buffer.from(buf)).digest("hex").slice(0, 12),
  };
  frameTimeline.push({
    seq: frameSeq,
    at: new Date().toISOString(),
    file: savedFile,
    color: state.color,
    rendered: state.rendered,
    size: state.size,
  });
  return state;
}

/**
 * How many consecutive identical frames mean "this preview is not re-rendering".
 *
 * Polls are 20s apart, so 9 is three minutes of a genuinely frozen picture.
 * Generous on purpose: a slow runner turn legitimately leaves the screen
 * unchanged for a while, and calling that a failure would be the false-red this
 * suite exists to remove. What it catches is the OTHER thing — a dead target.
 *
 * Measured 2026-08-03: a visionOS run captured 37 frames across twelve minutes
 * with only TWO distinct images, because the expo web server had exited
 * mid-run. The browser kept screenshotting a stale render, the arc kept
 * sampling it, and the verdict blamed the colour. Twelve minutes to learn
 * nothing. Three minutes to learn the truth is a better trade.
 */
const FROZEN_FRAME_POLLS = 9;

async function waitForColor(want, project) {
  const deadline = Date.now() + BUDGET_MS;
  let last = null;
  let lastDigest = "";
  let frozenFor = 0;
  while (Date.now() < deadline) {
    const s = await frameState(project).catch((err) => ({ color: "unknown", rendered: false, decodeError: err.message }));
    if (s) last = s;
    if (s?.color === want && s.rendered) return { ok: true, state: s };
    // A frame that reaches the target colour but does NOT look rendered is the
    // empty-panel case. Say so rather than accepting it: an empty black
    // rectangle agreeing with "black" is how this suite once passed on nothing.
    if (s?.color === want && !s.rendered) {
      log(`frame is ${want} but shows only one colour — that is an empty panel, not a rendered app`);
    }

    // FROZEN-FRAME DETECTION. Bail out with a NAMED cause instead of spending
    // the rest of the budget photographing the same stale pixels.
    if (s?.digest) {
      if (s.digest === lastDigest) {
        frozenFor++;
        if (frozenFor >= FROZEN_FRAME_POLLS) {
          const mins = Math.round((frozenFor * 20) / 60);
          return {
            ok: false,
            state: s,
            frozen: `the captured frame has not changed at all for ~${mins} minutes ` +
              `(${frozenFor} identical samples, digest ${s.digest}) — the preview is not re-rendering. ` +
              `The usual cause is the dev server having exited mid-run; restart it and check the box for OOM kills.`,
          };
        }
      } else {
        frozenFor = 0;
        lastDigest = s.digest;
      }
    }
    await sleep(20_000);
  }
  return { ok: false, state: last };
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
 * SILENT → NAMED. Every failure asks the frame what it was showing.
 *
 * Previously only the red step consulted the oracle, so a failed REVERT — the
 * step that exercises the new-task render path, and therefore the one most
 * likely to break — reported a bare colour with no cause.
 */
function explainFailure(state, frozen) {
  const bits = [];
  // The frozen-frame fact comes FIRST when present: it is a stronger and more
  // actionable statement than anything read off a stale picture, and it names
  // the thing to go fix.
  if (frozen) bits.push(frozen);
  if (state?.decodeError) bits.push(`the frame could not be decoded: ${state.decodeError}`);
  else if (state && !state.rendered) bits.push("the preview showed a single flat colour — an empty panel, not a rendered app");
  // "signed-out" is EXPECTED here: this arc vibes the LOGIN SCREEN's background,
  // so the sign-in screen is the subject under test, not a fault. Without this
  // the oracle names a failing run "the session did not reach the surface",
  // which is true of the pixels and false about the problem.
  const seen = lastFramePath ? oracle.explainFrame(lastFramePath, { expected: ["signed-out"] }) : null;
  if (seen) bits.push(seen.reason);
  return bits.join("; ");
}

let reachedTarget = false;
let reverted = false;
let reason = "";

try {
  // ── Step 0: is the agent new enough? ─────────────────────────────────────
  const info = await api("/info");
  const agentVersion = info.version || "";
  log(`box ok — agent ${agentVersion || "?"} on ${info.hostname || "?"} · capturing at ${PROFILE.width}x${PROFILE.height}`);
  // State the SCOPE every run, not just in a comment nobody opens. A reader
  // skimming a green result should see what it did and did not cover.
  log(`scope: ${FRAME_CAPTURE_SURFACES[SURFACE]}`);
  if (agentVersion && !versionAtLeast(agentVersion, MIN_AGENT_VERSION)) {
    skip(
      `the box runs agent ${agentVersion}, and this arc needs ${MIN_AGENT_VERSION} or newer ` +
      `(older agents cannot pick a launchable Chrome, so no frame can be captured)`,
      `yaver ssh <box> 'npm i -g yaver-cli@latest && sudo systemctl restart yaver'`,
    );
  }

  const o = oracle.available();
  log(o.ok ? "text oracle: ready" : `text oracle: unavailable — ${o.reason.split("\n")[0]}`);

  // ── Step 0b: can this box capture at all? ────────────────────────────────
  await preflightCapture();

  log("booting the capture pipeline (web-preview → headless capture)…");
  const target = await startCapture(PROJECT);
  log(`capturing ${target || "(project default)"}`);

  // ── Step 3: is anything rendering BEFORE we judge a colour? ──────────────
  // Establishing this first is what separates "the vibe did not work" from
  // "there was never a picture". Without it, a dead preview and a failed edit
  // are the same black rectangle.
  let baseline = null;
  for (let i = 0; i < 6 && !baseline?.rendered; i++) {
    baseline = await frameState(PROJECT).catch(() => null);
    if (!baseline?.rendered) await sleep(10_000);
  }
  if (!baseline) {
    reason = `no frame was ever captured. ${explainFailure(null) || "the capture session produced nothing"}`;
    throw new Error(reason);
  }
  log(`baseline frame ${baseline.size || "?"} · ${baseline.samples || 0} samples · ${baseline.color} · rendered=${baseline.rendered}`);
  if (!baseline.rendered) {
    reason = `the preview never rendered the app. ${explainFailure(baseline)}`;
    throw new Error(reason);
  }

  // ── ASSERT THE VIEWPORT WE ACTUALLY GOT ──────────────────────────────────
  //
  // CLAUDE.md's closed-loop rule says to assert the viewport INSIDE the arc,
  // "so a context that silently came back desktop-shaped fails loudly instead
  // of passing quietly". That was written for Playwright contexts; it applies
  // just as hard to a captured frame, and nothing was checking it.
  //
  // What it caught immediately, 2026-08-03: this arc requested 1920x1080,
  // /vibing/preview/status reported 1920x1080, and the frame arrived 1280x757
  // — the agent stored the size, echoed it back, and opened Chrome at a
  // hardcoded 1280x900. Every TV/visionOS verdict was being reached against a
  // desktop-shaped layout while the log said otherwise.
  //
  // Height gets a wider tolerance than width because a real browser viewport
  // is shorter than the window by whatever chrome it draws; width has no such
  // excuse.
  if (baseline.width && baseline.height) {
    const dw = Math.abs(baseline.width - PROFILE.width);
    const dh = Math.abs(baseline.height - PROFILE.height);
    if (dw > 40 || dh > 160) {
      reason =
        `the frame came back ${baseline.width}x${baseline.height}, but this arc drives the ` +
        `${SURFACE} surface at ${PROFILE.width}x${PROFILE.height}. A verdict reached at the ` +
        `wrong size is about a layout no ${SURFACE} user ever sees.`;
      throw new Error(reason);
    }
  }

  // ── Step 4: the colour turn ──────────────────────────────────────────────
  log("starting the colour turn…");
  await startVibe(
    "Change the login screen so its VISIBLE background is red. Every container that paints " +
    "the full-screen background must be red, so the whole screen reads red. Only the login screen.",
  );
  const red = await waitForColor("red", PROJECT);
  reachedTarget = red.ok;
  log(`red: ${red.ok ? "PASS" : `FAIL (last ${red.state?.color ?? "no frame"})`}`);
  if (!red.ok) reason = `the preview never turned red (last ${red.state?.color ?? "no frame"}). ${explainFailure(red.state, red.frozen)}`;

  // ── Step 5: revert, as a SEPARATE task (the new-task render path) ────────
  if (red.ok) {
    log("reverting as a SEPARATE task (the new-task render path, same as web)…");
    await startVibe("Revert the login screen background back to black.");
    const black = await waitForColor("black", PROJECT);
    reverted = black.ok;
    log(`black: ${black.ok ? "PASS" : `FAIL (last ${black.state?.color ?? "no frame"})`}`);
    if (!black.ok) reason = `the revert never landed (last ${black.state?.color ?? "no frame"}). ${explainFailure(black.state, black.frozen)}`;
  }
} catch (err) {
  // Never report a green on an arc that did not run.
  if (!reason) reason = err.message;
  console.error(`[${SURFACE}] ARC ERROR: ${err.message}`);
}

// PIXELS is the only pass; SILENT — a failure with no stated cause — is the only
// verdict that means the harness itself let us down.
const { verdict, reason: verdictReason } = verdictFor({ reachedTarget, reverted, reason });

await writeRunArtifacts(verdict, verdictReason);

console.log(`\n${SURFACE}: ${verdict} — ${verdictReason}`);
process.exit(verdict === "PIXELS" ? 0 : 1);

/**
 * Write the manifest and, when ffmpeg is available, a timelapse.
 *
 * Runs on PASS as well as failure. On a pixel verdict the footage is the
 * evidence — "it went red then black" is a claim until someone can watch it.
 */
async function writeRunArtifacts(verdict, verdictReason) {
  if (!frameTimeline.length) return;
  try {
    const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(RUN_DIR, { recursive: true });

    writeFileSync(
      join(RUN_DIR, "manifest.json"),
      JSON.stringify(
        {
          surface: SURFACE,
          runId: RUN_ID,
          box: BOX,
          project: PROJECT,
          profile: { width: PROFILE.width, height: PROFILE.height, why: PROFILE.why },
          verdict,
          reason: verdictReason,
          frames: frameTimeline,
        },
        null,
        2,
      ),
    );

    // A timelapse, not a real-time video: frames arrive every ~20s over up to
    // 24 minutes, so 4 fps turns the whole arc into a few seconds you can
    // actually watch. -pix_fmt yuv420p because without it the MP4 will not play
    // in QuickTime or a browser <video>, which would make the artifact useless
    // on exactly the surfaces people review from.
    const { execFileSync } = await import("node:child_process");
    let ffmpeg = "";
    for (const c of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
      if (existsSync(c)) { ffmpeg = c; break; }
    }
    if (!ffmpeg) {
      console.log(`[${SURFACE}] artifacts: ${RUN_DIR} (${frameTimeline.length} frames + manifest.json)`);
      console.log(`[${SURFACE}] no ffmpeg — install it for a timelapse; the frames are the evidence either way`);
      return;
    }
    const mp4 = join(RUN_DIR, "timelapse.mp4");
    execFileSync(ffmpeg, [
      "-y", "-loglevel", "error",
      "-framerate", "4",
      "-pattern_type", "glob", "-i", join(RUN_DIR, "*.png"),
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", // h264 needs even dimensions
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      mp4,
    ], { timeout: 120_000 });
    console.log(`[${SURFACE}] artifacts: ${RUN_DIR}`);
    console.log(`[${SURFACE}]   ${frameTimeline.length} frames · manifest.json · timelapse.mp4`);
  } catch (err) {
    // An artifact failure must never change a verdict.
    console.log(`[${SURFACE}] (artifacts partially written: ${err.message.slice(0, 120)})`);
  }
}
