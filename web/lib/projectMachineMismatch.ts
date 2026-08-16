/**
 * projectMachineMismatch — the project list came from ONE box; the render
 * probe targets ANOTHER.
 *
 * ── The real mechanism (corrected 2026-08-02) ──────────────────────────────
 *
 * The first pass of this investigation recorded the cause as "the picker merges
 * every machine's projects by NAME, so it offers a project the render box never
 * had". That was inherited from a five-day-old note and is WRONG — grepping the
 * code shows there is no cross-device aggregation anywhere:
 *
 *   RuntimeLabView.tsx:1355  agentClient.listProjects()
 *   VibeCodingView.tsx:804   agentClient.listProjects()
 *
 * `agentClient` is a single connection to the CONNECTED box. Nothing merges.
 *
 * The actual shape is simpler and easier to fix: the project list is read from
 * the connected/runner machine, and under a runner/render split the render
 * probe goes to a DIFFERENT machine. So every project offered is a project the
 * render box was never asked about. On the owner's screen that produced:
 *
 *     no mobile project named "yaver / mobile" on this machine
 *
 * — a true sentence from the render box about a list it never supplied.
 *
 * ── Why this is worth a module ─────────────────────────────────────────────
 *
 * Because it is knowable BEFORE the probe, for free, with data the browser is
 * already holding: the id of the box the list came from, and the id of the box
 * that will render. If they differ, the mismatch is certain — no round trip, no
 * LLM, no waiting for a failure to teach us something we could have said up
 * front.
 *
 * It also gives the failure a real ROUTE rather than a CLI string aimed at a
 * machine the user has no shell on: render on the box that has the project, or
 * pick a project the render box actually reported.
 */

export type ProjectMachineMismatch = {
  /** True when the list source and the render target are different machines. */
  mismatch: boolean;
  /** One sentence naming what is wrong. Empty when there is nothing to say. */
  reason: string;
  /** The instruction that resolves it. Empty when nothing is required. */
  action: string;
  /** Machine that supplied the project list, for the "render there" route. */
  sourceDeviceId: string | null;
  sourceName: string | null;
};

export interface ProjectMachineInput {
  /** Project the user selected (display name), if any. */
  projectName?: string | null;
  /** Device the project list was READ from — the connected/runner box. */
  sourceDeviceId?: string | null;
  sourceName?: string | null;
  /** Device the render probe will TARGET. */
  renderDeviceId?: string | null;
  renderName?: string | null;
}

const clean = (v: string | null | undefined): string => String(v || "").trim();

/**
 * Detect the source/target split.
 *
 * Returns `mismatch: false` whenever we cannot be CERTAIN — an unknown device
 * id, or ids that match. Guessing a mismatch would put a scary, wrong
 * explanation in front of a user whose setup is fine, and send them to change a
 * render target that was never the problem. Certainty or silence.
 */
export function detectProjectMachineMismatch(input: ProjectMachineInput): ProjectMachineMismatch {
  const src = clean(input.sourceDeviceId);
  const dst = clean(input.renderDeviceId);
  const none: ProjectMachineMismatch = {
    mismatch: false, reason: "", action: "", sourceDeviceId: null, sourceName: null,
  };

  // Either side unknown → say nothing. Half the facts is not a diagnosis.
  if (!src || !dst) return none;
  if (src === dst) return none;

  const srcName = clean(input.sourceName) || src;
  const dstName = clean(input.renderName) || dst;
  const project = clean(input.projectName);
  const subject = project ? `“${project}”` : "The selected project";

  return {
    mismatch: true,
    reason:
      `${subject} came from ${srcName}'s project list, but the render machine is ${dstName} — ` +
      `${dstName} was never asked what it has, so a project that exists on ${srcName} can be missing here.`,
    action: `Render on ${srcName}, or pick a project that ${dstName} itself reports.`,
    sourceDeviceId: src,
    sourceName: srcName,
  };
}

/**
 * Should the "project missing" panel offer the cross-machine route?
 *
 * Only when the failure really is a missing project AND the machines differ.
 * A missing project on a SINGLE box is a genuine "you have no such project"
 * and must not be dressed up as a routing problem — that would send the user
 * chasing a machine split they do not have.
 */
export function shouldOfferRenderOnSource(
  failureKind: string | null | undefined,
  input: ProjectMachineInput,
): boolean {
  if (clean(failureKind) !== "project-missing") return false;
  return detectProjectMachineMismatch(input).mismatch;
}
