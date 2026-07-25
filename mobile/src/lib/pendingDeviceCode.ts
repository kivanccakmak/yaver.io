// pendingDeviceCode.ts — pure logic for the device code a phone stashes while
// it signs in, so an Apple TV / watch / remote-box approval survives the
// round-trip through sign-in.
//
// This exists as its own RN-free module because the *resume* has now broken
// twice, with the identical user-visible symptom — a TV sitting on "Waiting for
// approval…" forever while the phone ends up happily signed in:
//
//   • 2026-07-15: app/approve-device.tsx dropped the code when it bounced a
//     signed-out phone to /login. Fixed by stashing it and draining the stash in
//     app/login.tsx::finishLogin.
//   • 2026-07-25: the drain lived ONLY in login.tsx, but a browser OAuth
//     sign-in (Apple/Google/GitHub on iOS) lands in app/oauth-callback.tsx —
//     the file's own header calls itself "the canonical handler" — which did
//     `router.replace("/")` and threw the stash away. Same silent stuck TV.
//     Convex proved it: the TV's code row stayed `pending`, so the phone never
//     called authorize at all.
//
// The lesson encoded here: a stash whose drain lives in ONE screen is a bug
// waiting for the next sign-in path. So the storage + navigation live in one
// place (pendingDeviceApproval.tsx), a mounted host re-drains it on any auth
// transition no matter which screen signed in, and a static guard test
// (pendingDeviceCodeLoginPaths.test.ts) fails the build if a new `await login()`
// path forgets to drain.

/** AsyncStorage key. Shared so no caller re-types the string. */
export const PENDING_DEVICE_CODE_KEY = "pendingDeviceCode";

/**
 * Device codes have a 15-minute TTL server-side (backend/convex/deviceCode.ts
 * createDeviceCode → expiresAt = now + 900_000). A stash older than that can
 * only ever produce a confusing "Authorization failed" on a code the TV has
 * already replaced, so it is discarded instead of resumed.
 */
export const PENDING_DEVICE_CODE_TTL_MS = 15 * 60 * 1000;

/** Canonical normalized shape the backend stores: ABCD-1234. */
const CODE_SHAPE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export interface PendingDeviceCodeRead {
  /** Normalized ABCD-1234 code. */
  code: string;
  /** How long ago it was stashed. 0 for a legacy stash with no timestamp. */
  ageMs: number;
  /** True when the code is past the server TTL and must not be resumed. */
  stale: boolean;
}

export function isPendingDeviceCodeShape(code: string): boolean {
  return CODE_SHAPE.test((code || "").trim().toUpperCase());
}

/** Serialize for storage. Timestamped so a resume can tell fresh from rotten. */
export function serializePendingDeviceCode(code: string, now: number): string {
  return JSON.stringify({ code: code.trim().toUpperCase(), at: now });
}

/**
 * Parse a stored stash. Returns null when there is nothing usable — no value,
 * malformed JSON, or a value that isn't code-shaped (never resume a guess).
 *
 * Accepts the pre-1.18.161 format too: a bare "ABCD-1234" string written by a
 * build that had no timestamp. Those read as age 0 / not stale, because "old
 * build wrote it" is not evidence it's expired and refusing it would strand
 * exactly the users mid-upgrade.
 */
export function parsePendingDeviceCode(
  raw: string | null | undefined,
  now: number,
): PendingDeviceCodeRead | null {
  const value = (raw || "").trim();
  if (!value) return null;

  if (!value.startsWith("{")) {
    const legacy = value.toUpperCase();
    return isPendingDeviceCodeShape(legacy) ? { code: legacy, ageMs: 0, stale: false } : null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const obj = parsed as { code?: unknown; at?: unknown } | null;
  const code = typeof obj?.code === "string" ? obj.code.trim().toUpperCase() : "";
  if (!isPendingDeviceCodeShape(code)) return null;

  const at = typeof obj?.at === "number" && Number.isFinite(obj.at) ? obj.at : 0;
  // A stash with no/absurd timestamp (or a clock that moved backwards) is
  // treated as fresh: the worst case is one honest "that code expired" from the
  // approver, versus silently dropping a valid approval.
  const ageMs = at > 0 ? Math.max(0, now - at) : 0;
  return { code, ageMs, stale: ageMs > PENDING_DEVICE_CODE_TTL_MS };
}
