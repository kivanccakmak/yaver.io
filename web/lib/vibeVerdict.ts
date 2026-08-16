/**
 * vibeVerdict — the pure decisions behind the vibe closed loop.
 *
 * Extracted so the LOGIC that decides a pass is unit-tested, while the browser
 * driving stays in the e2e spec. Every bug this file guards against was real,
 * and each one made a WORKING product look broken:
 *
 *   • one horizontal band at 55% height ran through the sign-in buttons
 *     (#1a1a1a), so a fully red login screen sampled as "black" and two
 *     twelve-minute runs reported failure for a vibe that had succeeded;
 *   • a loose red threshold would let the app's own error chrome pass as a
 *     successful colour change;
 *   • an EMPTY preview panel and a black app are identical to a sampler, so
 *     "black" was once just a blank rectangle agreeing with the test.
 *
 * A test that is wrong in the direction of FAILURE is not harmless: it sends
 * real investigations after systems that work. That is why this is unit-tested
 * rather than trusted.
 */

export type VibeColor = "black" | "red" | "green" | "unknown" | (string & {});

/**
 * Classify an [r,g,b] sample.
 *
 * The dominance margin is load-bearing, not decoration. Yaver paints error and
 * danger chrome in red-ish tones; a loose threshold would let a failure banner
 * masquerade as a successful vibe. It is the same discipline that keeps the
 * WebRTC loop off green — an H.264 decoder with no content paints the all-zero
 * YUV frame rgb(0,135,0), so a green probe there false-matches on no signal.
 */
export function classifyVibeColor(px: readonly number[] | null | undefined): VibeColor {
  if (!px || px.length < 3) return "unknown";
  const [r, g, b] = px;
  if ([r, g, b].some((v) => typeof v !== "number" || Number.isNaN(v))) return "unknown";
  if (r < 60 && g < 60 && b < 60) return "black";
  if (r > 90 && r > g + 45 && r > b + 45) return "red";
  if (g > 90 && g > r + 45 && g > b + 45) return "green";
  return `other(${r},${g},${b})`;
}

/**
 * The sample points for a frame.
 *
 * A GRID, never a single row. The background is most of a login screen's area,
 * so it wins on its own merits instead of depending on which row happens to
 * miss the controls. Insets skip the device-frame chrome at the edges.
 */
export function samplePoints(width: number, height: number, stride = 8): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  if (!(width > 0) || !(height > 0)) return pts;
  const step = Math.max(1, Math.floor(stride));
  for (let y = Math.floor(height * 0.05); y < height * 0.95; y += step) {
    for (let x = Math.floor(width * 0.05); x < width * 0.95; x += step) {
      pts.push([x, y]);
    }
  }
  return pts;
}

/** The most common colour among samples, as [r,g,b]. */
export function modalColor(samples: ReadonlyArray<readonly number[]>): number[] {
  const counts = new Map<string, number>();
  for (const s of samples) {
    if (!s || s.length < 3) continue;
    const k = `${s[0]},${s[1]},${s[2]}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = "0,0,0";
  let n = -1;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best.split(",").map(Number);
}

/**
 * Is this frame a rendered app, or an empty panel?
 *
 * A blank black rectangle and a black login screen classify identically, so
 * "black" alone can be a preview that never loaded agreeing with the assertion.
 * Distinct-colour count is the cheap discriminator: real UI has text, buttons
 * and borders; an empty panel has one colour.
 */
export function looksRendered(samples: ReadonlyArray<readonly number[]>, minDistinct = 3): boolean {
  const seen = new Set<string>();
  for (const s of samples) {
    if (!s || s.length < 3) continue;
    seen.add(`${s[0]},${s[1]},${s[2]}`);
    if (seen.size >= minDistinct) return true;
  }
  return false;
}

export type Verdict = "PIXELS" | "NAMED" | "SILENT";

/**
 * Decide the loop's verdict.
 *
 * PIXELS is the only pass; SILENT (no cause) is the only true failure. A run
 * that fails but SAYS why is a degrade, not a defect — that distinction is what
 * keeps the suite honest about products that are merely unhealthy.
 */
export function verdictFor(opts: {
  reachedTarget: boolean;
  reverted: boolean;
  reason?: string | null;
}): { verdict: Verdict; reason: string } {
  if (opts.reachedTarget && opts.reverted) {
    return { verdict: "PIXELS", reason: "target colour and revert both observed" };
  }
  const reason = String(opts.reason || "").trim();
  if (!reason) return { verdict: "SILENT", reason: "failed with no stated cause" };
  return { verdict: "NAMED", reason };
}
