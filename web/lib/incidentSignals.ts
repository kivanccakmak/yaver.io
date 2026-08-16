// incidentSignals.ts — classify a dev incident by its CODE.
//
// WHY THIS ONE IS CHEAP AND THE OTHERS WERE NOT. Every incident already carries
// `code` (IncidentEvent.Code, desktop/agent/incidents.go:27) and `/incidents` is
// ALREADY fetched by both surfaces — web/lib/agent-client.ts:7050 and
// mobile/src/lib/quic.ts:9287. Nothing new has to be plumbed; the codes simply
// were never read. ConnectivityView renders `incident.title || incident.code`,
// i.e. it DISPLAYS the code as fallback text and never switches on it, so five
// reason codes rode a live wire into a string.
//
// WHAT CLASSIFYING BUYS. `title` and `suggestedAction` are English the agent
// wrote, and prose cannot tell a surface three things it must know:
//   * whether retrying can possibly help (a missing Hermes compiler will not
//     appear because you pressed a button again),
//   * whether the fix is deterministic (start the dev server) or belongs to a
//     coding agent (your project does not build),
//   * whether the box is broken or the PROJECT is — which decides whether the
//     user goes looking at infrastructure or at their own last commit.
//
// It deliberately does NOT rewrite the agent's sentence. The agent knows which
// compiler, which path, which target; its prose is better than anything a client
// could synthesise. This adds only what prose cannot carry.
//
// KEEP IN SYNC with mobile/src/lib/incidentSignals.ts — byte-identical below the
// header, pinned by incidentSignals.test.ts.

/** Mirrors desktop/agent/reason_codes.go. */
export const RELOAD_DEV_SERVER_UNAVAILABLE = "reload.dev_server_unavailable";
export const RELOAD_NATIVE_REBUILD_REQUIRED = "reload.native_rebuild_required";
export const RELOAD_PREVIEW_WORKER_OFFLINE = "reload.preview_worker.offline";
export const BUILD_HERMES_FAILED = "build.hermes.failed";
export const BUILD_NATIVE_FAILED = "build.native.failed";

export type IncidentFault =
  /** Something about the machine or its tooling. */
  | "environment"
  /** The user's own project does not build. */
  | "project"
  /** A lane that is momentarily down and comes back by itself. */
  | "transient"
  | "unknown";

export type IncidentVerdict = {
  fault: IncidentFault;
  /** Short label for the state. NOT a replacement for the agent's title. */
  title: string;
  /** False when a Retry affordance must NOT be offered. */
  retryable: boolean;
  /** True when a coding agent is the right escalation (no deterministic fixer). */
  aiFixable: boolean;
};

/**
 * Classify an incident. Returns null for codes this build does not know AND for
 * incidents with no code at all — the caller then renders the agent's prose,
 * exactly as it does today, so nothing regresses on an older agent.
 */
export function classifyIncident(code: string | null | undefined): IncidentVerdict | null {
  switch ((code || "").trim()) {
    case RELOAD_DEV_SERVER_UNAVAILABLE:
      // Nothing is broken — there is simply no dev server to reload. Starting
      // one is a deterministic action, so a bare Retry is the wrong affordance.
      return { fault: "environment", title: "No dev server to reload", retryable: false, aiFixable: false };

    case RELOAD_NATIVE_REBUILD_REQUIRED:
      // A hot reload cannot carry this change; the native app must be rebuilt.
      // Retrying the reload will fail identically every time.
      return { fault: "environment", title: "This change needs a native rebuild", retryable: false, aiFixable: false };

    case RELOAD_PREVIEW_WORKER_OFFLINE:
      // The worker reconnects on its own, so a retry is genuinely honest here.
      return { fault: "transient", title: "The preview worker is offline", retryable: true, aiFixable: false };

    case BUILD_HERMES_FAILED:
      // hermesc is missing from the toolchain. It will not appear because the
      // user pressed a button again, and a coding agent cannot install it either.
      return { fault: "environment", title: "The Hermes compiler is missing", retryable: false, aiFixable: false };

    case BUILD_NATIVE_FAILED:
      // The user's own project failed to build. This is the canonical case for
      // escalating to a coding agent: Yaver has no command that fixes source.
      return { fault: "project", title: "The project failed to build", retryable: false, aiFixable: true };
  }
  return null;
}

/** True when the surface must NOT offer a retry for this incident. */
export function incidentSuppressesRetry(code: string | null | undefined): boolean {
  const v = classifyIncident(code);
  return v !== null && !v.retryable;
}

/** True when "Fix with <runner>" is the right escalation for this incident. */
export function incidentIsAIFixable(code: string | null | undefined): boolean {
  return classifyIncident(code)?.aiFixable === true;
}
