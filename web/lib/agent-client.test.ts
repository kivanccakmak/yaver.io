/**
 * agent-client.test.ts — `npx tsx lib/agent-client.test.ts`.
 * Pins task-create request body serialization that Cloud Workspace handoff
 * depends on.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { AgentClient, buildCreateTaskBody } from "./agent-client";

test("web createTask body defaults allowLocalFallback to false", () => {
  const body = buildCreateTaskBody({
    title: "Build apk",
    description: "",
    userPrompt: "secret prompt",
    runner: "codex",
  });
  assert.equal(body.source, "web");
  assert.equal(body.allowLocalFallback, false);
  assert.equal(body.userPrompt, "secret prompt");
});

test("web createTask body can mark final Cloud Workspace handoff", () => {
  const body = buildCreateTaskBody({
    title: "Build apk",
    description: "",
    runner: "codex",
    allowLocalFallback: true,
  });
  assert.equal(body.allowLocalFallback, true);
});

test("web bundle preview URL preserves agent-minted signature in relay mode", () => {
  const client = new AgentClient() as any;
  client.host = "ignored";
  client.port = 1234;
  client.deviceId = "device-1";
  client._activeRelayUrl = "https://public.yaver.io";

  assert.equal(
    client.webBundlePreviewUrl("/dev/web-bundle/?sig=abc&exp=123"),
    "/d/device-1/dev/web-bundle/?sig=abc&exp=123",
  );
});

// ── model coercion at the dispatch funnel (2026-08-02) ─────────────────────
// The picker fix corrected the DEFAULT; the model is also a stored per-device
// setting, so a saved gpt-5.4 kept being dispatched at a ChatGPT-account Codex
// login that cannot run it. buildCreateTaskBody is the single funnel every web
// dispatch passes through, so the request that leaves the browser must not
// carry a model we have watched this runner refuse.
// A model MEASURED as refused must be rewritten…
{
  const coerced = buildCreateTaskBody({
    title: "t", description: "d", runner: "codex", model: "gpt-5.3-codex",
  });
  if (coerced.model !== "gpt-5.6-terra") {
    console.error(`FAIL dispatch still sends a model the login cannot run: ${String(coerced.model)}`);
    process.exitCode = 1;
  } else {
    console.log("ok   an observed-incompatible model is replaced before dispatch");
  }

  // NO FALSE RED: a model with no evidence against it is passed through
  // untouched — never silently override a deliberate choice.
  const untouched = buildCreateTaskBody({
    title: "t", description: "d", runner: "codex", model: "gpt-5.5",
  });
  if (untouched.model !== "gpt-5.5") {
    console.error(`FAIL a model with no observed refusal was rewritten: ${String(untouched.model)}`);
    process.exitCode = 1;
  } else {
    console.log("ok   a model with no observed refusal is passed through untouched");
  }

  // AND A MODEL MEASURED TO WORK IS NEVER "CORRECTED" AWAY. This is the exact
  // regression that broke the vibe loop: gpt-5.4 works on a subscription login
  // (probed on two machines, 2026-08-02) but sat in OBSERVED_REFUSALS from a
  // single 400, so the funnel rewrote it into gpt-5.3-codex — a model the
  // account genuinely refuses. Coercion that fires on a working model is worse
  // than no coercion at all.
  const working = buildCreateTaskBody({
    title: "t", description: "d", runner: "codex", model: "gpt-5.4",
  });
  if (working.model !== "gpt-5.4") {
    console.error(`FAIL a WORKING model was coerced away: gpt-5.4 -> ${String(working.model)}`);
    process.exitCode = 1;
  } else {
    console.log("ok   a model measured to work is dispatched as chosen");
  }

  // A runner we hold no opinion on is never rewritten either.
  const claude = buildCreateTaskBody({
    title: "t", description: "d", runner: "claude", model: "claude-opus-4-7",
  });
  if (claude.model !== "claude-opus-4-7") {
    console.error("FAIL a claude model was rewritten");
    process.exitCode = 1;
  } else {
    console.log("ok   a runner with no compat opinion is left alone");
  }
}
