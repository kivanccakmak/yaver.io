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

/**
 * Whether the captured tail proves that a server reached a renderable state.
 * Startup words are deliberately not success: "Starting Metro Bundler" can
 * be followed immediately by a terminal CommandError. When both appear, the
 * last terminal/success signal wins so an older agent cannot turn an exited
 * process into "ready, waiting for paint" merely because its earlier output
 * contained "starting".
 */
export function previewLogsLookHealthy(lines: readonly string[], statusError?: string | null): boolean {
  if (String(statusError || "").trim()) return false;
  let healthy = false;
  for (const raw of lines.slice(-80)) {
    const line = String(raw).toLowerCase();
    // Classify failure first: "exited before becoming ready" contains the word
    // ready, but it is proof of the exact opposite.
    if (/\b(?:commanderror|failed to start|failed to compile|compilation failed|bundling failed|exited before becoming ready|could not resolve|cannot find module|not installed|required dependencies? (?:is|are) still missing)\b/.test(line)) {
      healthy = false;
    } else if (/\b(?:ready(?:\s+100%)?|bundled|compiled|listening|serving on)\b/.test(line)) {
      healthy = true;
    }
  }
  return healthy;
}

export type PreviewPaintGateMode = "confirmed" | "blocking";

/**
 * Decide whether first-open narration may cover the preview.
 *
 * A server response is not a rendered app. All clients keep the strict paint
 * gate until a guest signal arrives or the watchdog converts the wait into a
 * named failure. The former old-agent fallback exposed an unverified frame;
 * when that frame was actually empty it produced the exact solid-black
 * "Preview shown" screen this gate exists to prevent (2026-08-23).
 */
export function previewPaintGateMode(
  status: Pick<DevServerStatus, "previewHealth"> | null | undefined,
  opts: { contentLoaded: boolean; failed: boolean; probeUnavailable?: string | null },
): PreviewPaintGateMode {
  if (opts.contentLoaded) return "confirmed";
  if (opts.failed) return "blocking";
  void status;
  void opts.probeUnavailable;
  return "blocking";
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
 *  and surface only on the client's console channel. A failed script resource
 *  and an HTML response parsed as JS are operation failures too: the box-side
 *  doctor can stay green while the phone's #root remains empty. */
export function clientRuntimeLogsNeedProjectFix(lines: readonly string[]): boolean {
  if (!lines.length) return false;
  const text = lines.slice(-40).join("\n").toLowerCase();
  return /uncaught|unhandled (promise )?rejection|is not a function|cannot read propert|referenceerror:|typeerror:|syntaxerror:\s*unexpected token ['"]?<['"]?|\[web:error\]\s+resource failed script\b/.test(text);
}
