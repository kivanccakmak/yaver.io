/**
 * goalSlashCommand.ts — Yaver goal-mode composer recognition, shared by
 * every mobile surface (tasks, tv-coding, car-voice-coding, watch bridge).
 *
 * Yaver goal-mode is the opencode goal plugin: a persistent objective the
 * runner keeps working toward across turns (create_goal + idle
 * auto-continue) until complete with evidence, blocked, or a safety limit.
 *
 * A `/goal <objective>` typed into any composer arms goal-mode. The
 * objective must travel as the STRUCTURED `goal` field on the task (NOT as
 * a raw runner command) because the agent's tasks.go only wraps the
 * objective in `<yaver_goal>` when RawRunnerCommand is false — a raw
 * pass-through would reach the opencode runner without arming create_goal.
 *
 * Goal-mode is opencode-only on the agent side. On other runners (claude,
 * glm, codex) we leave the input untouched so their native /goal works.
 * A bare `/goal` with no objective also passes through raw.
 */

export function goalFromSlashCommand(
  input: string | null | undefined,
  runner: string | null | undefined,
): { goal: string; prompt: string } | null {
  const text = String(input || "").trim();
  if (!/^\/goal\s+/i.test(text)) return null;
  const objective = text.replace(/^\/goal\s+/i, "").trim();
  if (!objective) return null;
  const runnerId = String(runner || "").trim().toLowerCase();
  if (runnerId && runnerId !== "opencode") return null;
  return { goal: objective, prompt: objective };
}
