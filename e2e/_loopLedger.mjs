// _loopLedger.mjs — a durable, honest record of which closed loops have passed.
//
// WHY A LEDGER AT ALL. The surface suite is expensive: a simulator arc is
// minutes of CPU and gigabytes of RAM, and this machine and the 4 GB box are
// both shared with other work. Re-running an arc that passed ten minutes ago on
// the same code is pure waste, and waste is what makes a suite too expensive to
// run — at which point it stops being run, which is the real failure.
//
// WHY IT MUST EXPIRE, AND WHY THAT IS THE WHOLE DESIGN. A cache of green
// verdicts is one short step from a false green: "it passed" is only meaningful
// alongside "…on THIS code, recently". So every entry is keyed by the working
// tree's state, and a recorded pass is honoured ONLY when:
//
//   * the git HEAD is unchanged, AND
//   * the tracked-file dirty fingerprint is unchanged, AND
//   * it is younger than maxAgeHours (default 12).
//
// Change one line of product code and every entry stops counting. That is
// deliberate: this repo has repeatedly found that the cheap-looking shortcut
// (trust the inventory) is the one that produces confident wrong answers, and a
// ledger is an inventory. It says yes only when it can also say "about exactly
// this".
//
// Entries are never deleted on failure — a SILENT verdict is recorded too, so
// the ledger shows what is known-broken rather than merely what is unproven.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
export const LEDGER_PATH = process.env.LOOP_LEDGER_PATH || join(HERE, "test-results", "loop-ledger.json");

/** git HEAD + a fingerprint of uncommitted tracked changes. */
export function codeFingerprint() {
  const git = (args, fallback) => {
    try {
      return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return fallback;
    }
  };
  const head = git(["rev-parse", "HEAD"], "no-head");
  // `diff` of tracked files only. Untracked scratch files must NOT invalidate a
  // verdict — an artifact written by the arc itself would then invalidate the
  // very run that wrote it, and nothing would ever stay green for a second.
  const dirty = git(["diff", "--stat", "HEAD"], "");
  let hash = 0;
  for (let i = 0; i < dirty.length; i++) hash = (Math.imul(31, hash) + dirty.charCodeAt(i)) | 0;
  return `${head.slice(0, 12)}+${(hash >>> 0).toString(16)}`;
}

function load() {
  if (!existsSync(LEDGER_PATH)) return { version: 1, entries: [] };
  try {
    const j = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    return Array.isArray(j?.entries) ? j : { version: 1, entries: [] };
  } catch {
    // A corrupt ledger must never fail a test run: the worst it can cost is a
    // re-run, and refusing to test because the bookkeeping is broken would be
    // the bookkeeping outranking the work.
    return { version: 1, entries: [] };
  }
}

function save(db) {
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(db, null, 2));
}

const keyOf = (target, project, surface) => `${target}::${project}::${surface}`;

/** Record one verdict. `verdict` is PIXELS | NAMED | SILENT | DISPATCHED. */
export function record({ target, project, surface, verdict, detail = "", durationMs = 0 }) {
  const db = load();
  const key = keyOf(target, project, surface);
  const entry = {
    key, target, project, surface, verdict, detail, durationMs,
    at: new Date().toISOString(),
    code: codeFingerprint(),
  };
  const i = db.entries.findIndex((e) => e.key === key);
  if (i >= 0) db.entries[i] = entry;
  else db.entries.push(entry);
  save(db);
  return entry;
}

/**
 * Has this loop already passed, on this code, recently?
 *
 * Only PIXELS and DISPATCHED count. NAMED means the arc measured nothing and
 * said so — treating that as "done" is exactly how a suite starts reporting
 * coverage it does not have.
 */
export function alreadyPassed(target, project, surface, maxAgeHours = 12) {
  const e = load().entries.find((x) => x.key === keyOf(target, project, surface));
  if (!e) return null;
  if (e.verdict !== "PIXELS" && e.verdict !== "DISPATCHED") return null;
  if (e.code !== codeFingerprint()) return null;
  const ageH = (Date.now() - Date.parse(e.at)) / 3_600_000;
  if (!Number.isFinite(ageH) || ageH > maxAgeHours) return null;
  return { ...e, ageHours: ageH };
}

/** Every recorded entry for a target, newest first. */
export function entriesFor(target) {
  return load().entries
    .filter((e) => !target || e.target === target)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/**
 * Are all of `surfaces` passing for this target on the current code?
 *
 * This is what gates the remote phase on the local phase: the 4 GB box is the
 * scarcest resource in the loop, so nothing reaches it until the same arcs have
 * proven themselves somewhere cheaper.
 */
export function allPassed(target, project, surfaces, maxAgeHours = 12) {
  const missing = surfaces.filter((s) => !alreadyPassed(target, project, s, maxAgeHours));
  return { ok: missing.length === 0, missing };
}

/** Human-readable state, for a runner's header and for a handoff. */
export function render(target) {
  const rows = entriesFor(target);
  if (!rows.length) return "  (nothing recorded yet)";
  const now = codeFingerprint();
  return rows.map((e) => {
    const stale = e.code !== now ? " [stale: code changed]" : "";
    const mark = e.verdict === "PIXELS" || e.verdict === "DISPATCHED" ? "✓" : e.verdict === "NAMED" ? "·" : "✗";
    return `  ${mark} ${(e.target + "/" + e.project + "/" + e.surface).padEnd(40)} ${e.verdict.padEnd(11)} ${e.at.slice(0, 16).replace("T", " ")}${stale}`;
  }).join("\n");
}
