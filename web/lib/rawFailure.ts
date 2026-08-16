/**
 * rawFailure.ts — turn a browser-raw failure into a sentence a human can act on.
 *
 * WHY THIS EXISTS (incident 2026-07-27, production yaver.io)
 * ---------------------------------------------------------
 * A user on Vibing → Runtime picked a runner + model and clicked "Save for
 * machine". They got `failed to fetch`.
 *
 * `Failed to fetch` (Safari: `Load failed`, Firefox: `NetworkError when
 * attempting to fetch resource`) is not an application error at all — it is
 * the TypeError the browser throws when a request never produced a *readable*
 * response. It carries no status, no body, no URL. Every distinct cause
 * collapses into that one string:
 *
 *   - the response came back but without `Access-Control-Allow-Origin`, so the
 *     browser refused to hand it to JS (this was the live root cause: Convex's
 *     uncaught-exception 500 for an expired session ships no CORS header —
 *     verified with curl against POST /settings, see backend/convex/http.ts);
 *   - DNS / TLS / connection failure;
 *   - the tab is offline;
 *   - an extension or proxy blocked the request.
 *
 * Rendering that string — or worse, rendering nothing, which is what actually
 * happened because the caller had no catch — is the customer-facing shape of
 * "the inventory says yes while the operation says no". This module is the ONE
 * place that names it. `describeRawFailure` returns `null` for failures that
 * are already self-describing (an HTTP status with a message, an intentional
 * abort); it only speaks when the alternative is a bare TypeError.
 */

/** Browser strings for "the request produced no readable response". They are
 *  engine-specific and there is no error code to key off — the message text is
 *  genuinely the only signal a page gets. */
const RAW_NETWORK_RE =
  /failed to fetch|load failed|networkerror when attempting|network request failed|fetch failed|network error/i;

/** Convex session / bearer-token rejections, which reach us either as a real
 *  401 or (when the backend throws) as the CORS-less 500 above. */
const AUTH_SHAPED_RE =
  /unauthorized|forbidden|session expired|invalid token|http 401|http 403/i;

export type RawFailureKind = "offline" | "auth" | "unreachable";

/**
 * SessionDeathError — thrown/announced by a call site that CAUGHT a 401 from
 * a Convex route while a token was present (the session is dead, not absent).
 *
 * Incident (2026-07-28): `GET /settings` returned 401 for a stale token,
 * refreshRelayTopology swallowed it, the relays got no per-user password, and
 * every relay probe 401'd — devices looked broken while a fresh sign-in fixed
 * everything. The session's death must NAME ITSELF instead of cascading into
 * misattributed connectivity errors. Announce via
 * `announceRawFailure(new SessionDeathError(...))` — describeRawFailure maps
 * it to the dedicated banner below.
 */
export class SessionDeathError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "SessionDeathError";
  }
}

export interface NamedFailure {
  kind: RawFailureKind;
  /** Short headline for the banner. Never a status code, never a TypeError. */
  title: string;
  /** What actually happened, including the fact that nothing was saved. */
  detail: string;
  /** The route out, phrased as an instruction. */
  action: string;
  /** True when clicking the same button again is a sensible next step. */
  retryable: boolean;
  /** True when the fix is re-authenticating rather than retrying. */
  needsSignIn: boolean;
  /** The original text, kept for the "copy details" affordance. */
  raw: string;
}

export function rawFailureMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name || "";
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object" && "message" in reason) {
    return String((reason as { message?: unknown }).message ?? "");
  }
  return "";
}

/** An abort is a deliberate cancellation (unmount, navigation, a newer
 *  request superseding this one). Surfacing it would be noise, not truth. */
export function isDeliberateAbort(reason: unknown): boolean {
  if (reason instanceof Error && reason.name === "AbortError") return true;
  return /aborted|abortederror|the operation was aborted|the user aborted/i.test(
    rawFailureMessage(reason),
  );
}

export function isRawNetworkFailure(reason: unknown): boolean {
  if (isDeliberateAbort(reason)) return false;
  return RAW_NETWORK_RE.test(rawFailureMessage(reason));
}

export function isAuthShapedFailure(reason: unknown): boolean {
  return AUTH_SHAPED_RE.test(rawFailureMessage(reason));
}

export interface DescribeRawFailureOptions {
  /** navigator.onLine at the time of the failure. Pass explicitly so this
   *  module stays pure and testable without a DOM. */
  online?: boolean;
  /** What the user was doing, e.g. "Save for machine". Rendered verbatim. */
  operation?: string;
}

/**
 * Map a thrown/rejected value to a sentence, or `null` when the caller should
 * stay quiet because the failure already explains itself.
 *
 * The gate is deliberately narrow: we only speak for (a) bare network
 * TypeErrors and (b) auth-shaped rejections, because those are the two that
 * reach a user as an unactionable blob. Anything else already carries a
 * message its own call site is responsible for rendering.
 */
export function describeRawFailure(
  reason: unknown,
  options: DescribeRawFailureOptions = {},
): NamedFailure | null {
  if (isDeliberateAbort(reason)) return null;
  const raw = rawFailureMessage(reason);

  // A call site explicitly reported that the signed-in session is dead. This
  // outranks the generic auth shape: the copy must say what BREAKS (machines
  // unreachable — without a session there is no relay password) and what fixes
  // it (sign in again), not "nothing was saved".
  if (reason instanceof SessionDeathError) {
    return {
      kind: "auth",
      title: "Your sign-in has expired",
      detail:
        "Sign in again to reconnect to your machines. Without a valid session the " +
        "dashboard cannot fetch your account's relay password, so every relay " +
        "connection is rejected and devices look unreachable when they are fine.",
      action: "Sign in again — a fresh session refreshes the relay password and reconnects.",
      retryable: false,
      needsSignIn: true,
      raw,
    };
  }

  const network = isRawNetworkFailure(reason);
  const auth = isAuthShapedFailure(reason);
  if (!network && !auth) return null;

  const what = options.operation ? `“${options.operation}” ` : "";

  if (network && options.online === false) {
    return {
      kind: "offline",
      title: "You are offline",
      detail: `${what}never left this browser — your device reports no network connection. Nothing was saved.`,
      action: "Reconnect to Wi-Fi or cellular, then try again.",
      retryable: true,
      needsSignIn: false,
      raw,
    };
  }

  if (auth && !network) {
    return {
      kind: "auth",
      title: "Your sign-in session expired",
      detail: `${what}was refused because this browser's Yaver session is no longer valid. Nothing was saved.`,
      action: "Sign out and sign in again, then retry.",
      retryable: false,
      needsSignIn: true,
      raw,
    };
  }

  // The hard case: a bare TypeError with no status and no body. We must NOT
  // claim to know which cause it was — but we must name the candidates and the
  // single most common one, because "failed to fetch" alone teaches nothing.
  return {
    kind: "unreachable",
    title: "That change never reached the server",
    detail:
      `${what}got no readable response — the browser reports a bare network failure, ` +
      "which carries no status code. Nothing was saved. The usual causes, most likely first: " +
      "an expired sign-in session, a dropped connection, or a browser extension blocking the request.",
    action:
      "Retry once. If it fails again, sign out and sign in — a stale session makes writes fail while reads keep working.",
    retryable: true,
    needsSignIn: false,
    raw,
  };
}
