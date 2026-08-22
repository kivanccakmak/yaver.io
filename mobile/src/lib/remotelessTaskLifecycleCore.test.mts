import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceRemotelessRecord,
  finishRemotelessRecord,
  recoverInterruptedRecords,
  startRemotelessRecord,
} from "./remotelessTaskLifecycleCore.ts";

test("a task progresses and completes without losing its platform protection", () => {
  const started = startRemotelessRecord({ id: "t1", title: "Code", projectSlug: "app", kind: "coding" }, 10);
  const active = advanceRemotelessRecord(started, { phase: "editing", backgroundProtection: "bounded" }, 20);
  const done = finishRemotelessRecord(active, "completed", 30);
  assert.equal(done.state, "completed");
  assert.equal(done.phase, "done");
  assert.equal(done.backgroundProtection, "bounded");
  assert.equal(done.finishedAt, 30);
});

test("cold-start recovery never falsely completes interrupted file work", () => {
  const running = startRemotelessRecord({ id: "lost", title: "Push", projectSlug: "app", kind: "git-push" }, 10);
  const stillLive = startRemotelessRecord({ id: "live", title: "Code", projectSlug: "app", kind: "coding" }, 11);
  const recovered = recoverInterruptedRecords([running, stillLive], new Set(["live"]), 50);
  assert.equal(recovered[0].state, "review");
  assert.match(recovered[0].detail ?? "", /Review the working tree/);
  assert.equal(recovered[1].state, "running");
});

test("terminal records cannot be moved back to running by a late native update", () => {
  const started = startRemotelessRecord({ id: "t1", title: "Commit", projectSlug: "app", kind: "git-commit" }, 10);
  const done = finishRemotelessRecord(started, "completed", 20);
  assert.equal(advanceRemotelessRecord(done, { phase: "late" }, 30), done);
});
