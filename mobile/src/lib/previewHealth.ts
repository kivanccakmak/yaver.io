// previewHealth.ts — the ONE decision function for "may this surface offer
// Fix in Yaver?", shared by both browser-preview implementations
// (app/(tabs)/apps.tsx and src/components/DevPreview.tsx). It was copy-pasted
// into both once; per the parity rule (beaconParity model) the duplication is
// hoisted here so drift is structurally impossible.
//
// Contract with the agent (devserver.go previewHealthFromAgentSignals):
// - When the agent emits previewHealth.canOfferProjectFix (any modern agent),
//   that verdict is AUTHORITATIVE for server/build health: healthy, starting,
//   infrastructure_gap and generic status errors all suppress the fix button.
// - The agent CANNOT see inside the WebView. Runtime JS errors reach only the
//   client's console channel, so client console evidence may still escalate —
//   that is clientRuntimeLogsNeedProjectFix, and it must be OR'd in only where
//   console lines (not dev-server logs) are the evidence.
// - Older agents without the field fall back to the caller-supplied local log
//   heuristics unchanged.

import type { DevServerStatus } from "./quic";

export function previewAgentHealthIsAuthoritative(
  status: Pick<DevServerStatus, "previewHealth"> | null | undefined,
): boolean {
  return typeof status?.previewHealth?.canOfferProjectFix === "boolean";
}

export function previewHealthCanOfferProjectFix(
  status: Pick<DevServerStatus, "previewHealth" | "error"> | null | undefined,
  lines: readonly string[],
  fallback: (lines: readonly string[], statusError?: string) => boolean,
): boolean {
  const health = status?.previewHealth;
  if (health && typeof health.canOfferProjectFix === "boolean") {
    return health.canOfferProjectFix === true &&
      health.state === "needs_project_fix" &&
      health.hasDeterministicFix !== true;
  }
  return fallback(lines, status?.error);
}

/** Runtime errors the AGENT cannot see: they happen inside the WebView page
 *  and surface only on the client's console channel. Matches crash shapes
 *  only — never build/startup noise, which the agent already classifies. */
export function clientRuntimeLogsNeedProjectFix(lines: readonly string[]): boolean {
  if (!lines.length) return false;
  const text = lines.slice(-40).join("\n").toLowerCase();
  return /uncaught|unhandled (promise )?rejection|is not a function|cannot read propert|referenceerror:|typeerror:/.test(text);
}
