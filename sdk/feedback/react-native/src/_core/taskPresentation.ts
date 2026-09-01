// AUTO-SYNCED from shared/client-core/src/taskPresentation.ts.
// DO NOT EDIT IN PLACE. Edit the source and re-run
// scripts/sync-client-core.sh. CI checks drift via `--check`.

/** Semantic Task narrative shared by every TypeScript Yaver surface.
 * Go producer: desktop/agent/task_presentation.go (schema 1). */

export const TASK_PRESENTATION_SCHEMA = 1;

/**
 * An open semantic label. Clients render the stable fields below rather than
 * maintaining a per-runner label list, so the Go agent can add new activity
 * categories without a mobile or TestFlight update.
 */
export type TaskPresentationKind = string;

export interface TaskPresentationMessage {
  id: string;
  kind: TaskPresentationKind;
  role?: "user" | "assistant";
  /** Human-readable Markdown/prose only; never runner stdout, a command, or a patch. */
  text: string;
  /** `primary` is rendered normally. `details` is retained for diagnostics only. */
  visibility?: "primary" | "details";
  phase?: string;
  state?: string;
  runner?: string;
  project?: string;
  machine?: string;
  platform?: string;
  surface?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskPresentationEvent {
  type: "presentation";
  schema: number;
  op: "append" | "upsert";
  seq: number;
  message: TaskPresentationMessage;
}

export interface TaskPresentationSnapshotEvent {
  type: "presentation_snapshot";
  schema: number;
  seq: number;
  messages: TaskPresentationMessage[];
}

export type TaskPresentationWireEvent = TaskPresentationEvent | TaskPresentationSnapshotEvent;

export function isTaskPresentationEvent(value: unknown): value is TaskPresentationWireEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as { type?: unknown; schema?: unknown };
  return (event.type === "presentation" || event.type === "presentation_snapshot") &&
    event.schema === TASK_PRESENTATION_SCHEMA;
}

/** Apply live semantic updates. Snapshots always replace: they are the
 * self-healing boundary after a backgrounded phone or relay reconnect. */
export function reduceTaskPresentation(
  current: TaskPresentationMessage[],
  event: TaskPresentationWireEvent,
): TaskPresentationMessage[] {
  if (event.type === "presentation_snapshot") return [...(event.messages ?? [])];
  if (!event.message?.id) return current;
  const index = current.findIndex((item) => item.id === event.message.id);
  if (index < 0) return [...current, event.message];
  const next = [...current];
  const previous = current[index];
  next[index] = event.op === "append"
    ? { ...previous, ...event.message, text: `${previous.text ?? ""}${event.message.text ?? ""}` }
    : event.message;
  return next;
}

/** The default Task view renders every primary semantic message. New agent
 * kinds therefore work on existing clients; only explicitly-detail evidence
 * stays out of the conversation. */
export function friendlyTaskPresentation(messages?: TaskPresentationMessage[]): TaskPresentationMessage[] {
  return (messages ?? []).filter((message) =>
    message.visibility !== "details" && message.kind !== "tool" && message.kind !== "patch"
  );
}
