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
 * The relay's own 401 bodies (relay/server.go:1903 via writeRelayError, and
 * the inline map at relay/server.go:1916):
 *   - "relay password missing — sign in again to fetch it"
 *     (body: {ok:false, code:"Unauthorized", error, message})
 *   - "invalid relay password"                (body: {error})
 *   - 429 "too many invalid relay password attempts"
 * NOTE: the `code` field is just http.StatusText ("Unauthorized"), which any
 * 401 carries — the relay should grow a STABLE machine code (e.g.
 * "relay_password_missing") so clients stop matching message substrings.
 * Until then, substrings on the relay's exact strings are the only signal.
 *
 * Semantics mirror mobile's unified classifier
 * (mobile/src/lib/relayAuth.ts::isRelayAuthFailure, commit 43b40bcbe): a
 * relay-credential 401 means "refresh credentials / sign in again", never
 * "the agent rejected you". Web additionally needs the narrower question —
 * "is this 401 the RELAY's own verdict?" — because a 401 *body from the
 * agent* (e.g. "invalid token") travels through a perfectly working relay
 * lane and must keep the agent-rejection copy.
 */

/** True when the message is one of the RELAY's OWN credential-rejection
 *  bodies — i.e. the relay refused for lack of/invalid account relay
 *  password, and the request never reached the agent. False for agent-side
 *  401 bodies ("invalid token", "unauthorized", ...) that merely transited
 *  the relay. */
export function isRelayCredentialDenyMessage(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
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
}): boolean {
  if (diag.path !== "relay") return false;
  if (diag.status !== 401 && diag.status !== 403 && diag.status !== undefined) return false;
  return isRelayCredentialDenyMessage(diag.error);
}

/** The copy every surface should render for a relay credential deny. */
export const RELAY_CREDENTIAL_REMEDY =
  "The relay refused the request because this browser has no valid account relay password — " +
  "the agent never saw it. Signing in again refreshes the relay password and reconnects.";
