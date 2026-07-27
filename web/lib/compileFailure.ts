// compileFailure.ts — promote a compile failure to a COMPACT card on the
// surface the user is looking at.
//
// Web port of mobile/src/lib/compileFailure.ts (audit 2026-07 gap D5): the
// mobile browser-preview surfaces got the named card first, while the web
// dashboard's PreviewPane still rendered a blank iframe over a green status.
// The trap is identical on both surfaces: Flutter's web-server keeps
// listening after a failed compile, so /dev/status says running+serving, the
// iframe mounts, renders black, and the ONLY statement of the truth (the
// agent's persisted compileError in status.error, or the "Failed to compile"
// lines in the log tail) never reached the screen. Cross-surface parity rule:
// a fix that lands on one of two preview implementations is not landed.
//
// KEEP IN SYNC with mobile/src/lib/compileFailure.ts — same shapes, same
// precedence (agent's persisted status.error wins; tail scan is fallback).
// compileFailure.test.ts pins the behaviors on both sides.
//
// One pure function: given the agent's persisted status.error and the
// streamed log tail, return the compact failure to render — title + the
// offending lines — or null when nothing indicates a compile failure.
// Full logs stay available behind the existing log panel; the card leads.

export type CompileFailure = {
  title: string;
  detail: string;
};

// The failure shapes worth promoting. The first group MUST cover every needle
// in devBuildFailureLine (desktop/agent/devserver_start_remedy.go) — the agent
// and the card have to agree on what a build failure looks like, or the
// tail-only path renders nothing over a build that already died. That
// contract is enforced by compileFailure.test.ts, which reads the Go list.
const COMPILE_LINE = /failed to compile|compilation failed|module build failed|bundling failed|unable to resolve module|the following build commands failed|error: the class .+ can't be extended|no file or variants found for asset|error TS\d+|SyntaxError:|error: cannot find|undefined name '|isn't defined for the (class|type)/i;

/** Lines a human needs from a tail: everything matching the failure shapes,
 *  plus one line of context after each, capped so the card stays a card. */
function relevantLines(tail: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    if (COMPILE_LINE.test(tail[i])) {
      out.push(tail[i].trim());
      const next = tail[i + 1];
      if (next && !COMPILE_LINE.test(next) && next.trim()) out.push(next.trim());
    }
  }
  return [...new Set(out)].slice(-8);
}

export function detectCompileFailure(
  statusError?: string | null,
  logTail?: readonly string[],
): CompileFailure | null {
  const err = (statusError || "").trim();
  if (err) {
    // The agent already promoted and NAMED it (devserver.go persists
    // compileError into status.error with the offending lines + remedy).
    // Believe the agent — it saw the full output.
    const isCompile = /compile|pubspec|asset/i.test(err);
    return {
      title: isCompile ? "Your app failed to compile" : "The dev server reported a failure",
      detail: err,
    };
  }
  const lines = relevantLines(logTail || []);
  if (lines.length === 0) return null;
  return {
    title: "Your app failed to compile",
    detail: lines.join("\n"),
  };
}
