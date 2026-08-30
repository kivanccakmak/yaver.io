import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskHumanSummary, humanizeTaskCommand } from "./taskHumanSummary";

test("humanizes common coding actions instead of exposing shell syntax", () => {
  assert.equal(humanizeTaskCommand("pnpm test -- --runInBand"), "Run tests");
  assert.equal(humanizeTaskCommand("git diff --stat"), "Review changes");
  assert.equal(humanizeTaskCommand("npx tsc --noEmit"), "Check types");
});

test("running summary names the latest action and explicit outcomes", () => {
  const summary = buildTaskHumanSummary(
    { title: "Fix login", status: "running", output: [] },
    {
      inspect: {
        id: "inspect", command: "rg -n auth src", args: [], cwd: "", runner: "codex", startedAt: 1,
        stdout: "", stderr: "", status: "ok", exitCode: 0, durationMs: 100, truncated: false,
      },
      test: {
        id: "test", command: "pnpm test", args: [], cwd: "", runner: "codex", startedAt: 2,
        stdout: "", stderr: "", status: "error", exitCode: 1, durationMs: 1200, truncated: false,
      },
      build: {
        id: "build", command: "pnpm build", args: [], cwd: "", runner: "codex", startedAt: 3,
        stdout: "", stderr: "", status: "running", truncated: false,
      },
    },
  );
  assert.equal(summary.title, "Work in progress");
  assert.match(summary.detail, /Build the project is running now/);
  assert.deepEqual(summary.steps.map((step) => step.state), ["succeeded", "failed", "running"]);
  assert.ok(summary.facts.includes("1 command succeeded"));
  assert.ok(summary.facts.includes("1 command failed"));
});

test("structured failure carries cause and recovery route", () => {
  const summary = buildTaskHumanSummary({
    title: "Ship app",
    status: "review",
    output: [],
    failure: {
      title: "Tests failed",
      reason: "Two checkout tests did not pass.",
      remedy: "Open the failed tests, fix them, then run the suite again.",
    },
  });
  assert.equal(summary.title, "Tests failed");
  assert.equal(summary.detail, "Two checkout tests did not pass.");
  assert.equal(summary.nextAction, "Open the failed tests, fix them, then run the suite again.");
  assert.equal(summary.tone, "error");
});

test("completed task surfaces human result and delivery evidence", () => {
  const summary = buildTaskHumanSummary({
    title: "Fix login",
    status: "completed",
    output: [],
    resultText: "## Outcome\nLogin now keeps the session after reload.\n\n```ts\nconst noisy = true\n```",
    diffShortstat: "3 files changed, 18 insertions(+), 4 deletions(-)",
    commitSha: "abcdef1234567890",
  });
  assert.equal(summary.detail, "Login now keeps the session after reload.");
  assert.ok(summary.facts.includes("3 files changed, 18 insertions(+), 4 deletions(-)"));
  assert.ok(summary.facts.includes("Commit abcdef12"));
});

test("reopened task recovers activity without inventing command success", () => {
  const summary = buildTaskHumanSummary({
    title: "Audit",
    status: "review",
    output: ["**$ rg -n auth src**", "matches", "**$ pnpm test**", "all tests passed"],
  });
  assert.equal(summary.steps.length, 2);
  assert.ok(summary.steps.every((step) => step.state === "seen"));
  assert.ok(!summary.facts.some((fact) => fact.includes("succeeded")));
});
