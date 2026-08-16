// renderIntent.test.mts — privacy-safe render/deep-link parser.
// Run: npx tsx src/lib/renderIntent.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import { parseRenderLink, renderIntentToOpenApp } from "./renderIntent.ts";

test("parses yaver render link", () => {
  assert.deepEqual(parseRenderLink("yaver://render?project=todo-rn&device=primary&mode=browser&reload=fast"), {
    kind: "render",
    intent: {
      project: "todo-rn",
      device: "primary",
      mode: "browser",
      reload: "fast",
      source: "deeplink",
    },
  });
});

test("parses universal render link", () => {
  assert.deepEqual(parseRenderLink("https://yaver.io/render/sfmg?mode=hermes"), {
    kind: "render",
    intent: {
      project: "sfmg",
      mode: "hermes",
      reload: "none",
      source: "deeplink",
    },
  });
});

test("parses shortcut link", () => {
  assert.deepEqual(parseRenderLink("yaver://shortcut?id=abc123"), {
    kind: "shortcut",
    id: "abc123",
    source: "deeplink",
  });
});

test("parses generic shortcut launcher", () => {
  assert.deepEqual(parseRenderLink("yaver://shortcut"), {
    kind: "shortcut",
    id: "",
    source: "deeplink",
  });
});

test("strips path-like/control characters from project token", () => {
  const parsed = parseRenderLink("yaver://render?project=/root/Workspace/todo-rn%0Asecret&mode=bogus&reload=bogus");
  assert.equal(parsed?.kind, "render");
  if (parsed?.kind !== "render") return;
  assert.equal(parsed.intent.project, "rootWorkspacetodo-rnsecret");
  assert.equal(parsed.intent.mode, "auto");
  assert.equal(parsed.intent.reload, "none");
});

test("maps render intent to open-app bus payload", () => {
  const parsed = parseRenderLink("yaver://render?project=todo-rn&mode=browser");
  assert.equal(parsed?.kind, "render");
  if (parsed?.kind !== "render") return;
  assert.deepEqual(renderIntentToOpenApp(parsed.intent), { app: "todo-rn", lane: "browser" });
});
