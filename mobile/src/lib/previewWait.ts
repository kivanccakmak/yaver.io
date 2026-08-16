/**
 * previewWait.ts — what to SAY while a preview is still blank.
 *
 * ── The incident ───────────────────────────────────────────────────────────
 *
 * TestFlight build 500, 2026-08-03, project `sfmg` on a real iPhone against a
 * remote box. The preview surface was solid black from 18:21 to 18:23 — no
 * text, no elapsed time, no name of what was running. The only affordance was
 * a 3px progress bar at the top of the screen and a "Logs" button.
 *
 * Nothing was broken. Behind that black rectangle the box was working
 * perfectly the whole time, and said so, in the log panel one tap away:
 *
 *     queued
 *     Starting project at /root/Workspace/sfmg
 *     Starting Metro Bundler
 *     Waiting on http://localhost:8081
 *     Web Bundled 4844ms node_modules/expo-router/entry.js (2186 modules)
 *     ready 100%
 *
 * …and at 18:23 the app appeared, correctly. The user's verdict: "the ux ui
 * plumbing is not good, user wont feel that its going well at some stages."
 *
 * That is the exact defect CLAUDE.md legislates against — "Every wait the
 * product imposes must narrate itself: what is running, where, how long it has
 * been going, when it last made progress" — and it names this very drift:
 * the heartbeat line landed in DevPreview.tsx and never in apps.tsx. Two
 * implementations of one surface; the fix reached one of them.
 *
 * A spinner over a fact the product already has is the customer-facing shape
 * of "the inventory says yes while the operation says no".
 *
 * ── Why a pure function ────────────────────────────────────────────────────
 *
 * So the sentence that SHIPS is the sentence that is TESTED, and so the next
 * surface (tvOS, visionOS, web) renders the same words instead of inventing
 * its own. previewWait.test.mts is the proof.
 */

export type PreviewWait = {
  /** What is happening, in the box's own words where possible. */
  title: string;
  /** "1:24 elapsed · last output 3s ago" — never one without the other. */
  detail: string;
  /** True once the wait is long enough that silence needs explaining. */
  stalled: boolean;
};

/** "1:24", "12s", "2:05". */
export function shortElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Pick the line worth showing from the preview log tail.
 *
 * Progress lines beat noise: a bundler's own "Bundled …" or "Starting Metro"
 * says more than the last warning about a package.json. Deliberately ignores
 * WARN/warning lines — sfmg's log tail was three screens of `three` package
 * resolution warnings while the real state was "bundling", and showing the
 * last line verbatim would have reported a warning as the headline.
 */
export function meaningfulPreviewLine(logs: readonly string[]): string {
  const interesting =
    /(bundl|starting|compil|ready|listening|waiting on|building|installing|serving|metro|expo|vite|next)/i;
  const noise = /^\s*(warn|warning|note|debug)\b/i;
  for (let i = logs.length - 1; i >= 0; i--) {
    const raw = (logs[i] || "").trim();
    if (!raw || noise.test(raw)) continue;
    if (interesting.test(raw)) return raw.length > 96 ? `${raw.slice(0, 93)}…` : raw;
  }
  return "";
}

/**
 * The narration for a preview that has not painted yet.
 *
 * Returns null once content has loaded — a status panel over a working app is
 * the "surprise re-render" defect wearing a helpful face, and the rule is that
 * a reload must never replace a working preview with a placeholder.
 */
export function previewWaitLine(input: {
  contentLoaded: boolean;
  startedAt: number | null;
  lastOutputAt: number | null;
  now: number;
  logs: readonly string[];
  /** Where the work is happening, e.g. "/root/Workspace/sfmg". */
  workDir?: string | null;
}): PreviewWait | null {
  if (input.contentLoaded) return null;
  if (!input.startedAt) return null;

  const elapsed = Math.max(0, input.now - input.startedAt);
  const line = meaningfulPreviewLine(input.logs);

  // NAME THE PLACE. "Starting project" means nothing without "where"; the
  // whole point of a remote box is that the work is not happening here.
  const where = (input.workDir || "").trim();
  const title = line || (where ? `Starting the preview in ${where}` : "Starting the preview…");

  const parts = [`${shortElapsed(elapsed)} elapsed`];
  if (input.lastOutputAt && input.lastOutputAt >= input.startedAt) {
    parts.push(`last output ${shortElapsed(Math.max(0, input.now - input.lastOutputAt))} ago`);
  } else {
    // Silence is STATED, not hidden. "No output yet" after 40 seconds is a
    // fact the user can act on; a spinner is not.
    parts.push("no output yet");
  }

  // 25s is above a warm bundle and well below the 2-minute cold start measured
  // on sfmg — long enough not to cry wolf, short enough to beat the moment a
  // user decides the app is broken.
  const quietFor = input.lastOutputAt ? input.now - input.lastOutputAt : elapsed;
  return { title, detail: parts.join(" · "), stalled: quietFor > 25_000 };
}
