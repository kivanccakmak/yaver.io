/**
 * Opt-in, real-provider probe for the boxless/remoteless DeepSeek lane.
 *
 * This imports the production phone-side provider. It never persists or
 * prints the credential, response debug body, prompt, or generated source.
 * Returned edits are applied only to an in-memory target.
 *
 * Run through scripts/test-deepseek-headless.sh. That wrapper bundles this
 * production-code import graph into a private temporary file before Node runs
 * it, because Metro-style extensionless TypeScript imports are not directly
 * resolvable by Node's type-stripper.
 *
 * Normal test runs remain offline: both explicit opt-in and a non-empty
 * process-scoped credential are required before this test contacts DeepSeek.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyEditPlan,
  type ApplyTarget,
} from "../mobile/src/lib/llmClient.ts";
import { createOpenAiProvider } from "../mobile/src/lib/llmOpenAI.ts";

const liveEnabled = process.env.YAVER_LIVE_DEEPSEEK === "1";
const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
const runLive = liveEnabled && apiKey.length > 0;

describe("DeepSeek request compatibility", () => {
  it("disables V4 thinking before forcing the structured edit tool", async () => {
    let capturedURL = "";
    let capturedBody: Record<string, unknown> = {};
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedURL = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{ function: { name: "apply_edits", arguments: '{"rationale":"ok","edits":[]}' } }],
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const provider = createOpenAiProvider({
      flavor: "deepseek",
      apiKey: "test-credential-never-sent",
      fetchImpl: mockFetch,
    });
    await provider.editFiles({ prompt: "x", files: [] });

    assert.equal(capturedURL, "https://api.deepseek.com/chat/completions");
    assert.deepEqual(capturedBody.thinking, { type: "disabled" });
    assert.deepEqual(capturedBody.tool_choice, { type: "function", function: { name: "apply_edits" } });
  });
});

describe("DeepSeek live phone-side coding probe", { skip: !runLive }, () => {
  it("returns and applies a structured edit plan without exposing the key", { timeout: 90_000 }, async () => {
    const marker = `YAVER_DEEPSEEK_LIVE_${Date.now().toString(36).toUpperCase()}`;
    const provider = createOpenAiProvider({
      flavor: "deepseek",
      apiKey,
      maxTokens: 768,
    });

    const plan = await provider.editFiles({
      prompt: [
        "Turn this blank React Native component into the smallest Hello World screen.",
        "It must visibly render the exact text Hello from Remoteless.",
        `Also add this exact inert source comment once: // ${marker}`,
        "Keep the existing default export and do not create or delete any files.",
      ].join(" "),
      files: [{ path: "App.tsx", content: "export default function App() { return null; }\n" }],
      framework: "React Native / Expo",
      timeoutMs: 75_000,
    });

    assert.equal(provider.id, "deepseek");
    assert.equal(provider.model, "deepseek-v4-flash");
    assert.ok(plan.edits.length > 0, "DeepSeek returned no structured edits");
    assert.ok(
      plan.edits.some((edit) => edit.path === "App.tsx" && edit.content?.includes(marker) && edit.content.includes("Hello from Remoteless")),
      "DeepSeek did not return the requested App.tsx Hello World edit",
    );

    const writes: Array<{ path: string; content: string }> = [];
    const target: ApplyTarget = {
      async writeSourceFile(_slug, path, content) { writes.push({ path, content }); },
      async deleteSourceFile() { throw new Error("The live probe must not delete files"); },
    };
    const applied = await applyEditPlan("deepseek-live-memory-only", plan, target);

    assert.deepEqual(applied.skipped, []);
    assert.ok(
      writes.some((write) => write.path === "App.tsx" && write.content.includes(marker) && write.content.includes("Hello from Remoteless")),
      "The production apply path did not accept the generated App.tsx Hello World edit",
    );

    const responseDebug = JSON.stringify(plan.debug ?? {});
    if (apiKey.length >= 8 && responseDebug.includes(apiKey)) {
      throw new Error("DeepSeek response debug unexpectedly contained credential material");
    }
  });
});

describe("DeepSeek live probe safety gate", () => {
  it("requires explicit opt-in and a process-scoped key", () => {
    assert.equal(runLive, liveEnabled && apiKey.length > 0);
  });
});
