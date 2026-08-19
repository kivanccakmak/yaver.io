import assert from "node:assert/strict";
import { runnerMenuStatusText } from "./runnerMenuStatus";

assert.equal(
  runnerMenuStatusText({ health: "ready", authPresent: true, authVerified: false }),
  "unverified",
  "a locally present credential stays honest without exposing its path or expiry",
);
assert.equal(runnerMenuStatusText({ health: "ready", authVerified: true }), "signed in");
assert.equal(runnerMenuStatusText({ health: "needs-auth", authVerified: false }), "verify");
assert.equal(runnerMenuStatusText({ health: "needs-auth" }), "sign in");
assert.equal(runnerMenuStatusText({ health: "down" }), "error");
assert.equal(runnerMenuStatusText({ health: "not-installed" }), "missing");
assert.equal(runnerMenuStatusText({ health: "unknown" }), "unknown");

for (const text of [
  runnerMenuStatusText({ health: "ready", authPresent: true, authVerified: false }),
  runnerMenuStatusText({ health: "ready", authVerified: true }),
]) {
  assert.ok(text.length <= 10, `menu status must stay compact: ${text}`);
  assert.doesNotMatch(text, /[~/]|valid for|auth\.json/i, "menu status must not leak diagnostic detail");
}

console.log("runnerMenuStatus tests passed");
