/**
 * Guards for runnerOutputNoise.
 *
 * The fixture is verbatim from the run that LOOKED broken and was not: Codex
 * logged MCP-sidecar 401 chatter, retried past it, and completed the task.
 *
 * Run: npx tsx web/lib/runnerOutputNoise.test.ts
 */
import { describeSidecarNoise, isRunnerSidecarNoise, partitionRunnerOutput } from "./runnerOutputNoise";

let failures = 0;
const eq = (got: unknown, want: unknown, label: string) => {
  if (got === want) console.log(`ok   ${label}`);
  else { console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); failures++; }
};
const ok = (c: unknown, label: string) => eq(Boolean(c), true, label);

const RMCP = `2026-08-02T08:45:03Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when UnexpectedServerResponse("HTTP 401: {\\"code\\": \\"token_expired\\"}")`;
const WS = `2026-08-02T08:45:04Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://chatgpt.com/backend-api/codex/responses`;

ok(isRunnerSidecarNoise(RMCP), "the MCP worker line is runner-internal chatter");
ok(isRunnerSidecarNoise(WS), "the websocket reconnect line is runner-internal chatter");

// ── NO FALSE GREEN: a real failure must never be demoted ──────────────────
eq(isRunnerSidecarNoise(`ERROR: {"status":400,"error":{"message":"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."}}`),
  false, "a model-entitlement 400 is the TASK's failure, not sidecar noise");
eq(isRunnerSidecarNoise("HTTP 401 Unauthorized"), false,
  "a bare 401 is not demoted — matching on the status code alone would silence real auth failures");
eq(isRunnerSidecarNoise("Could not start OpenAI Codex: runner not ready: token has expired"), false,
  "the runner refusing to start is a real failure");
eq(isRunnerSidecarNoise("Metro bundler failed: SyntaxError"), false, "a compile error is never noise");
eq(isRunnerSidecarNoise(""), false, "empty is not noise");
eq(isRunnerSidecarNoise(null), false, "null is not noise");

// A sidecar prefix WITHOUT transport wording is not automatically noise.
eq(isRunnerSidecarNoise("rmcp::transport::worker: something entirely new"), false,
  "an unfamiliar sidecar line is surfaced rather than silently swallowed");

// ── partitioning ──────────────────────────────────────────────────────────
const mixed = [RMCP, "Reading files…", WS, "Applied patch to app/login.tsx"].join("\n");

const running = partitionRunnerOutput(mixed, false);
eq(running.noise.length, 2, "both transport lines are demoted while the task is alive");
ok(running.visible.includes("Applied patch"), "the real progress survives");
ok(!running.visible.includes("rmcp::transport"), "…and the chatter is out of the transcript");

// THE GATE: once the task has actually failed, nothing is hidden — the auth
// classifier and the user both need the whole picture.
const failed = partitionRunnerOutput(mixed, true);
eq(failed.noise.length, 0, "a terminally failed task hides NOTHING");
ok(failed.visible.includes("rmcp::transport"), "…so a real 401 still reaches the classifier");

// ── the console must say what was set aside ───────────────────────────────
const note = describeSidecarNoise(running.noise);
ok(note && /2 runner transport messages/.test(note), "it says how many were hidden");
ok(note && /still going/i.test(note), "…and that the task is still progressing");
ok(note && /runtime console/i.test(note), "…and where to find them");
eq(describeSidecarNoise([]), null, "nothing hidden = nothing said; no advisory over silence");

if (failures) { console.error(`\nrunnerOutputNoise: ${failures} FAILED`); process.exitCode = 1; }
else console.log("\nrunnerOutputNoise: ALL PASS");
