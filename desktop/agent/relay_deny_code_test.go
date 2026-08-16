package main

import (
	"errors"
	"net/http"
	"testing"
)

// The relay's stable code must decide, without any prose being consulted.
//
// Before relay/abuse_guard.go grew these codes, the relay's `code` field was
// http.StatusText — the literal "Unauthorized" that every 401 carries — so
// there was nothing to key off and every surface invented a regex. The whole
// point of this layer is that the regexes stop being the primary signal.
func TestRelayDenyCode_DecidesWithoutProse(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
		want bool
	}{
		{
			// No recognisable prose at all — only the code says what happened.
			name: "password missing, code only",
			body: `HTTP 401: {"ok":false,"code":"relay_password_missing","error":"nope"}`,
			want: true,
		},
		{
			name: "password invalid, code only",
			body: `{"ok":false,"code":"relay_password_invalid","error":"nope"}`,
			want: true,
		},
		{
			name: "rate limited, code only",
			body: `{"ok":false,"code":"relay_password_rate_limited","error":"nope"}`,
			want: true,
		},
		{
			// Authoritative in the NEGATIVE direction too: this body contains
			// the word "relay" and would otherwise be at the mercy of prose.
			name: "device not connected is NOT a credential problem",
			body: `{"ok":false,"code":"relay.device_not_connected","error":"device not connected to relay"}`,
			want: false,
		},
		{
			name: "owner mismatch is NOT a credential problem",
			body: `{"ok":false,"code":"relay.device_owner_mismatch","error":"device not connected to relay"}`,
			want: false,
		},
		{
			// A backend blip must never be "self-healed". Collapsing this into
			// bad-password is what turned a Convex hiccup into a fleet-wide
			// outage on 2026-07-13: every agent refetched a working credential,
			// got the same one back, and looped forever.
			name: "auth backend unavailable is NOT a credential problem",
			body: `{"ok":false,"code":"relay_auth_backend_unavailable","error":"relay auth backend unavailable — retry"}`,
			want: false,
		},
		{
			// The pre-fix relay. Falls through to prose, which still works.
			name: "legacy Unauthorized code falls through to prose",
			body: `{"ok":false,"code":"Unauthorized","error":"relay password missing — sign in again to fetch it"}`,
			want: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isRelayCredentialDenyText(tc.body); got != tc.want {
				t.Fatalf("isRelayCredentialDenyText(%q) = %v, want %v", tc.body, got, tc.want)
			}
		})
	}
}

// THE BUG THIS SHIPPED TO FIX. looksLikeStaleRelayPassword required "password"
// AND one of invalid|rejected|denied, so the relay's
// "relay password missing — sign in again to fetch it" matched NOTHING, and
// bus_relay.go:64 refused to refetch the credential on the one 401 a refetch
// repairs — it just looped every 30s forever.
//
// PROVEN BY BREAKING: restore the old body of looksLikeStaleRelayPassword
// (drop the "relay"+"missing" leg from isRelayCredentialDenyText) and this
// subtest fails with the exact live 401 string.
func TestLooksLikeStaleRelayPassword_MatchesTheMissingForm(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "relay password missing (the form that used to be dropped)",
			err:  errors.New("HTTP 401: relay password missing — sign in again to fetch it"),
			want: true,
		},
		{
			name: "relay password missing, as the full JSON body",
			err:  errors.New(`subscribe lost: HTTP 401: {"ok":false,"code":"relay_password_missing","error":"relay password missing — sign in again to fetch it"}`),
			want: true,
		},
		// Everything the old predicate matched must STILL match — this is a
		// superset, not a replacement.
		{name: "invalid relay password", err: errors.New("HTTP 401: invalid relay password"), want: true},
		{name: "reason=bad_password", err: errors.New("invalid relay password (reason=bad_password)"), want: true},
		{name: "reason=dead_token", err: errors.New("relay session expired — sign in again on this device (reason=dead_token)"), want: true},
		{name: "rate limited", err: errors.New("too many invalid relay password attempts"), want: true},
		// And things that are NOT a relay credential problem must stay false —
		// a refetch would be a pointless Convex round-trip at best, and at
		// worst masks the real cause.
		{name: "agent token rejection", err: errors.New("HTTP 401: invalid token"), want: false},
		{name: "device mismatch is not self-healable", err: errors.New("relay password owner does not own this deviceId (reason=device_mismatch)"), want: false},
		{name: "device not connected", err: errors.New("HTTP 502: device not connected to relay"), want: false},
		{name: "nil error", err: nil, want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := looksLikeStaleRelayPassword(tc.err); got != tc.want {
				t.Fatalf("looksLikeStaleRelayPassword(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// ONE classifier, two entry points. staleRelayPasswordHTTP and
// looksLikeStaleRelayPassword were independent near-copies that disagreed on
// exactly one term; if they ever disagree again on a body, this fails.
func TestStaleRelayPasswordHTTP_AgreesWithTheOneClassifier(t *testing.T) {
	bodies := []string{
		"relay password missing — sign in again to fetch it",
		`{"ok":false,"code":"relay_password_missing","error":"relay password missing — sign in again to fetch it"}`,
		"invalid relay password",
		`{"ok":false,"code":"relay_password_invalid","error":"invalid relay password"}`,
		"too many invalid relay password attempts",
		"invalid token",
		"relay password owner does not own this deviceId (reason=device_mismatch)",
		`{"ok":false,"code":"relay.device_not_connected","error":"device not connected to relay"}`,
	}
	for _, body := range bodies {
		want := looksLikeStaleRelayPassword(errors.New(body))
		if got := staleRelayPasswordHTTP(http.StatusUnauthorized, []byte(body)); got != want {
			t.Fatalf("classifiers drifted on %q: staleRelayPasswordHTTP=%v looksLikeStaleRelayPassword=%v", body, got, want)
		}
		if got := staleRelayPasswordHTTP(http.StatusForbidden, []byte(body)); got != want {
			t.Fatalf("403 leg drifted on %q: got %v want %v", body, got, want)
		}
	}
	// The status gate still bites: a 502 body is never a credential deny, no
	// matter what it says.
	if staleRelayPasswordHTTP(http.StatusBadGateway, []byte("invalid relay password")) {
		t.Fatal("staleRelayPasswordHTTP must stay gated on 401/403")
	}
}

// classifyRelayAuthFailure keeps routing dead-token to re-auth rather than to a
// hopeless password refetch. The new superset must not have blurred it.
func TestClassifyRelayAuthFailure_StillDistinguishesKinds(t *testing.T) {
	if got := classifyRelayAuthFailure(errors.New("relay session expired (reason=dead_token)")); got != relayAuthDeadToken {
		t.Fatalf("dead_token classified as %v", got)
	}
	if got := classifyRelayAuthFailure(errors.New("relay password owner does not own this deviceId (reason=device_mismatch)")); got != relayAuthDeviceMismatch {
		t.Fatalf("device_mismatch classified as %v", got)
	}
	if got := classifyRelayAuthFailure(errors.New("invalid relay password (reason=bad_password)")); got != relayAuthBadPassword {
		t.Fatalf("bad_password classified as %v", got)
	}
}
