package main

import (
	"errors"
	"testing"
)

// The 2026-07-31 outage in one assertion.
//
// ubuntu-4gb-hel1-1's session token was dead. The DEPLOYED relay was 0.1.19,
// which predates the structured `reason=` codes, so it refused registration
// with collapsed prose that names only the password. The agent believed it and
// spent hours refetching a password it could never refetch.
//
// The relay could not tell the truth. The box already knew it.
func TestClassifyRelayAuthFailure_LegacyProseWithDeadSessionIsDeadToken(t *testing.T) {
	// Verbatim from the box's journal on 2026-07-31.
	err := errors.New("registration rejected: invalid relay password")

	got := classifyRelayAuthFailureWithSignals(err, true /* session known expired */)
	if got != relayAuthDeadToken {
		t.Fatalf("legacy refusal + known-dead session: got %v, want relayAuthDeadToken.\n"+
			"This is the exact misclassification that made the box retry a "+
			"deterministically-invalid credential every 60s for hours while "+
			"repairRelaySessionToken sat one case away, unreachable.", got)
	}
}

// NEGATIVE CONTROL — the guard must not fire without evidence.
//
// If this ever starts returning relayAuthDeadToken, we have broken self-heal
// for the genuine case the legacy branch was written for: a healthy box whose
// per-user relay password was rotated server-side. That box CAN fix itself by
// refetching, and must keep doing so.
func TestClassifyRelayAuthFailure_LegacyProseWithLiveSessionStaysBadPassword(t *testing.T) {
	err := errors.New("registration rejected: invalid relay password")

	got := classifyRelayAuthFailureWithSignals(err, false /* no evidence of a dead session */)
	if got != relayAuthBadPassword {
		t.Fatalf("legacy refusal + live session: got %v, want relayAuthBadPassword "+
			"(a rotated password must still self-heal on old relays)", got)
	}
}

// A modern relay knows which credential it rejected. Its verdict is
// authoritative and must survive a stale local session flag — otherwise a box
// with a genuinely bad password would be sent into re-auth forever, which is
// the same bug wearing the opposite mask.
func TestClassifyRelayAuthFailure_ReasonCodeBeatsLocalSignal(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want relayAuthFailureKind
	}{
		{"bad_password", errors.New("invalid relay password (reason=bad_password)"), relayAuthBadPassword},
		{"device_mismatch", errors.New("relay password owner does not own this deviceId (reason=device_mismatch)"), relayAuthDeviceMismatch},
		{"dead_token", errors.New("relay session expired (reason=dead_token)"), relayAuthDeadToken},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Session flag set BOTH ways — the reason code must win either way.
			for _, expired := range []bool{true, false} {
				if got := classifyRelayAuthFailureWithSignals(tc.err, expired); got != tc.want {
					t.Fatalf("sessionExpired=%v: got %v, want %v (relay verdict must be authoritative)",
						expired, got, tc.want)
				}
			}
		})
	}
}

// Ordinary transport failures must stay unclassified. They flow down the plain
// backoff path, and misreading one as a credential failure would send a box
// with a flapping network into a pointless re-auth.
func TestClassifyRelayAuthFailure_TransportErrorsStayUnknown(t *testing.T) {
	for _, msg := range []string{
		"dial quic: connection refused",
		"timeout: no recent network activity",
		"context deadline exceeded",
	} {
		if got := classifyRelayAuthFailureWithSignals(errors.New(msg), true); got != relayAuthUnknown {
			t.Fatalf("%q: got %v, want relayAuthUnknown", msg, got)
		}
	}
}

// The mirror must be automatic. HTTPServer.authExpired has twelve Store call
// sites; if keeping the process-wide signal current were a thing each caller
// had to remember, it would be stale on at least one path within a release.
func TestSessionExpiredFlag_MirrorsToProcessWideSignal(t *testing.T) {
	restore := agentSessionExpired.Load()
	t.Cleanup(func() { agentSessionExpired.Store(restore) })

	var f sessionExpiredFlag

	f.Store(true)
	if !f.Load() {
		t.Fatal("local Load() did not observe Store(true)")
	}
	if !agentSessionKnownExpired() {
		t.Fatal("Store(true) did not reach the process-wide mirror — " +
			"the relay goroutine holds no HTTPServer pointer and reads only the mirror")
	}

	f.Store(false)
	if agentSessionKnownExpired() {
		t.Fatal("Store(false) did not clear the process-wide mirror — " +
			"a box that recovered would stay flagged and re-auth in a loop")
	}
}
