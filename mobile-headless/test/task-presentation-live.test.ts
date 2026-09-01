// Mobile-headless closed loop for the task conversation contract. It drives
// the same HTTP facade a phone uses and verifies the final data model, not a
// runner-specific text regex. Set YMH_AGENT_URL + YMH_AUTH_TOKEN deliberately
// to spend one real runner turn; otherwise the hermetic assertion still locks
// the client projection.

import { expect, test } from "bun:test";
import { MobileClient } from "../src/mobile-client";
import { startMockAgent } from "../src/mock-agent";
import { firstClassTaskConversationTurns, remoteAgentConversationView } from "../../mobile/src/_core/taskConversation";

const live = Boolean(process.env.YMH_AGENT_URL && process.env.YMH_AUTH_TOKEN);

test("mobile conversation keeps terminal evidence out of the primary answer", () => {
  const primary = {
    id: "answer", kind: "message", role: "assistant" as const,
    text: "Updated the SFMG background and checked the diff.", createdAt: "", updatedAt: "",
  };
  const rawDetails = {
    id: "terminal", kind: "message", role: "assistant" as const, visibility: "details" as const,
    text: "> build · model\n→ Edit app.json\nIndex: /workspace/sfmg/app.json\n__YAVER_EXIT__:0", createdAt: "", updatedAt: "",
  };
  const view = remoteAgentConversationView({ status: "ready", presentation: [primary, rawDetails] });
  expect(view.assistantText).toBe(primary.text);
  expect(firstClassTaskConversationTurns([{ role: "assistant", content: rawDetails.text }], [primary, rawDetails]))
    .toEqual([{ role: "assistant", content: primary.text }]);
});

test("mobile-headless task facade preserves the primary/details split", async () => {
  const agent = await startMockAgent({ token: "mobile-presentation-token" });
  try {
    const mobile = new MobileClient({ agentBaseUrl: agent.baseUrl, authToken: "mobile-presentation-token" });
    const created = await mobile.createTask("Change the SFMG background", { runner: "opencode" });
    const task = await mobile.waitForTask(created.id, { timeoutMs: 1000, pollMs: 10 });
    expect(task.transport).toBe("acp");
    expect(task.presentation?.find((message) => message.visibility === "primary")?.text).toContain("Change the SFMG background");
    expect(task.presentation?.find((message) => message.visibility === "details")?.text).toContain("> build ·");
  } finally {
    await agent.close();
  }
});

test("mobile-headless waits through a transient task-read rate limit", async () => {
  const agent = await startMockAgent({ token: "mobile-presentation-token", transientTaskRead429s: 1 });
  try {
    const mobile = new MobileClient({ agentBaseUrl: agent.baseUrl, authToken: "mobile-presentation-token" });
    const created = await mobile.createTask("Change the SFMG background", { runner: "opencode" });
    const task = await mobile.waitForTask(created.id, { timeoutMs: 2500, pollMs: 10 });
    expect(task.status).toBe("ready");
    expect(task.presentation?.find((message) => message.visibility === "primary")?.text).toContain("Change the SFMG background");
  } finally {
    await agent.close();
  }
});

test.if(live)("a real mobile-headless task returns primary prose and separate raw terminal evidence", async () => {
  const mobile = new MobileClient({
    agentBaseUrl: process.env.YMH_AGENT_URL,
    authToken: process.env.YMH_AUTH_TOKEN,
    agentRelayPassword: process.env.YMH_AGENT_RELAY_PASSWORD,
  });
  const token = `YAVER_MOBILE_PRESENTATION_${Date.now().toString(36).toUpperCase()}`;
  const created = await mobile.createTask(`Reply with exactly: ${token}`, {
    title: `mobile-headless presentation probe ${token}`,
    runner: process.env.YMH_RUNNER || "opencode",
    workDir: process.env.YMH_WORK_DIR,
  });
  const task = await mobile.waitForTask(created.id, { timeoutMs: 300_000, pollMs: 1500 });
  expect(["ready", "review", "completed"]).toContain(task.status);
  const primary = (task.presentation ?? []).find((message) =>
    message.kind === "message" && message.role === "assistant" && message.visibility !== "details");
  expect(primary?.text).toContain(token);
  expect(task.transport).toBe("acp");
}, 330_000);
