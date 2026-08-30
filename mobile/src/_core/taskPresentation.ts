// AUTO-SYNCED from shared/client-core/src/taskPresentation.ts.
// DO NOT EDIT IN PLACE. Edit the source and re-run
// scripts/sync-client-core.sh. CI checks drift via `--check`.

/** Semantic Task narrative shared by every TypeScript Yaver surface.
 * Go producer: desktop/agent/task_presentation.go (schema 1). */

export const TASK_PRESENTATION_SCHEMA = 1;

export type TaskPresentationKind =
  | "message"
  | "status"
  | "action_required"
  | "warning"
  | "error"
  | "tool"
  | "patch";

export interface TaskPresentationMessage {
  id: string;
  kind: TaskPresentationKind;
  role?: "user" | "assistant";
  text: string;
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

/** The default Task view shows conversation + meaningful state. Tool and patch
 * payloads have dedicated folded lanes and are intentionally excluded. */
export function friendlyTaskPresentation(messages?: TaskPresentationMessage[]): TaskPresentationMessage[] {
  return (messages ?? []).filter((message) =>
    message.kind === "message" ||
    message.kind === "status" ||
    message.kind === "action_required" ||
    message.kind === "warning" ||
    message.kind === "error"
  );
}
