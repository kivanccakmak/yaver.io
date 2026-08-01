package main

import (
	"errors"
	"strings"
	"testing"
)

// Verbatim from ubuntu-4gb-hel1-1, 2026-08-01, after public.yaver.io restarted
// onto an ephemeral key.
const realPinMismatchErr = "dial relay: CRYPTO_ERROR 0x12a (local): relay 46.224.110.38:4433 " +
	"SPKI pin mismatch: expected inNVAkIr2T7gJ/pLlP5QNjnicyDAwqwnKVT2PSnQjpI=, " +
	"got 8zLwlbw+Nh5aTWr4lil/kBZVFS78XPPkDVEU6oXJRGA= — refusing (possible MITM)"

// A pin mismatch aborts the TLS handshake, so no credential was ever sent. If
// it fell through to the credential branches the agent would blame a password
// for a failure that never reached authentication — and, worse, would "self
// heal" by refetching a password that was never the problem.
func TestClassifyRelayAuthFailure_PinMismatchIsItsOwnKind(t *testing.T) {
	got := classifyRelayAuthFailureWithSignals(errors.New(realPinMismatchErr), false)
	if got != relayAuthPinMismatch {
		t.Fatalf("got %v, want relayAuthPinMismatch", got)
	}
}

// The dead-session signal must NOT capture a pin mismatch. This is the exact
// pair that occurred on 2026-08-01 — an expired session AND a rotated relay key
// at the same moment — and conflating them sends the operator to `yaver auth`
// for a problem re-auth cannot fix.
func TestClassifyRelayAuthFailure_PinMismatchBeatsDeadSessionSignal(t *testing.T) {
	got := classifyRelayAuthFailureWithSignals(errors.New(realPinMismatchErr), true /* session known expired */)
	if got != relayAuthPinMismatch {
		t.Fatalf("with an expired session too: got %v, want relayAuthPinMismatch "+
			"(re-auth cannot fix a rotated relay identity)", got)
	}
}

// The word "password" appears nowhere in a pin mismatch, but "rejected" and
// "refusing" do. Pin the boundary so a future edit to the credential matcher
// cannot start swallowing handshake failures.
func TestClassifyRelayAuthFailure_CredentialMatcherDoesNotSwallowPinErrors(t *testing.T) {
	if strings.Contains(strings.ToLower(realPinMismatchErr), "invalid relay password") {
		t.Fatal("test fixture drifted — it now contains the credential prose")
	}
	if got := classifyRelayAuthFailureWithSignals(errors.New(realPinMismatchErr), true); got == relayAuthBadPassword {
		t.Fatal("a pin mismatch was classified as a bad password")
	}
}

// The remedy must distinguish the two indistinguishable causes and give the
// relay operator the concrete fix, because the default (ephemeral key under a
// read-only /opt) is what produced this outage in the first place.
func TestRelayPinMismatchRemedy_NamesBothCausesAndTheFix(t *testing.T) {
	msg := relayPinMismatchRemedy("46.224.110.38:4433")
	for _, want := range []string{
		"46.224.110.38:4433",
		"rotated",              // cause 1
		"intercepted",          // cause 2
		"keep refusing",        // the guarantee is not being relaxed
		"YAVER_RELAY_KEY_PATH", // the concrete operator fix
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("remedy missing %q:\n%s", want, msg)
		}
	}
}
