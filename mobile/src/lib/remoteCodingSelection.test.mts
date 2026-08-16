// remoteCodingSelection.test.mts
// Run: npx tsx src/lib/remoteCodingSelection.test.mts

import test from "node:test";
import assert from "node:assert/strict";

import {
  HETZNER_OPENCODE_MODEL,
  isModelCompatibleWithRunnerId,
  preferredDefaultModelForRunner,
  resolveModelForRemoteSend,
} from "./remoteCodingSelection.ts";

test("OpenCode rejects stale Codex model ids", () => {
  assert.equal(isModelCompatibleWithRunnerId("gpt-5.4", "opencode"), false);
  assert.equal(isModelCompatibleWithRunnerId("zai-coding-plan/glm-5.2", "opencode"), true);
});

test("OpenCode send resolves past stale selected Codex model", () => {
  const resolved = resolveModelForRemoteSend({
    runnerId: "opencode",
    activeDevice: { id: "dev-1", name: "ubuntu-4gb-hel1-1", os: "linux" } as any,
    primaryModelByDevice: { "dev-1": "zai-coding-plan/glm-5.2" },
    selectedModel: "gpt-5.4",
    fallbackModel: "gpt-5.4",
    availableRunners: [
      {
        id: "opencode",
        models: [
          { id: "zai-coding-plan/glm-5.2", isDefault: true },
          { id: HETZNER_OPENCODE_MODEL },
        ],
      },
    ],
    signedInEmail: null,
    userPickedModel: true,
  });

  assert.equal(resolved, "zai-coding-plan/glm-5.2");
});

test("Codex default does not reintroduce rejected gpt-5.3-codex", () => {
  assert.equal(preferredDefaultModelForRunner("codex", { name: "ubuntu-4gb-hel1-1", os: "linux" }, null), "gpt-5.4");
  assert.equal(preferredDefaultModelForRunner("codex", { name: "ubuntu-4gb-hel1-1", os: "linux" }, "kivanc@example.com"), "gpt-5.4");
});
