/**
 * relayAuth.ts — tells a RELAY credential rejection apart from an AGENT one.
 *
 * Incident (live audit, 2026-07-28): a stale web session meant
 * `GET /settings` 401'd, refreshRelayTopology silently swallowed it, relays
 * got no per-user password, and every probe to `public.yaver.io/d/<id>/...`
 * came back 401 `{"code":"Unauthorized","error":"relay password missing —
 * sign in again to fetch it"}`. The dashboard then rendered "Agent responded,
 * but the connection was rejected" — blaming the AGENT for a RELAY credential
 * failure, while a fresh sign-in fixed everything.
 *
 * The relay's own 401 bodies (relay/server.go, the /d/ proxy auth ladder):
 *   - "relay password missing — sign in again to fetch it"
 *   - "invalid relay password"
 *   - 429 "too many invalid relay password attempts"
 *
 * FIXED 2026-07-28 (relay side): `code` used to be http.StatusText — the
 * literal "Unauthorized" every 401 carries — which is exactly what the device
 * card rendered as the DEVICE's verdict. The relay now emits STABLE codes
 * (`relay_password_missing`, `relay_password_invalid`,
 * `relay_password_rate_limited`, `relay_auth_backend_unavailable`,
 * `relay.device_not_connected`, `relay.device_owner_mismatch`) alongside the
 * unchanged prose.
 *
 * THE PROSE FALLBACK STAYS. public.yaver.io is redeployed by MANUAL scp
 * (memory/project_public_relay_deploy_drift), so until that redeploy the live
 * relay still answers with code:"Unauthorized" — and old relays, self-hosted
 * relays and pinned agents will keep doing so long after. Code first, prose
 * second, forever.
 *
 * Semantics mirror mobile's unified classifier
 * (mobile/src/lib/relayAuth.ts::isRelayAuthFailure, commit 43b40bcbe): a
 * relay-credential 401 means "refresh credentials / sign in again", never
 * "the agent rejected you". Web additionally needs the narrower question —
 * "is this 401 the RELAY's own verdict?" — because a 401 *body from the
 * agent* (e.g. "invalid token") travels through a perfectly working relay
 * lane and must keep the agent-rejection copy.
 */

/** The relay's STABLE machine-readable deny codes. Mirrors the Go constants in
 *  relay/abuse_guard.go — compare exact strings, never guess the separator
 *  (the password codes are snake_case, the device/tunnel codes are dotted,
 *  because `relay.device_not_connected` shipped first). */
export const RELAY_DENY_CODES = {
  passwordMissing: "relay_password_missing",
  passwordInvalid: "relay_password_invalid",
  passwordRateLimited: "relay_password_rate_limited",
  authBackendUnavailable: "relay_auth_backend_unavailable",
  deviceNotConnected: "relay.device_not_connected",
  deviceOwnerMismatch: "relay.device_owner_mismatch",
} as const;

/** Codes that mean "the RELAY refused THIS caller's credential" — the class a
 *  credential refresh / fresh sign-in repairs. Deliberately NOT including
 *  `authBackendUnavailable` (nothing is wrong with the credential; retry) nor
 *  the device codes (the relay authorized us fine; the tunnel is the problem). */
const RELAY_CREDENTIAL_DENY_CODES: ReadonlySet<string> = new Set([
  RELAY_DENY_CODES.passwordMissing,
  RELAY_DENY_CODES.passwordInvalid,
  RELAY_DENY_CODES.passwordRateLimited,
]);

/** True when `code` is one of the relay's stable credential-deny codes. No
 *  regex, no prose, no locale. Returns false for "Unauthorized" — the old
 *  http.StatusText value — so an un-upgraded relay falls through to the prose
 *  path rather than being misread either way. */
export function isRelayCredentialDenyCode(
  code: string | null | undefined,
): boolean {
  if (!code) return false;
  return RELAY_CREDENTIAL_DENY_CODES.has(code.trim());
}

/** Pull the relay's stable `code` out of a body that may be a raw JSON string
 *  or a wrapper the client built around it ("HTTP 401: {…}", "Relay
 *  authentication failed. … {…}"). Web probes stringify the body into the
 *  error message, so this is how a code survives to the classifiers below
 *  without every call site having to be rewritten. */
export function relayDenyCodeFromBody(
  body: string | null | undefined,
): string | null {
  if (!body) return null;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const code = (parsed as { code?: unknown }).code;
    return typeof code === "string" && code.trim() ? code.trim() : null;
  } catch {
    return null;
  }
}

/** True when the message is one of the RELAY's OWN credential-rejection
 *  bodies — i.e. the relay refused for lack of/invalid account relay
 *  password, and the request never reached the agent. False for agent-side
 *  401 bodies ("invalid token", "unauthorized", ...) that merely transited
 *  the relay.
 *
 *  Code first: if the body carries a stable relay code, that is the answer and
 *  no substring is consulted. Prose second, for relays that predate the codes. */
export function isRelayCredentialDenyMessage(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  const code = relayDenyCodeFromBody(message);
  if (code) {
    // A stable code is authoritative in BOTH directions — including telling us
    // this was a device/tunnel failure, not a credential one.
    if (isRelayCredentialDenyCode(code)) return true;
    if (
      code === RELAY_DENY_CODES.deviceNotConnected ||
      code === RELAY_DENY_CODES.deviceOwnerMismatch ||
      code === RELAY_DENY_CODES.authBackendUnavailable
    ) {
      return false;
    }
  }
  const m = message.toLowerCase();
  return (
    m.includes("relay password missing") ||
    m.includes("invalid relay password") ||
    m.includes("relay password mismatch") ||
    m.includes("too many invalid relay password attempts") ||
    m.includes("reason=bad_password") ||
    // relayStatusHint(401) prefix the web client itself adds to relay-lane
    // 401 bodies (agent-client.ts::responseErrorMessage).
    m.includes("relay authentication failed")
  );
}

/** Broad parity with mobile's isRelayAuthFailure: any relay-lane failure
 *  that a credential refresh (re-pulling the relay password after sign-in)
 *  can repair — worded forms plus the bare "relay … 401/403" leg strings. */
export function isRelayAuthFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  if (isRelayCredentialDenyMessage(message)) return true;
  const m = message.toLowerCase();
  if (m.includes("reason=dead_token")) return true;
  const mentionsRelay = m.includes("relay");
  if (
    mentionsRelay &&
    (m.includes("http 401") || m.includes("http 403") || m.includes(" 401") || m.includes(" 403"))
  ) {
    return true;
  }
  return false;
}

/** Diagnostic-shaped helper for the connect-error panel: true when this
 *  attempt is a relay-lane 401/403 whose body is the relay's own credential
 *  verdict. `path` must be the relay leg — an agent 401 that transited the
 *  relay still carries the agent's body and correctly returns false via
 *  isRelayCredentialDenyMessage. */
export function isRelayCredentialDeny(diag: {
  path?: string;
  status?: number;
  error?: string;
  /** The relay body's stable `code`, when the caller parsed the body itself.
   *  Takes priority over the prose in `error`. */
  code?: string;
}): boolean {
  if (diag.path !== "relay") return false;
  if (diag.status !== 401 && diag.status !== 403 && diag.status !== undefined) return false;
  if (isRelayCredentialDenyCode(diag.code)) return true;
  return isRelayCredentialDenyMessage(diag.error);
}

/** Diagnostic-shaped helper: the relay ANSWERED, and had nothing to forward to.
 *
 *  This is the unfixed half of the 2026-07-28 misattribution. That incident
 *  taught the panel that a relay 401 is not the agent's verdict; the 502 case
 *  was left behind, and it is the one that actually fires when a box's session
 *  dies. Live on ubuntu-4gb-hel1-1 (2026-07-31): the box's Convex session
 *  expired, so the relay refused its registration and held no tunnel, so every
 *  web probe came back 502 — and `anyReached` (status > 0) read that as "the
 *  agent responded". The panel then said "Agent responded, but the connection
 *  was rejected" about a machine the relay had never been able to contact, and
 *  offered a re-auth flow that rides the very tunnel that is missing.
 *
 *  A gateway status on the RELAY leg means the opposite of reached. Callers
 *  must therefore exclude these from any "did anything answer" tally, not just
 *  order the headline around them. */
export function isRelayTunnelDown(diag: {
  path?: string;
  status?: number;
  error?: string;
  /** The relay body's stable `code`, when the caller parsed it. */
  code?: string;
}): boolean {
  if (diag.path !== "relay") return false;
  // A credential deny is a different failure with a different remedy; never
  // let one be counted as both.
  if (isRelayCredentialDenyCode(diag.code)) return false;
  const code = diag.code?.trim() || relayDenyCodeFromBody(diag.error);
  if (
    code === RELAY_DENY_CODES.deviceNotConnected ||
    code === RELAY_DENY_CODES.deviceOwnerMismatch
  ) {
    return true;
  }
  if (code && isRelayCredentialDenyCode(code)) return false;
  // Prose/status fallback for relays that predate the stable codes — which is
  // every deployed one until public.yaver.io is redeployed by hand
  // (memory/project_public_relay_deploy_drift).
  return diag.status === 502 || diag.status === 503 || diag.status === 504;
}

/** The copy every surface should render when the relay has no tunnel to the
 *  box. It must NOT suggest anything that travels through the relay, because
 *  nothing can: the only lever is on the machine itself. */
export const RELAY_TUNNEL_DOWN_REMEDY =
  "The relay is up but has no tunnel to this machine, so nothing reached the agent. " +
  "That is what a box with an expired session looks like from here — it cannot register with the relay. " +
  "Run `yaver auth` on the machine itself; re-auth from the web rides the tunnel that is missing.";

/** The copy every surface should render for a relay credential deny. */
export const RELAY_CREDENTIAL_REMEDY =
  "The relay refused the request because this browser has no valid account relay password — " +
  "the agent never saw it. Signing in again refreshes the relay password and reconnects.";
