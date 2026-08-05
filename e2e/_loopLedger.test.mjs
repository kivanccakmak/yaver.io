// _loopLedger.test.mjs — the ledger must never turn into a false green.
//
//   npx tsx e2e/_loopLedger.test.mjs
//
// A cache of passing verdicts is one small mistake away from being the most
// dangerous thing in the suite: it can report coverage that was never measured,
// on code that no longer exists, and it reports it CONFIDENTLY. Everything
// worth testing here is a refusal — the cases where the ledger must decline to
// say yes.
//
// The three that matter, and each has a real failure behind it in this repo's
// history of "the inventory says yes, the operation says no":
//
//   1. a verdict recorded against DIFFERENT code must not count,
//   2. a verdict that is too OLD must not count,
//   3. NAMED (measured nothing, said why) must never be mistaken for a pass.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "loop-ledger-"));
process.env.LOOP_LEDGER_PATH = join(dir, "ledger.json");

const { record, alreadyPassed, allPassed, codeFingerprint, LEDGER_PATH } = await import("./_loopLedger.mjs");

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.error(`  ✗ ${msg}`); failures++; }
};

console.log("_loopLedger:");

// ── A fresh pass counts ──────────────────────────────────────────────────────
record({ target: "local", project: "sfmg", surface: "tvos", verdict: "PIXELS", detail: "green" });
ok(alreadyPassed("local", "sfmg", "tvos") !== null, "a PIXELS verdict recorded just now, on this code, counts");

// ── …but not for a different target, project, or surface ────────────────────
ok(alreadyPassed("remote", "sfmg", "tvos") === null, "a local pass does NOT satisfy the remote target");
ok(alreadyPassed("local", "yaver", "tvos") === null, "a pass for one project does not cover another");
ok(alreadyPassed("local", "sfmg", "ios") === null, "a pass for one surface does not cover another");

// ── NAMED is not a pass ──────────────────────────────────────────────────────
record({ target: "local", project: "sfmg", surface: "android", verdict: "NAMED", detail: "no emulator" });
ok(
  alreadyPassed("local", "sfmg", "android") === null,
  "NAMED does not count as a pass — it measured nothing and said so",
);

// ── SILENT is not a pass ─────────────────────────────────────────────────────
record({ target: "local", project: "sfmg", surface: "visionos", verdict: "SILENT", detail: "blank" });
ok(alreadyPassed("local", "sfmg", "visionos") === null, "SILENT does not count as a pass");

// ── A pass against DIFFERENT code must not count ────────────────────────────
// The most important case. Rewrite the stored entry's fingerprint to simulate
// the tree having moved on, which is what happens the moment anyone edits a
// tracked file.
{
  const db = JSON.parse(execFileSync("cat", [LEDGER_PATH], { encoding: "utf8" }));
  const e = db.entries.find((x) => x.surface === "tvos");
  e.code = "deadbeefcafe+0";
  writeFileSync(LEDGER_PATH, JSON.stringify(db));
  ok(
    alreadyPassed("local", "sfmg", "tvos") === null,
    "a pass recorded against a DIFFERENT code fingerprint is ignored — editing product code invalidates every entry",
  );
  // …and restore it so the later assertions have something to work with.
  e.code = codeFingerprint();
  writeFileSync(LEDGER_PATH, JSON.stringify(db));
  ok(alreadyPassed("local", "sfmg", "tvos") !== null, "restoring the fingerprint makes it count again (the check is the fingerprint, not the restore)");
}

// ── A pass that is too old must not count ───────────────────────────────────
{
  const db = JSON.parse(execFileSync("cat", [LEDGER_PATH], { encoding: "utf8" }));
  const e = db.entries.find((x) => x.surface === "tvos");
  e.at = new Date(Date.now() - 26 * 3_600_000).toISOString();
  writeFileSync(LEDGER_PATH, JSON.stringify(db));
  ok(alreadyPassed("local", "sfmg", "tvos", 12) === null, "a 26-hour-old pass is ignored under a 12-hour window");
  ok(alreadyPassed("local", "sfmg", "tvos", 48) !== null, "…and honoured under a 48-hour window, so the window is what decides");
}

// ── The local-first gate ────────────────────────────────────────────────────
{
  const gate = allPassed("local", "sfmg", ["tvos", "ios"], 48);
  ok(!gate.ok && gate.missing.includes("ios"), "allPassed reports the surfaces still missing, so the gate can name them");
  record({ target: "local", project: "sfmg", surface: "ios", verdict: "PIXELS", detail: "green" });
  ok(allPassed("local", "sfmg", ["tvos", "ios"], 48).ok, "once every listed surface passes, the gate opens");
}

// ── A corrupt ledger must degrade to "nothing recorded", never throw ────────
// Refusing to test because the bookkeeping is broken would be the bookkeeping
// outranking the work.
{
  writeFileSync(LEDGER_PATH, "{ this is not json");
  let threw = false;
  let res;
  try { res = alreadyPassed("local", "sfmg", "tvos", 48); } catch { threw = true; }
  ok(!threw && res === null, "a corrupt ledger yields null instead of throwing — worst case is a re-run");
}

rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? "\n_loopLedger: all assertions passed" : `\n_loopLedger: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
