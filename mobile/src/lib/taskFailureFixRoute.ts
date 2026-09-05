export type TaskFailureFixRoute =
  | { kind: "runner-auth-needed"; runnerId: string }
  | { kind: "runner-provider-config"; runnerId: "opencode" }
  | { kind: "runner-test"; runnerId: string };

type TaskFailureFixLike = {
  type?: string | null;
  runnerId?: string | null;
} | null | undefined;

/**
 * Convert the agent's structured task-failure fix into a mobile action.
 *
 * OpenCode is provider-key-only in Yaver. New agents emit
 * `runner_provider_config`; older agents may still emit the historical,
 * incorrect `runner_browser_auth`. Treat both as OpenCode settings so a stale
 * remote box can never make mobile start Claude/Codex OAuth for DeepSeek.
 */
export function taskFailureFixRoute(
  fix: TaskFailureFixLike,
  taskRunnerId?: string | null,
): TaskFailureFixRoute | null {
  const runnerId = String(fix?.runnerId || taskRunnerId || "").trim().toLowerCase();
  const type = String(fix?.type || "").trim().toLowerCase();
  if (runnerId === "opencode" && (type === "runner_provider_config" || type === "runner_browser_auth")) {
    return { kind: "runner-provider-config", runnerId: "opencode" };
  }
  if (type === "runner_browser_auth" && runnerId) {
    return { kind: "runner-auth-needed", runnerId };
  }
  if (type === "runner_test" && runnerId) {
    return { kind: "runner-test", runnerId };
  }
  return null;
}
