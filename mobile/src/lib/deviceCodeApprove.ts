// deviceCodeApprove — phone-side one-tap approval of a remote box's
// `yaver auth` device code.
//
// The friction this removes: a remote/off-LAN dev box (SSH, cloud,
// laptop on another network) can't be silently adopted over the LAN
// beacon, so today it prints a device code + URL and the user has to
// open a BROWSER and sign in AGAIN. But the phone is already signed in.
// If the box's QR / URL routes into the app instead of the browser,
// the phone can authorize the box with one tap using its existing
// session token — no browser, no re-auth, no code typed.
//
// Same Convex HTTP contract the web approver
// (web/app/auth/device) uses, driven by the phone's bearer token:
//   - GET  /auth/device-code/info?user_code=ABCD-1234   (public — machine details)
//   - POST /auth/device-code/authorize                  (Bearer token + {userCode})
//
// authorizeDeviceCode (backend/convex/deviceCode.ts) derives the user
// from the bearer token, marks the code authorized, mints a 1-year
// session, and stashes the token for the box's poller to pick up. The
// box's `yaver auth` loop then finishes on its own within ~5s.
//
// fetch pattern mirrors src/lib/auth.ts::startAccountMerge (getConvexSiteUrl
// + Bearer) — there is no shared apiFetch helper in this app.

import { getConvexSiteUrlSync as getConvexSiteUrl } from "./backendConfig";
import { approveFailureMessage } from "./approveFailureMessage";
import { normalizeUserCode } from "./deviceCodeQr";

export { approveFailureMessage };
export { extractScannedDeviceCode, extractUserCode, normalizeUserCode } from "./deviceCodeQr";

export interface DeviceCodeInfo {
  /** Hostname the box reported when it created the code. */
  machineName?: string;
  platform?: string;
  arch?: string;
  shell?: string;
  status?: "pending" | "authorized" | "expired";
  claimed?: boolean;
  approvedAt?: number | null;
  claimedAt?: number | null;
  /** Unix ms when the code expires (codes are 15-min TTL). */
  expiresAt?: number;
  /** Some deployments echo the normalized code back. */
  userCode?: string;
}

export type DeviceCodeInfoResult =
  | { kind: "found"; info: DeviceCodeInfo }
  | { kind: "not_found" }
  | { kind: "unreachable"; message: string };

/** Fetch the waiting box's details so the approve screen can show
 *  "Approve sign-in on <machine>?" instead of an opaque code. Public
 *  endpoint — no token needed. Keeps expiry/not-found distinct from a
 *  transport failure so the phone never falsely tells the user to rescan. */
export async function fetchDeviceCodeInfoResult(
  userCode: string,
  timeoutMs = APPROVE_TIMEOUT_MS,
): Promise<DeviceCodeInfoResult> {
  const code = normalizeUserCode(userCode);
  if (!code) return { kind: "not_found" };
  try {
    const res = await boundedFetch(
      `${getConvexSiteUrl()}/auth/device-code/info?user_code=${encodeURIComponent(code)}`,
      undefined,
      timeoutMs,
    );
    if (res.status === 404 || res.status === 410) return { kind: "not_found" };
    if (!res.ok) {
      return { kind: "unreachable", message: `Yaver could not verify the TV (${res.status}). Try again.` };
    }
    return { kind: "found", info: (await res.json()) as DeviceCodeInfo };
  } catch (err: any) {
    return {
      kind: "unreachable",
      message: err?.name === "AbortError"
        ? "TV verification timed out. Check your connection and try again."
        : "Couldn't reach Yaver to verify this TV. Check your connection and try again.",
    };
  }
}

/** Back-compatible nullable helper for status-only callers. New approval UI
 * must use fetchDeviceCodeInfoResult so transport failure is not called expiry. */
export async function fetchDeviceCodeInfo(userCode: string): Promise<DeviceCodeInfo | null> {
  const result = await fetchDeviceCodeInfoResult(userCode);
  return result.kind === "found" ? result.info : null;
}

/**
 * Both calls here are request/response, so both are wall-clock bounded.
 *
 * RN's `fetch` has NO default timeout — it hangs forever — and that is not
 * hypothetical on this screen: an unbounded await on the rescue path leaves the
 * Approve button spinning with no cause while the machine it was meant to
 * rescue stays dead. Same law that produced ConnectAttemptGuard after
 * NetInfo.fetch() pinned the pill at "Connecting" for 30+ minutes.
 *
 * AbortController, not a bare race, so the socket is actually released rather
 * than abandoned while still holding a connection.
 */
const APPROVE_TIMEOUT_MS = 12_000;

async function boundedFetch(url: string, init?: RequestInit, timeoutMs = APPROVE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}


export interface ApproveResult {
  ok: boolean;
  error?: string;
}

/**
 * Authorize the box's device code using THIS phone's session token.
 * Mirrors the web approver's POST so the backend treats it identically.
 * `token` is the phone's bearer (from useAuth). On success the box's
 * own `yaver auth` poller finishes within ~5s.
 */
export async function approveDeviceCode(userCode: string, token: string): Promise<ApproveResult> {
  const code = normalizeUserCode(userCode);
  if (!code) return { ok: false, error: "That code looks malformed." };
  if (!token) return { ok: false, error: "Sign in on this phone first, then approve." };
  try {
    const res = await boundedFetch(`${getConvexSiteUrl()}/auth/device-code/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ userCode: code, convexUrl: getConvexSiteUrl() }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: approveFailureMessage(res.status, detail) };
    }
    return { ok: true };
  } catch (err: any) {
    // An abort is the deadline firing, not a mystery — say which one it was.
    if (err?.name === "AbortError") {
      return {
        ok: false,
        error: "The approval request timed out. Check your connection and try again.",
      };
    }
    return { ok: false, error: "Couldn't reach Yaver to approve the machine. Check your connection." };
  }
}
