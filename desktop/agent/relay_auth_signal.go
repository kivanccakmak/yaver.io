package main

import "sync/atomic"

// Process-wide "is this box's Convex session dead?" signal.
//
// Incident 2026-07-31 (ubuntu-4gb-hel1-1, magara). The box's session token
// expired. The relay refused every registration for hours with the legacy
// collapsed prose:
//
//	registration rejected: invalid relay password
//
// classifyRelayAuthFailure could not see a `reason=` code — the DEPLOYED relay
// was 0.1.19 and the structured codes only landed in 0.1.23 — so it took the
// legacy fallthrough ("password" + "invalid") and answered relayAuthBadPassword.
// That routed the failure into refreshRelayPasswordFromConvex, a call which
// needs the very token that is dead in order to answer. It returned the same
// stale password, the retry guard failed, and the loop fell through to backoff
// SILENTLY, forever. repairRelaySessionToken — the actual remedy, sitting one
// case above — was never reached.
//
// The agent did not need the relay to tell it what was wrong: it already knew
// its own session was expired. It simply had no way to say so from inside the
// relay goroutine, which holds no HTTPServer pointer.
//
// So the flag mirrors itself. sessionExpiredFlag is used as the type of
// HTTPServer.authExpired, which means all twelve existing
// `authExpired.Store(...)` call sites keep the mirror current without being
// touched — a mirror you have to remember to update is a mirror that drifts.
var agentSessionExpired atomic.Bool

// sessionExpiredFlag is an atomic.Bool that also publishes to the process-wide
// mirror above. Load/CompareAndSwap/Swap come from the embedded atomic.Bool
// unchanged; only Store is widened.
//
// Embedding (not aliasing) is deliberate: HTTPServer already contains sync.Map
// and sync.RWMutex, so it is non-copyable already and `go vet`'s copylocks
// check keeps it that way.
type sessionExpiredFlag struct {
	atomic.Bool
}

// Store records the value locally AND in the process-wide mirror.
func (f *sessionExpiredFlag) Store(v bool) {
	f.Bool.Store(v)
	agentSessionExpired.Store(v)
}

// agentSessionKnownExpired reports whether the daemon has already observed its
// own Convex session to be dead (heartbeat 401, recovery probe, pairing loss).
//
// "Known" is the operative word, and the default matters: before the first
// heartbeat completes this is false, i.e. "no evidence of death". A false
// negative is safe — the caller degrades to the previous behaviour. A false
// POSITIVE would send a healthy box into re-auth, so nothing may set this
// optimistically.
func agentSessionKnownExpired() bool {
	return agentSessionExpired.Load()
}
