#!/usr/bin/env node
/**
 * Preservation-safe SFMG colour loop on an owned remote Yaver box.
 *
 * The source checkout may contain the developer's uncommitted work. This arc
 * therefore creates a disposable detached Git worktree, symlinks the existing
 * node_modules into it, runs the OpenCode task there, proves the colour through
 * the lightweight multi-surface browser renderer, then removes only that exact
 * validated worktree. It never runs `git checkout -- .` on the source repo.
 *
 *   npx tsx e2e/lightweight-sfmg-color-loop.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const runID = (process.env.LOOP_RUN_ID || now()).replace(/[:.]/g, "-");
const targetColor = String(process.env.VIBE_TARGET_COLOR || "#D32F2F").toUpperCase();
const runner = process.env.TASK_RUNNER || "opencode";
const wantedDevice = process.env.VIBE_BOX || "ubuntu-4gb-hel1-1";
const wantedProject = process.env.VIBE_PROJECT_NAME || "sfmg";
const surfaces = process.env.VIBE_SURFACES || "web,mobile,tablet,tv,vision,watch";
const artifacts = path.resolve(
  process.env.VIBE_ARTIFACT_DIR ||
    path.join("e2e", "test-results", "lightweight-color", runID),
);

if (!/^#[0-9A-F]{6}$/.test(targetColor)) {
  throw new Error(`VIBE_TARGET_COLOR must be #RRGGBB; got ${JSON.stringify(targetColor)}`);
}

const configPath = path.join(os.homedir(), ".yaver", "config.json");
if (!fs.existsSync(configPath)) throw new Error(`NAMED: ${configPath} is missing`);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const token = String(process.env.YAVER_TEST_TOKEN || config.auth_token || "").trim();
const relayPassword = String(config.cached_relay_password || config.relay_password || "").trim();
const convex = String(
  process.env.YAVER_CONVEX_SITE ||
    config.convex_site_url ||
    "https://perceptive-minnow-557.eu-west-1.convex.site",
).replace(/\/$/, "");
const relay = String(process.env.YAVER_RELAY_HTTP || "https://public.yaver.io").replace(/\/$/, "");
if (!token || !relayPassword) throw new Error("NAMED: signed-in Yaver credentials are incomplete");

function redact(value) {
  return String(value || "")
    .split(token).join("<token>")
    .split(relayPassword).join("<relay-password>")
    .replace(/([?&](?:token|__rp)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi, "$1<redacted>");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { response, body, text };
}

async function resolveDeviceID() {
  if (process.env.VIBE_DEVICE_ID) return process.env.VIBE_DEVICE_ID.trim();
  const { response, body, text } = await jsonFetch(`${convex}/devices/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`NAMED: /devices/list returned HTTP ${response.status}: ${redact(text).slice(0, 300)}`);
  }
  const rows = Array.isArray(body) ? body : body?.devices || body?.data || [];
  const needle = wantedDevice.toLowerCase();
  const matches = rows.filter((row) =>
    String(row.name || row.hostname || "").toLowerCase().includes(needle));
  if (matches.length !== 1) {
    throw new Error(`NAMED: ${JSON.stringify(wantedDevice)} matched ${matches.length} owned devices`);
  }
  return String(matches[0].deviceId || matches[0].id || matches[0]._id || "");
}

const deviceID = await resolveDeviceID();
if (!deviceID) throw new Error("NAMED: resolved device has no id");
const baseURL = `${relay}/d/${deviceID}`;
const headers = {
  Authorization: `Bearer ${token}`,
  "X-Relay-Password": relayPassword,
  "Content-Type": "application/json",
};

async function agent(pathname, init = {}) {
  const { response, body, text } = await jsonFetch(`${baseURL}${pathname}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  return { status: response.status, ok: response.ok, body, text };
}

async function resolveSourcePath() {
  const explicit = String(process.env.VIBE_PROJECT_PATH || "").trim();
  if (explicit) return explicit;
  const listed = await agent("/projects");
  if (!listed.ok) throw new Error(`NAMED: /projects returned HTTP ${listed.status}`);
  const rows = Array.isArray(listed.body) ? listed.body : listed.body?.projects || [];
  const matches = rows.filter((row) =>
    String(row.name || "").toLowerCase() === wantedProject.toLowerCase());
  if (matches.length !== 1 || !matches[0].path) {
    throw new Error(`NAMED: ${JSON.stringify(wantedProject)} resolved to ${matches.length} project rows`);
  }
  return String(matches[0].path);
}

async function remoteExec(command, timeoutSec = 120) {
  const started = await agent("/exec", {
    method: "POST",
    body: JSON.stringify({ command, timeoutSec }),
  });
  const execID = started.body?.execId;
  if (!started.ok || !execID) {
    throw new Error(`NAMED: remote exec start returned HTTP ${started.status}: ${redact(started.text).slice(0, 300)}`);
  }
  const deadline = Date.now() + (timeoutSec + 15) * 1_000;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const polled = await agent(`/exec/${execID}`);
    const row = polled.body?.exec || polled.body || {};
    if (["completed", "failed", "cancelled"].includes(row.status)) {
      if (row.status !== "completed" || Number(row.exitCode) !== 0) {
        throw new Error(
          `NAMED: remote command ${row.status} exit=${row.exitCode}: ` +
          redact(row.stderr || row.stdout || "no output").slice(-1_000),
        );
      }
      return String(row.stdout || "");
    }
  }
  throw new Error(`NAMED: remote command did not finish within ${timeoutSec + 15}s`);
}

const sourcePath = await resolveSourcePath();
const terminalTaskStatuses = new Set(["completed", "review", "failed", "cancelled", "stopped"]);
let activeTaskID = "";

async function sourceFingerprint() {
  return (await remoteExec(
    `git -C ${shellQuote(sourcePath)} status --porcelain=v1 | sha256sum; ` +
    `git -C ${shellQuote(sourcePath)} diff --no-ext-diff --binary | sha256sum`,
    30,
  )).trim();
}

async function createDisposableWorktree() {
  const command =
    `parent=$(mktemp -d /tmp/yaver-sfmg-surface-XXXXXX) && ` +
    `worktree="$parent/worktree" && ` +
    `git -C ${shellQuote(sourcePath)} worktree add --detach "$worktree" HEAD >/dev/null && ` +
    // Seed from the tree the user is actually developing, not pristine HEAD.
    // The source currently carries legitimate uncommitted product work and a
    // ready web export; testing HEAD instead produced an HTML shell whose root
    // never mounted. Secrets, dependencies and runtime harness caches stay out.
    `rsync -a ` +
    `--exclude=.git --exclude=node_modules --exclude=keys --exclude=.expo ` +
    `--exclude=.yaver-webrtc-harness ` +
    `${shellQuote(sourcePath + "/")} "$worktree/" && ` +
    // Metro/Expo follows a real node_modules tree more reliably than a root
    // symlink. Hard-link the files on the same filesystem: dependency bytes
    // are not duplicated, but resolution and file watching see normal paths.
    `cp -al ${shellQuote(path.join(sourcePath, "node_modules"))} "$worktree/node_modules" && ` +
    `printf '%s\\n%s\\n' "$parent" "$worktree"`;
  const lines = (await remoteExec(command, 120)).trim().split("\n");
  const parent = lines.at(-2) || "";
  const worktree = lines.at(-1) || "";
  if (!/^\/tmp\/yaver-sfmg-surface-[A-Za-z0-9]+$/.test(parent) || worktree !== `${parent}/worktree`) {
    throw new Error(`NAMED: refusing unvalidated disposable paths: ${redact(lines.join(" | "))}`);
  }
  return { parent, worktree };
}

async function captureTaskStream(taskID, controller, frames, streamState) {
  try {
    const response = await fetch(`${baseURL}/tasks/${taskID}/output?rawSince=0`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      frames.push({ at: now(), type: "stream_error", status: response.status });
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const parsed = JSON.parse(line.slice(6));
            frames.push({ at: now(), ...parsed });
            if (parsed?.type === "done" && parsed.status) {
              streamState.doneStatus = String(parsed.status);
              streamState.doneAt = now();
            }
          } catch {
            frames.push({ at: now(), type: "stream_parse_error", text: redact(line).slice(0, 500) });
          }
        }
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") {
      frames.push({ at: now(), type: "stream_error", error: redact(error?.message || error) });
    }
  }
}

function writeTaskArtifacts(taskID, task, frames, streamState) {
  const cleanedFrames = frames.map((frame) => {
    const copy = { ...frame };
    for (const key of ["text", "output", "error", "message"]) {
      if (copy[key] != null) copy[key] = redact(copy[key]);
    }
    return copy;
  });
  fs.writeFileSync(
    path.join(artifacts, "task.events.jsonl"),
    cleanedFrames.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
  );
  fs.writeFileSync(path.join(artifacts, "task.json"), JSON.stringify({
    taskID,
    status: task?.status || streamState.doneStatus || null,
    statusSource: task?.status ? "poll" : streamState.doneStatus ? "sse" : null,
    runner: task?.runnerId || task?.runnerID || task?.runner || runner,
    model: task?.model || null,
    failure: task?.failure || null,
    streamDoneStatus: streamState.doneStatus || null,
    streamDoneAt: streamState.doneAt || null,
    eventTypes: Object.fromEntries(
      [...new Set(cleanedFrames.map((frame) => frame.type || "unknown"))]
        .map((type) => [type, cleanedFrames.filter((frame) => (frame.type || "unknown") === type).length]),
    ),
  }, null, 2));
}

async function fetchTaskBounded(taskID, timeoutMs = 10_000) {
  return agent(`/tasks/${taskID}`, { signal: AbortSignal.timeout(timeoutMs) });
}

async function runColorTask(worktree) {
  const prompt =
    `In the SFMG repo at ${worktree}, change the CURRENTLY VISIBLE "Choose Your Language" / ` +
    `"Dil Seçimi" screen so its entire visible full-screen background is EXACTLY ${targetColor}. ` +
    `Every full-screen container that paints over the background must use ${targetColor}, including ` +
    `the navigator/root/web page behind any max-width language card. At wide browser geometries, a ` +
    `red phone-sized card centered on a black page FAILS: the outer viewport and all four corners must ` +
    `also be ${targetColor}. Acceptance is a dense pixel grid whose dominant color is ${targetColor} ` +
    `at widths 393, 834, 1024, 1280 and 1440 (phone, tablet, TV, vision and web geometries). ` +
    `Change only what is needed for that visible background. Do not commit, push, install dependencies, ` +
    `start a dev server, or edit outside ${worktree}.`;
  const created = await agent("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: `e2e: SFMG visible background ${targetColor}`,
      description: prompt,
      userPrompt: prompt,
      runner,
      mode: "build",
      workDir: worktree,
      source: "e2e-lightweight-surface",
      includeYaverMcp: false,
      askFreely: false,
    }),
  });
  const taskID = created.body?.taskId || created.body?.id || created.body?.task?.id;
  if (!created.ok || !taskID) {
    throw new Error(`NAMED: task creation returned HTTP ${created.status}: ${redact(created.text).slice(0, 500)}`);
  }
  activeTaskID = String(taskID);
  console.log(`task ${taskID} created on ${wantedDevice} with ${runner}`);

  const frames = [];
  const streamState = { doneStatus: "", doneAt: "" };
  const streamController = new AbortController();
  const stream = captureTaskStream(taskID, streamController, frames, streamState);
  const deadline = Date.now() + Number(process.env.VIBE_TASK_BUDGET_MS || 12 * 60_000);
  let task = null;
  let lastStatus = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetchTaskBounded(taskID);
      if (response.body?.task) task = response.body.task;
    } catch (error) {
      frames.push({ at: now(), type: "poll_error", error: redact(error?.message || error) });
    }
    const status = String(task?.status || streamState.doneStatus || "");
    if (status && status !== lastStatus) {
      lastStatus = status;
      console.log(`task ${taskID} status ${status}`);
    }
    if (terminalTaskStatuses.has(status)) break;
    await sleep(3_000);
  }
  streamController.abort();
  await Promise.race([stream, sleep(2_000)]);

  // The relay can stall a status request while the live SSE lane keeps
  // flowing. Reconcile after closing the stream so a terminal `done` frame
  // cannot be hidden behind one stale `running` response.
  try {
    const final = await fetchTaskBounded(taskID);
    if (final.body?.task) task = final.body.task;
  } catch (error) {
    frames.push({ at: now(), type: "final_poll_error", error: redact(error?.message || error) });
  }
  const polledStatus = String(task?.status || "");
  const finalStatus = terminalTaskStatuses.has(polledStatus)
    ? polledStatus
    : String(streamState.doneStatus || polledStatus || "timeout");
  if (task && finalStatus !== polledStatus) task = { ...task, status: finalStatus };
  writeTaskArtifacts(taskID, task, frames, streamState);
  if (!["completed", "review"].includes(finalStatus)) {
    throw new Error(`NAMED: task ${taskID} ended ${finalStatus}: ${redact(task?.failure?.message || task?.output || "").slice(-1_000)}`);
  }
  if (finalStatus === "review") {
    const completed = await agent(`/tasks/${taskID}/complete`, { method: "POST", body: "{}" });
    if (!completed.ok) {
      throw new Error(`NAMED: task approval returned HTTP ${completed.status}: ${redact(completed.text).slice(0, 500)}`);
    }
    console.log(`task ${taskID} review approved into the disposable worktree`);
  }
  return taskID;
}

async function stopActiveTaskBeforeCleanup() {
  if (!activeTaskID) return;
  let status = "";
  try {
    const current = await fetchTaskBounded(activeTaskID, 5_000);
    status = String(current.body?.task?.status || "");
  } catch {
    // A failed read is not permission to remove a possibly-live worktree.
  }
  if (terminalTaskStatuses.has(status)) return;
  console.log(`task ${activeTaskID} is ${status || "unconfirmed"}; stopping it before worktree cleanup`);
  const stopped = await agent(`/tasks/${activeTaskID}/stop`, {
    method: "POST",
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  if (!stopped.ok) {
    throw new Error(`NAMED: task ${activeTaskID} stop returned HTTP ${stopped.status}: ${redact(stopped.text).slice(0, 500)}`);
  }
}

async function renderPhase(phase, worktree) {
  const output = path.join(artifacts, phase);
  const previous = {
    VIBE_DEVICE_ID: process.env.VIBE_DEVICE_ID,
    VIBE_PROJECT_PATH: process.env.VIBE_PROJECT_PATH,
    VIBE_PROJECT_NAME: process.env.VIBE_PROJECT_NAME,
    VIBE_SURFACES: process.env.VIBE_SURFACES,
    VIBE_ARTIFACT_DIR: process.env.VIBE_ARTIFACT_DIR,
    VIBE_KEEP_DEV_SERVER: process.env.VIBE_KEEP_DEV_SERVER,
    VIBE_FAIL_FAST: process.env.VIBE_FAIL_FAST,
  };
  Object.assign(process.env, {
    VIBE_DEVICE_ID: deviceID,
    VIBE_PROJECT_PATH: worktree,
    VIBE_PROJECT_NAME: wantedProject,
    VIBE_SURFACES: surfaces,
    VIBE_ARTIFACT_DIR: output,
    VIBE_KEEP_DEV_SERVER: "0",
    VIBE_FAIL_FAST: "1",
  });
  try {
    await import(`./lightweight-surface-render.mjs?phase=${phase}-${Date.now()}`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
  const failed = manifest.results.filter((row) => row.verdict !== "PIXELS");
  if (failed.length) {
    throw new Error(`NAMED: ${phase} render failed on ${failed.map((row) => row.surface).join(", ")}`);
  }
  return manifest;
}

async function cleanupDisposable(paths) {
  if (!paths) return;
  const { parent, worktree } = paths;
  if (!/^\/tmp\/yaver-sfmg-surface-[A-Za-z0-9]+$/.test(parent) || worktree !== `${parent}/worktree`) {
    throw new Error(`refusing cleanup of unvalidated paths ${parent} ${worktree}`);
  }
  // Inspect the exact target before the destructive worktree removal.
  const inspected = await remoteExec(`ls -la ${shellQuote(parent)}; git -C ${shellQuote(sourcePath)} worktree list`, 30);
  fs.writeFileSync(path.join(artifacts, "cleanup-inspection.txt"), redact(inspected));
  await remoteExec(
    `git -C ${shellQuote(sourcePath)} worktree remove --force ${shellQuote(worktree)} && ` +
    `git -C ${shellQuote(sourcePath)} worktree prune && rmdir ${shellQuote(parent)}`,
    120,
  );
}

fs.mkdirSync(artifacts, { recursive: true });
const sourceBefore = await sourceFingerprint();
let disposable = null;
let beforeManifest = null;
let afterManifest = null;
let taskID = "";
let diffSummary = "";
let failure = null;
try {
  disposable = await createDisposableWorktree();
  console.log(`disposable worktree ${disposable.worktree}`);
  beforeManifest = await renderPhase("before", disposable.worktree);
  taskID = await runColorTask(disposable.worktree);
  diffSummary = await remoteExec(
    `git -C ${shellQuote(disposable.worktree)} status --short; ` +
    `git -C ${shellQuote(disposable.worktree)} diff --stat; ` +
    `git -C ${shellQuote(disposable.worktree)} diff --no-ext-diff -U0 | ` +
    `rg -n ${shellQuote(`${targetColor}|backgroundColor`)} | head -n 100`,
    60,
  );
  fs.writeFileSync(path.join(artifacts, "worktree-diff-summary.txt"), redact(diffSummary));
  afterManifest = await renderPhase("after", disposable.worktree);

  const beforeBySurface = new Map(beforeManifest.results.map((row) => [row.surface, row]));
  const colorResults = afterManifest.results.map((after) => {
    const before = beforeBySurface.get(after.surface);
    return {
      surface: after.surface,
      beforeRGB: before?.modalRGB || null,
      beforeClass: before?.modalClass || null,
      afterRGB: after.modalRGB || null,
      afterClass: after.modalClass || null,
      changed: JSON.stringify(before?.modalRGB) !== JSON.stringify(after.modalRGB),
      targetReached: after.modalClass === "red",
      fidelity: after.fidelity,
    };
  });
  fs.writeFileSync(path.join(artifacts, "color-verdict.json"), JSON.stringify(colorResults, null, 2));
  const missed = colorResults.filter((row) => !row.changed || !row.targetReached);
  if (missed.length) {
    throw new Error(
      `SILENT: target ${targetColor} not proven on ${missed.map((row) => row.surface).join(", ")}`,
    );
  }
  for (const row of colorResults) {
    console.log(`PIXELS ${row.surface.padEnd(7)} ${row.beforeClass} -> ${row.afterClass} ${row.afterRGB.join(",")}`);
  }
} catch (error) {
  failure = error;
  throw error;
} finally {
  await agent("/dev/stop", { method: "POST", body: "{}" }).catch(() => null);
  let cleanupSafe = true;
  await stopActiveTaskBeforeCleanup().catch((error) => {
    cleanupSafe = false;
    if (!failure) failure = error;
    console.error(`task stop failed; preserving disposable worktree: ${redact(error?.message || error)}`);
  });
  if (cleanupSafe) await cleanupDisposable(disposable).catch((error) => {
    if (!failure) failure = error;
    console.error(`cleanup failed: ${redact(error?.message || error)}`);
  });
  const sourceAfter = await sourceFingerprint().catch((error) => `ERROR ${redact(error?.message || error)}`);
  const sourceUnchanged = sourceBefore === sourceAfter;
  fs.writeFileSync(path.join(artifacts, "manifest.json"), JSON.stringify({
    runID,
    device: wantedDevice,
    deviceID,
    project: wantedProject,
    sourcePath,
    targetColor,
    runner,
    taskID: taskID || activeTaskID,
    sourceUnchanged,
    sourceBefore,
    sourceAfter,
    disposableWorktree: disposable?.worktree || null,
    cleanupAttempted: Boolean(disposable) && cleanupSafe,
    beforeManifest: beforeManifest ? path.join(artifacts, "before", "manifest.json") : null,
    afterManifest: afterManifest ? path.join(artifacts, "after", "manifest.json") : null,
    failure: failure ? redact(failure?.message || failure) : null,
  }, null, 2));
  if (!sourceUnchanged) {
    console.error("SILENT: the source SFMG working-tree fingerprint changed during the disposable loop");
    process.exitCode = 1;
  }
}

console.log(`artifacts ${artifacts}`);
