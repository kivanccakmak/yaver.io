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

export function isRelayAuthFailure(message: string | null | undefined): boolean {
  if (!message) return false;
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
