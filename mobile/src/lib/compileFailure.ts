// compileFailure.ts — promote a compile failure to a COMPACT card on the
// surface the user is looking at (remained.md P1).
//
// The trap this closes: Flutter's web-server keeps listening after a failed
// compile, so /dev/status says running+serving, the WebView mounts, renders
// black, and the render probe eventually times out — and the ONLY statement
// of the truth (the agent's persisted compileError, or the "Failed to
// compile" lines in the log tail) was either absent from the screen or
// buried in a raw purple log dump. Observed twice on real projects:
// font_awesome_flutter's `The class 'IconData' can't be extended outside of
// its library` (2026-07-25) and e-mobile's missing `.env` pubspec asset
// (2026-07-26).
//
// One pure function, shared by BOTH browser-preview implementations
// (apps.tsx + DevPreview.tsx): given the agent's persisted status.error and
// the streamed log tail, return the compact failure to render — title +
// the offending lines — or null when nothing indicates a compile failure.
// Full logs stay available behind the existing log panel; the card leads.

export type CompileFailure = {
  title: string;
  detail: string;
};

const COMPILE_LINE = /failed to compile|compilation failed|error: the class .+ can't be extended|no file or variants found for asset|error TS\d+|SyntaxError:|error: cannot find|undefined name '|isn't defined for the (class|type)/i;

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
