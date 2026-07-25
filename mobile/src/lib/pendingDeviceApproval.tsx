// pendingDeviceApproval.tsx — the ONE place a stashed device code is stored,
// read, and resumed, plus a mounted host that guarantees the resume happens no
// matter which screen the user signed in on.
//
// Flow this serves: a signed-OUT phone scans an Apple TV / remote-box QR
// (https://yaver.io/auth/device?code=ABCD-1234) → app/approve-device.tsx stashes
// the code and sends the user to sign in → after sign-in the approver must
// re-open with that code, or the TV waits forever.
//
// Why a host component and not just a call in the login screen: the drain used
// to live only in app/login.tsx, and browser OAuth on iOS finishes in
// app/oauth-callback.tsx instead, which navigated home and dropped the code
// (see pendingDeviceCode.ts for the two incidents). A host that watches the auth
// transition itself covers every present and future sign-in path — passkey, 2FA,
// email, native Apple, browser OAuth, account merge — because it doesn't care
// which screen minted the session.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, usePathname } from "expo-router";
import { useEffect, useRef } from "react";

import { useAuth } from "../context/AuthContext";
import { appLog } from "./logger";
import {
  PENDING_DEVICE_CODE_KEY,
  type PendingDeviceCodeRead,
  isPendingDeviceCodeShape,
  parsePendingDeviceCode,
  serializePendingDeviceCode,
} from "./pendingDeviceCode";

/** Remember a code across the sign-in round-trip. No-op for a malformed code. */
export async function stashPendingDeviceCode(code: string): Promise<void> {
  const normalized = (code || "").trim().toUpperCase();
  if (!isPendingDeviceCodeShape(normalized)) return;
  try {
    await AsyncStorage.setItem(
      PENDING_DEVICE_CODE_KEY,
      serializePendingDeviceCode(normalized, Date.now()),
    );
    appLog("info", `[tv-approve] stashed device code across sign-in (${normalized})`);
  } catch {
    // Storage failures are not worth blocking sign-in over; the user can still
    // scan again from inside the app (Settings → Sign in a device).
  }
}

/**
 * Read the stash. A stash past the server-side 15-min TTL is cleared and
 * reported as absent — resuming it would only produce a failure on a code the
 * TV has already rotated away from.
 */
export async function readPendingDeviceCode(): Promise<PendingDeviceCodeRead | null> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(PENDING_DEVICE_CODE_KEY);
  } catch {
    return null;
  }
  const pending = parsePendingDeviceCode(raw, Date.now());
  if (raw && !pending) {
    // Unusable value (malformed / not code-shaped) — don't leave it to be
    // re-read on every route change.
    await clearPendingDeviceCode();
    return null;
  }
  if (pending?.stale) {
    appLog(
      "info",
      `[tv-approve] discarding stale device code (${Math.round(pending.ageMs / 1000)}s old, TTL 900s)`,
    );
    await clearPendingDeviceCode();
    return null;
  }
  return pending;
}

export async function clearPendingDeviceCode(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_DEVICE_CODE_KEY);
  } catch {
    // Nothing actionable; a leftover key is bounded by the TTL check above.
  }
}

/**
 * Resume a pending approval right after a successful sign-in.
 *
 * Returns true when it navigated to the approver, so callers can do
 * `if (!(await resumePendingDeviceApproval())) router.replace("/")` and never
 * have to know about device codes. The stash is deliberately NOT cleared here —
 * approve-device.tsx clears it once the approval lands (or the user dismisses
 * it), so a navigation that gets stolen by another redirect is still recoverable
 * by PendingDeviceApprovalHost below.
 */
export async function resumePendingDeviceApproval(): Promise<boolean> {
  const pending = await readPendingDeviceCode();
  if (!pending) return false;
  appLog(
    "info",
    `[tv-approve] resuming approval after sign-in (${pending.code}, ${Math.round(pending.ageMs / 1000)}s old)`,
  );
  router.replace({ pathname: "/approve-device", params: { code: pending.code } });
  return true;
}

/**
 * Mount once near the app root (app/_layout.tsx). Watches for "the user is now
 * signed in" and opens the approver if a code is still waiting — the backstop
 * that makes a dropped resume impossible rather than merely unlikely.
 *
 * Asks at most once per code per app session (`routedFor`), so a user who taps
 * "Not now" is never bounced back into the approver. Dismissal clears the stash
 * on the approver side, which is the other half of that.
 */
export function PendingDeviceApprovalHost() {
  const { isAuthenticated, isLoading } = useAuth();
  const pathname = usePathname();
  const routedFor = useRef<string | null>(null);

  useEffect(() => {
    // Wait for hydration: `isAuthenticated` is false while SecureStore loads,
    // and acting on that would be indistinguishable from a signed-out phone.
    if (isLoading || !isAuthenticated) return;
    // Already looking at the approver — nothing to route.
    if (pathname && pathname.startsWith("/approve-device")) return;

    let cancelled = false;
    (async () => {
      const pending = await readPendingDeviceCode();
      if (cancelled || !pending) return;
      if (routedFor.current === pending.code) return;
      routedFor.current = pending.code;
      appLog(
        "info",
        `[tv-approve] pending approval found on ${pathname || "(unknown route)"} — opening approver`,
      );
      router.navigate({ pathname: "/approve-device", params: { code: pending.code } } as any);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isLoading, pathname]);

  return null;
}
