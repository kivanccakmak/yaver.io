"use client";

/**
 * connectedDeviceCard.ts — "which of these cards am I actually ON?"
 *
 * The dashboard sidebar has always shown the connected box in green. The
 * Devices list never did: every card rendered identically, so with six-plus
 * machines — several with the same display name, and one box running a second
 * scoped agent that registers under the *same* name — picking the right card
 * was guesswork. On 2026-07-28 that cost a session: a circuit-sim cell's
 * workspace was opened in the belief it was the box.
 *
 * Two rules this module exists to make mechanical:
 *
 * 1. **deviceId equality, never name, never list index.** Names collide by
 *    construction here. A `renderedDevices` array is re-sorted by role,
 *    lifecycle and managed state on nearly every heartbeat, so an index is
 *    meaningless across two renders.
 *
 * 2. **Never compose a singleton's value onto a card that isn't its device.**
 *    `agentClient` is ONE object: `connectionState`, `activeRelayUrl`, the
 *    `/info` it holds, and any latency measured through it all describe a
 *    SINGLE device. The 2026-07-28 device-status incident (defect D2) was
 *    exactly this: a status line composed from two devices — the row's own
 *    `needsAuth` printed beside the *connected* agent's version. Anything
 *    derived from the singleton must be gated on
 *    `isBrowserConnectedToDevice(device.id, …)` before it is rendered.
 *
 * Pure + dependency-free on purpose (one small React hook at the bottom for
 * the reach-sample registry) so the logic that SHIPS is the logic that is
 * TESTED — see connectedDeviceCard.test.ts.
 */

import { useEffect, useState } from "react";

/**
 * True only when THIS browser's agent client is currently bound to THIS
 * device. Compares deviceId strings exactly; a matching `name` is not
 * evidence of anything (two agents on one box share a name).
 */
export function isBrowserConnectedToDevice(
  deviceId: string | null | undefined,
  connectedDeviceId: string | null | undefined,
  connectionState: string | null | undefined,
): boolean {
  if (String(connectionState || "") !== "connected") return false;
  const a = String(deviceId || "").trim();
  const b = String(connectedDeviceId || "").trim();
  if (!a || !b) return false;
  return a === b;
}

// ── Card surface ───────────────────────────────────────────────────────────
//
// Polite, not shouty: the connected card keeps the same geometry, shadow and
// typography as every other card and changes only its border + background to
// the theme's `success` tokens — the same vocabulary the sidebar pill already
// uses for the connected device (`border-success/30 bg-success-soft/30` in
// app/dashboard/page.tsx) and the same family as the existing needsAuth /
// warning treatments. Because `--success-soft` is defined for BOTH themes in
// app/globals.css, the light tint reads as a pale mint and the dark tint as a
// deep green-grey at roughly the neutral card's own lightness — a card that is
// *different*, never a card that looks like an alert.

/** Neutral surface — byte-for-byte the classes every non-connected card had. */
export const DEVICE_CARD_SURFACE_DEFAULT =
  "border-slate-200 bg-white dark:border-surface-700/80 dark:bg-[rgba(44,46,56,0.82)]";

/** Connected surface — success tint, same weight, no fill-solid shouting. */
export const DEVICE_CARD_SURFACE_CONNECTED =
  "border-success/50 bg-success-soft/50 dark:border-success/40 dark:bg-[rgba(34,54,44,0.86)]";

/** Verified reachable, but not the browser's active session. */
export const DEVICE_CARD_SURFACE_REACHABLE =
  "border-emerald-300/70 bg-emerald-50/60 dark:border-emerald-500/25 dark:bg-[rgba(32,46,42,0.72)]";

/** Heartbeat-only: alive somewhere, not proven from this browser. */
export const DEVICE_CARD_SURFACE_CLAIMED =
  "border-sky-300/60 bg-sky-50/55 dark:border-sky-500/25 dark:bg-[rgba(32,40,52,0.70)]";

/** Pairing/sign-in/auth work required before this browser can use it. */
export const DEVICE_CARD_SURFACE_AUTH =
  "border-amber-300/70 bg-amber-50/60 dark:border-amber-500/30 dark:bg-[rgba(54,46,31,0.72)]";

/** A failed probe or no live signal. Quiet, but visibly not healthy. */
export const DEVICE_CARD_SURFACE_OFFLINE =
  "border-rose-300/55 bg-rose-50/45 dark:border-rose-500/25 dark:bg-[rgba(50,36,42,0.70)]";

export type DeviceCardSurfaceState =
  | "connected"
  | "reachable"
  | "claimed"
  | "auth"
  | "offline"
  | "default";

export interface DeviceCardSurfaceStateInput {
  lifecycle?: string | null;
  reach?: {
    state?: string | null;
    unreachable?: boolean | null;
    verified?: boolean | null;
  } | null;
  needsAuth?: boolean | null;
  probeState?: string | null;
}

export function deviceCardSurfaceState(input: DeviceCardSurfaceStateInput): DeviceCardSurfaceState {
  const lifecycle = String(input.lifecycle || "").trim();
  const reachState = String(input.reach?.state || "").trim();
  const probeState = String(input.probeState || "").trim();
  if (input.reach?.unreachable || reachState === "unreachable" || probeState === "unreachable" || lifecycle === "offline") {
    return "offline";
  }
  if (input.needsAuth || lifecycle === "bootstrap" || lifecycle === "yaver-auth-expired" || probeState === "auth-expired") {
    return "auth";
  }
  if (input.reach?.verified || reachState === "reachable" || lifecycle === "connected") {
    return "reachable";
  }
  if (reachState === "claimed" || lifecycle === "ready-to-connect") {
    return "claimed";
  }
  return "default";
}

/**
 * Surface classes for a device card. Takes the already-computed boolean so the
 * call site is forced to name its evidence (`isBrowserConnectedToDevice(...)`)
 * rather than smuggling in a name/index comparison here.
 */
export function deviceCardSurfaceClasses(
  isConnectedDevice: boolean,
  state: DeviceCardSurfaceState = "default",
): string {
  if (isConnectedDevice || state === "connected") return DEVICE_CARD_SURFACE_CONNECTED;
  switch (state) {
    case "reachable": return DEVICE_CARD_SURFACE_REACHABLE;
    case "claimed": return DEVICE_CARD_SURFACE_CLAIMED;
    case "auth": return DEVICE_CARD_SURFACE_AUTH;
    case "offline": return DEVICE_CARD_SURFACE_OFFLINE;
    default: return DEVICE_CARD_SURFACE_DEFAULT;
  }
}

// ── Status line ────────────────────────────────────────────────────────────

export interface ConnectedStatusLineInput {
  /** Human transport label, e.g. "Yaver public relay" (lib/transport.ts). */
  transportLabel?: string | null;
  /** `TransportInfo.primary`; "unknown" means we have no evidence. */
  transportPrimary?: string | null;
  /** Round-trip milliseconds, ONLY from a real measurement against this
   *  device. Null/absent → the line simply omits it. */
  latencyMs?: number | null;
}

/**
 * The one sentence the connected card says about itself.
 *
 *   "Connected · Yaver public relay · 604ms"
 *   "Connected · Private LAN"
 *   "Connected"                       ← transport genuinely unknown
 *
 * Never guesses: an "unknown" classification renders as a bare "Connected"
 * rather than inventing a path, and latency appears only when a measurement
 * for THIS device exists.
 */
export function connectedStatusLine(input: ConnectedStatusLineInput): string {
  const parts = ["Connected"];
  const label = String(input.transportLabel || "").trim();
  const primary = String(input.transportPrimary || "").trim();
  if (label && primary && primary !== "unknown") parts.push(label);
  const rtt = input.latencyMs;
  if (typeof rtt === "number" && Number.isFinite(rtt) && rtt >= 0) {
    parts.push(`${Math.round(rtt)}ms`);
  }
  return parts.join(" · ");
}

// ── Reach samples (latency) ────────────────────────────────────────────────
//
// There is no ambient latency signal in the web dashboard and this module does
// NOT add a probe. It only remembers the round-trip the user's own Ping already
// measured (`useDevicePing` in DevicesView.tsx), keyed by deviceId, so the
// connected card can state it. Samples expire, because a stale number is a lie
// with a decimal point.

/** A reach sample older than this is dropped rather than shown. */
export const REACH_SAMPLE_MAX_AGE_MS = 120_000;

const reachSamples = new Map<string, { rttMs: number; at: number }>();
const reachListeners = new Set<() => void>();
let reachVersion = 0;

/** Record a measured round-trip for `deviceId`. No I/O; call sites pass a
 *  duration they already measured. */
export function noteDeviceReachRttMs(
  deviceId: string | null | undefined,
  rttMs: number,
  now: number = Date.now(),
): void {
  const id = String(deviceId || "").trim();
  if (!id) return;
  if (!Number.isFinite(rttMs) || rttMs < 0) return;
  reachSamples.set(id, { rttMs, at: now });
  reachVersion += 1;
  for (const fn of reachListeners) fn();
}

/** Read the fresh reach sample for `deviceId`, or null. Keyed strictly by id —
 *  one device's latency can never surface on another device's card. */
export function readDeviceReachRttMs(
  deviceId: string | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = REACH_SAMPLE_MAX_AGE_MS,
): number | null {
  const id = String(deviceId || "").trim();
  if (!id) return null;
  const sample = reachSamples.get(id);
  if (!sample) return null;
  if (now - sample.at > maxAgeMs) return null;
  return sample.rttMs;
}

/** Test seam — drops every recorded sample. */
export function resetDeviceReachSamples(): void {
  reachSamples.clear();
  reachVersion += 1;
  for (const fn of reachListeners) fn();
}

export function subscribeDeviceReachSamples(fn: () => void): () => void {
  reachListeners.add(fn);
  return () => {
    reachListeners.delete(fn);
  };
}

/**
 * Component-scope subscription. Read this once in the list component and then
 * call `readDeviceReachRttMs(device.id)` inside the `.map()` — the same shape
 * the file already uses for `useFailureRegistryVersion`, because a hook cannot
 * be called per iteration.
 */
export function useDeviceReachSampleVersion(): number {
  const [version, setVersion] = useState(reachVersion);
  useEffect(() => {
    const unsubscribe = subscribeDeviceReachSamples(() => setVersion(reachVersion));
    setVersion(reachVersion);
    return unsubscribe;
  }, []);
  return version;
}
