// parkedTurn.test.ts — run with: npx tsx src/lib/parkedTurn.test.ts
//
// Two jobs:
//
//  1. Pin the mapping from REASON CODE to what the user is told. The whole point
//     of the codes is that no surface has to regex a sentence; if the mapping
//     silently changes, a parked turn starts reading like a failure again and the
//     user retypes a prompt the agent is about to replay.
//
//  2. PARITY between mobile/src/lib/parkedTurn.ts and web/lib/parkedTurn.ts.
//     Native surfaces cannot import mobile/src/lib/*, so this module exists
//     TWICE by necessity. Two independent copies of one contract drift by
//     construction — that is exactly how mobile ended up with three different
//     relay-auth matchers, none a superset of the others. This test reads both
//     sources and fails when they disagree.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ParkedTurnError, parkedTurnNotice, RUNNER_AUTH_CODES } from "./parkedTurn";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function mk(code: string, runner = "codex") {
  return new ParkedTurnError({ ok: false, taskId: "t1", code, parked: true, reauthable: true, runner });
}

console.log("parked-turn notice mapping");

// Codes whose fix is a human signing in must offer exactly that, and must not
// imply the user should resend.
for (const code of [
  RUNNER_AUTH_CODES.lineageLost,
  RUNNER_AUTH_CODES.notAuthenticated,
  RUNNER_AUTH_CODES.credentialCorrupt,
  RUNNER_AUTH_CODES.credentialIsCopy,
]) {
  const n = parkedTurnNotice(mk(code));
  check(`${code} offers a sign-in action`, n.action?.kind === "signin", JSON.stringify(n.action));
  check(`${code} says the message is saved`, /saved/i.test(n.line), n.line);
  check(
    `${code} never tells the user to resend`,
    !/try again|resend|re-?type|send again/i.test(n.line),
    n.line,
  );
}

// A transient blocker has no useful button. Offering one that cannot help is
// worse than offering none.
{
  const n = parkedTurnNotice(mk(RUNNER_AUTH_CODES.refreshFailed));
  check("transient failure offers NO action", n.action === null, JSON.stringify(n.action));
  check("transient failure still says saved", /saved/i.test(n.line), n.line);
}
{
  const n = parkedTurnNotice(mk("something.completely.unknown"));
  check("unknown code degrades to no action", n.action === null, JSON.stringify(n.action));
  check("unknown code still reassures", /saved/i.test(n.line), n.line);
}

// The copy case must name WHY this box cannot renew, or the user re-mirrors and
// re-breaks the source machine.
{
  const n = parkedTurnNotice(mk(RUNNER_AUTH_CODES.credentialIsCopy));
  check("copy case explains it is a copy", /copy/i.test(n.line), n.line);
}

// Runner label
{
  const n = parkedTurnNotice(mk(RUNNER_AUTH_CODES.lineageLost, "codex"));
  check("names Codex", /Codex/.test(n.line), n.line);
  const bare = parkedTurnNotice(new ParkedTurnError({ ok: false, taskId: "t", code: RUNNER_AUTH_CODES.lineageLost, parked: true }));
  check("no runner still reads sensibly", /runner/i.test(bare.line), bare.line);
}

// Error shape
{
  const e = mk(RUNNER_AUTH_CODES.lineageLost);
  check("parked flag set", e.parked === true);
  check("reauthable carried", e.reauthable === true);
  check("taskId carried", e.taskId === "t1");
  check("is an Error", e instanceof Error);
}

console.log("\nmobile <-> web parity");
{
  const here = dirname(fileURLToPath(import.meta.url));
  const mobileSrc = readFileSync(join(here, "parkedTurn.ts"), "utf8");
  const webSrc = readFileSync(join(here, "../../../web/lib/parkedTurn.ts"), "utf8");

  // Every code value must exist verbatim in both. Values, not names — the wire
  // contract is the string.
  for (const [name, value] of Object.entries(RUNNER_AUTH_CODES)) {
    check(`web declares ${name} (${value})`, webSrc.includes(`"${value}"`), "missing from web/lib/parkedTurn.ts");
  }

  // Both must export the same surface.
  for (const sym of ["ParkedTurnError", "parkedTurnNotice", "RUNNER_AUTH_CODES"]) {
    check(`web exports ${sym}`, new RegExp(`export (class|function|const) ${sym}\\b`).test(webSrc));
    check(`mobile exports ${sym}`, new RegExp(`export (class|function|const) ${sym}\\b`).test(mobileSrc));
  }

  // The web copy must handle every code the mobile copy branches on, or a code
  // that renders a sign-in button on the phone renders a shrug on the desktop.
  const branches = (src: string) =>
    (src.match(/RUNNER_AUTH_CODES\.(\w+)/g) || [])
      .map((s) => s.split(".")[1])
      .filter((s) => s !== undefined);
  const mobileBranches = new Set(branches(mobileSrc));
  const webBranches = new Set(branches(webSrc));
  for (const b of mobileBranches) {
    check(`web branches on ${b} too`, webBranches.has(b), "web copy would fall through to the generic line");
  }
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
