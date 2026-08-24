// Run: npx tsx mobile/src/lib/followUpPlan.test.ts
import { planFollowUp } from "./followUpPlan";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

console.log("planFollowUp");

// The reported bug: finished is the COMMON state when a user replies. It is a
// finished turn, not a finished conversation, so it must retain the task.
{
  const p = planFollowUp({ parentRunner: "codex", desiredRunner: "codex", status: "completed" });
  check("finished Codex task continues in place", p.action === "continue", p.action);
}

// Every terminal turn status continues the same task/session.
for (const status of ["completed", "review", "failed", "stopped"]) {
  const p = planFollowUp({ parentRunner: "claude", desiredRunner: "claude", status });
  check(`status ${status} continues`, p.action === "continue", p.action);
}

// A live task continues in place — no new task, no fork.
for (const status of ["running", "queued", "streaming", ""]) {
  const p = planFollowUp({ parentRunner: "codex", desiredRunner: "codex", status });
  check(`live status ${status || "(empty)"} continues`, p.action === "continue", p.action);
}

// A runner switch cannot masquerade as a follow-up. New Task/Fork is explicit.
{
  const p = planFollowUp({ parentRunner: "codex", desiredRunner: "claude", status: "running" });
  check("runner change is blocked", p.action === "runner-change-blocked", p.action);
}

// Runner change wins over finished: a confirm dialog must not be skipped just
// because the parent also happens to be done.
{
  const p = planFollowUp({ parentRunner: "codex", desiredRunner: "claude", status: "completed" });
  check("runner change stays blocked after a finished turn", p.action === "runner-change-blocked", p.action);
}

// An unknown parent runner must NOT read as "changed". Legacy tasks have no
// recorded runnerId; treating that as a switch would pop a confirm dialog on
// the first follow-up to every old task.
{
  const p = planFollowUp({ parentRunner: "", desiredRunner: "codex", status: "running" });
  check("unknown parent runner does not count as a change", p.action === "continue", p.action);
}
{
  const p = planFollowUp({ parentRunner: "codex", desiredRunner: "", status: "running" });
  check("empty picker does not count as a change", p.action === "continue", p.action);
}

// Legacy tasks still continue; the agent decides whether it has a real native
// session identity and reports an explicit conflict if it cannot resume one.
{
  const p = planFollowUp({ parentRunner: "", desiredRunner: "", status: "completed" });
  check("legacy finished task never forks", p.action === "continue", p.action);
}

// Adopted tmux sessions bypass all of it — input goes to the pane.
{
  const p = planFollowUp({ isAdopted: true, parentRunner: "codex", status: "completed" });
  check("adopted tmux sends input directly", p.action === "tmux-input", p.action);
}

// Whitespace must not create a phantom runner change.
{
  const p = planFollowUp({ parentRunner: " codex ", desiredRunner: "codex", status: "running" });
  check("whitespace is not a runner change", p.action === "continue", p.action);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
