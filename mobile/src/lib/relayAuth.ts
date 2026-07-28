// relayAuth.ts — the ONE relay-auth-failure classifier.
//
// CLAUDE.md flags it by name: "mobile already carries THREE different relay-auth
// matchers, none a superset of the others." They were:
//   - DeviceContext.isRelayAuthError  → gates the connect() refresh-retry
//   - quic.ts isRelayAuthShaped       → gates the scheduleReconnect repair rung
//   - quic.ts relayStatusHint(401)    → produces the message the others match on
// The gap that actually bit (2026-07-28, sim stuck "Connecting"): when the relay
// rejects a wrong/stale relay password it returns 401, and probeRelayServers
// stringifies that as "Relay <id> returned HTTP 401" — a message containing
// NONE of the phrases any matcher looked for. So the relay-credential refresh —
// the ONE thing that fixes a stale relay password — never fired, and the box
// stayed unreachable on the exact failure a refresh repairs.
//
// This is the single source of truth. It matches the worded forms AND the bare
// "HTTP 401/403 on the relay leg" form, so it is robust to message wording.
// Pure + dependency-free → unit-tested by the `npx tsx` harness and importable
// by every surface that has to decide "should I refresh relay creds and retry?"

/** The relay's STABLE machine-readable deny codes (relay/abuse_guard.go).
 *
 * Before these existed, the relay's `code` field was http.StatusText — the
 * literal "Unauthorized" that EVERY 401 carries — so there was no signal to
 * key off and every surface regexed English. That is the entire reason the
 * three drifting matchers above existed.
 *
 * The prose matching below is NOT dead code and must not be deleted:
 * public.yaver.io is redeployed by MANUAL scp
 * (memory/project_public_relay_deploy_drift), self-hosted relays lag
 * arbitrarily, and this app has to keep working against both. Code first,
 * prose second. */
export const RELAY_DENY_CODES = {
  passwordMissing: "relay_password_missing",
  passwordInvalid: "relay_password_invalid",
  passwordRateLimited: "relay_password_rate_limited",
  authBackendUnavailable: "relay_auth_backend_unavailable",
  deviceNotConnected: "relay.device_not_connected",
  deviceOwnerMismatch: "relay.device_owner_mismatch",
} as const;

/** Codes meaning "the RELAY refused THIS caller's credential" — the class a
 *  relay-credential refresh repairs. `authBackendUnavailable` is excluded on
 *  purpose: the credential is fine, the backend is down, and "self-healing" a
 *  working password on a Convex blip is what turned a hiccup into a fleet-wide
 *  outage once already. The device codes are excluded because the relay
 *  authorized us — the tunnel is the problem. */
const RELAY_CREDENTIAL_DENY_CODES: ReadonlySet<string> = new Set([
  RELAY_DENY_CODES.passwordMissing,
  RELAY_DENY_CODES.passwordInvalid,
  RELAY_DENY_CODES.passwordRateLimited,
]);

/** True when `code` is one of the relay's stable credential-deny codes.
 *  Exact-match only — false for "Unauthorized" so an un-upgraded relay falls
 *  through to the prose path instead of being misclassified. */
export function isRelayDenyCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return RELAY_CREDENTIAL_DENY_CODES.has(code.trim());
}

/** Extract the relay's stable `code` from a body that may be raw JSON or
 *  wrapped by the client ("Relay <id> returned HTTP 401: {…}"). The connect
 *  ladder stringifies bodies into messages, so this is how the code reaches
 *  isRelayAuthFailure without rewriting every call site. */
export function relayDenyCodeFromBody(body: string | null | undefined): string | null {
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

export function isRelayAuthFailure(message: string | null | undefined): boolean {
  if (!message) return false;

  // Code first — a stable code is authoritative in BOTH directions, so a
  // relay.device_not_connected 502 can no longer be swept up by the bare
  // "relay … 40x" prose leg below and mistaken for a credential problem.
  const code = relayDenyCodeFromBody(message);
  if (code) {
    if (isRelayDenyCode(code)) return true;
    if (
      code === RELAY_DENY_CODES.deviceNotConnected ||
      code === RELAY_DENY_CODES.deviceOwnerMismatch ||
      code === RELAY_DENY_CODES.authBackendUnavailable
    ) {
      return false;
    }
  }

  const m = message.toLowerCase();

  // Worded forms produced by relayStatusHint / the relay / the agent.
  if (
    m.includes("relay authentication failed") ||
    m.includes("invalid relay password") ||
    m.includes("invalid relay") ||
    m.includes("relay password mismatch") ||
    m.includes("relay password") ||
    m.includes("too many invalid relay password attempts") ||
    m.includes("reason=bad_password") ||
    m.includes("reason=dead_token")
  ) {
    return true;
  }

  // Bare status form: the relay rejects a bad/missing relay password with 401
  // (verified live against public.yaver.io 2026-07-28: owner token + wrong
  // relay pw → 401). 403 covers "too many attempts" throttling. Scope the
  // status match to the relay leg so a 401/403 from some OTHER transport isn't
  // misread as a relay-credential problem.
  const mentionsRelay = m.includes("relay");
  if (mentionsRelay && (m.includes("http 401") || m.includes("http 403") || m.includes(" 401") || m.includes(" 403"))) {
    return true;
  }

  return false;
}
