import type { AgentStatus, RunnerInfo } from "./quic";
import { deriveRunnerBannerState } from "./runnerBannerState";

let failures = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`ok   ${name}`);
    return;
  }
  failures++;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

// Cast rather than a full AgentStatus literal: deriveRunnerBannerState only
// reads `runner`, and spelling out every required field (system, disk, git,
// runnerProcesses…) would make the fixture noise, not signal.
const baseStatus = {
  runner: {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    installed: true,
    ready: true,
    authConfigured: true,
  },
  runningTasks: 0,
  status: "ok",
} as unknown as AgentStatus;

const claudeReady: RunnerInfo = {
  id: "claude",
  name: "Claude Code",
  command: "claude",
  installed: true,
  ready: true,
  authConfigured: true,
  isDefault: false,
  models: [],
};

console.log("runnerBannerState");

check(
  "loading beats empty-list false negative",
  deriveRunnerBannerState([], null, "claude", "loading")?.text === "Claude Code status loading",
);

check(
  "failed beats stale no-runner fact",
  deriveRunnerBannerState([], null, "claude", "network-error")?.text === "Claude Code status unavailable",
);

check(
  "selected runner auth needed is explicit",
  deriveRunnerBannerState([{ ...claudeReady, authConfigured: false, ready: false }], baseStatus, "claude", "ok")?.text === "Claude Code needs sign-in",
);

check(
  "loaded empty list says no agents available",
  deriveRunnerBannerState([], { ...baseStatus, runner: undefined as any }, "", "ok")?.text === "No agents available",
);

check(
  "selected runner ready stays specific",
  deriveRunnerBannerState([claudeReady], baseStatus, "claude", "ok")?.text === "Claude Code ready",
);

process.exit(failures);
