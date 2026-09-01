# Task stream protocol

This is the transport contract for task output. The Go agent is the producer
and source of truth; mobile, web, the feedback SDK, and future surfaces are
small renderers. It is deliberately independent of a runner's native wire
protocol (ACP, Codex App Server, Claude CLI, OpenCode, or an attached tmux
session).

Code remains authoritative. The producer is `desktop/agent/task_presentation.go`
and `desktop/agent/httpserver.go`; the shared client reducer is
`shared/client-core/src/taskPresentation.ts`.

## Lanes

`presentation` is the human lane. It is a schema-1 event with an `upsert` or
`append`, sequence number, and message. A message has a stable id, open-ended
kind, text, optional role, phase/state, and `visibility` (`primary` or
`details`). The client renders every primary message generically. New kinds are
not a client release: unknown kinds use the ordinary activity/message card.

The Go agent alone decides whether a runner fragment is a command, terminal
decoration, diff, progress, failure, or ordinary text. Assistant messages are
sanitised at this boundary, so `text` in a primary assistant message is never a
command, code patch, ANSI terminal frame, or copied stdout.

`raw` and `raw_replay` are the evidence lane. They carry the actual bounded
runner terminal tail, including ANSI and unified diffs. A client may render it
with a terminal/ANSI renderer behind Details, but must not use it as chat
content or infer task state from it. This is how a phone preserves green/red
patches without owning terminal parsing rules.

`output` remains the compatibility transcript lane. It is not the source for
the primary conversation UI.

## Streaming and recovery

The initial task subscription emits a `presentation_snapshot`. Live deltas are
best-effort so a slow relay never blocks a runner. If a delta is dropped, the
agent emits the newest bounded snapshot within 500 ms; clients replace their
semantic list. This is state coalescing, not an unbounded event cache.

`?since=` resumes the compatibility transcript and `?rawSince=` resumes raw
terminal bytes. Each replay has an agent-authored offset and a `full` flag so a
client never guesses whether to append or replace. The raw UI keeps its own
small render cap; the agent remains the longer-lived source of evidence.

## Interaction and terminal sessions

An `agent_question` is runner-neutral. MCP `yaver_ask_user` and ACP
`elicitation/create` both enter the same agent-owned question registry and use
the existing task answer endpoint. ACP URL/secret elicitation is not advertised:
runner OAuth uses Yaver's dedicated, origin-checked login flow.

Fresh managed tasks may use native ACP (OpenCode) or a local ACP adapter
(Codex/Claude). ACP initialization and `session/new` happen before the prompt;
any failure falls back to the normal signed-in CLI/tmux path without executing
the task twice. Existing/adopted tmux sessions always retain their CLI/PTY lane
so an already signed-in interactive runner stays usable.

## Compatibility rule

Keep schema `1` while adding optional message fields, open-ended kinds, and new
phase/state values. A client that does not recognise a new kind must still show
the primary text and retain Details. A breaking event shape requires a new
schema and a server-side compatibility path; it must never silently make a
phone wait for a TestFlight update to understand runner output.
