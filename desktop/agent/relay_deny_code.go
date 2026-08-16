package main

import (
	"encoding/json"
	"strings"
)

// relay_deny_code.go — THE relay-credential-deny classifier for the Go agent.
//
// The defining bug of this codebase is the duplicated predicate, and this exact
// question had two implementations that disagreed:
//
//   - main.go::looksLikeStaleRelayPassword    — required "password" AND one of
//     invalid|rejected|denied. It therefore did NOT match the relay's
//     "relay password MISSING — sign in again to fetch it", so bus_relay.go:64
//     spun forever on that 401 without ever re-pulling the credential that
//     would have fixed it.
//   - agent_mesh_remote.go::staleRelayPasswordHTTP — required "relay" AND
//     "password" AND one of invalid|rejected|denied|missing. It DID handle the
//     missing case (and says so in its comment), and its sibling did not.
//
// Neither was a superset of the other, which is the same failure mode CLAUDE.md
// records for mobile's three matchers. Both now delegate here.
//
// TWO LAYERS, IN ORDER:
//  1. The relay's STABLE `code` (relay/abuse_guard.go). Exact string match, no
//     regex, no locale, and authoritative in BOTH directions — a
//     relay.device_not_connected body can no longer be swept up by prose.
//  2. The historic PROSE, as a fallback. This is NOT dead code. public.yaver.io
//     is redeployed by MANUAL scp (memory/project_public_relay_deploy_drift),
//     self-hosted relays lag indefinitely, and an agent must keep working
//     against a relay older than itself. The prose layer is a strict superset
//     of BOTH old predicates, so no caller lost a match by delegating.

// Stable relay deny codes. Mirrors relay/abuse_guard.go — the password codes
// are snake_case and the device codes dotted, because relay.device_not_connected
// shipped before the rest. Compare exact strings; never infer the separator.
const (
	relayCodePasswordMissing        = "relay_password_missing"
	relayCodePasswordInvalid        = "relay_password_invalid"
	relayCodePasswordRateLimited    = "relay_password_rate_limited"
	relayCodeAuthBackendUnavailable = "relay_auth_backend_unavailable"
	relayCodeDeviceNotConnected     = "relay.device_not_connected"
	relayCodeDeviceOwnerMismatch    = "relay.device_owner_mismatch"
)

// isRelayCredentialDenyCode reports whether a stable relay code means "the
// relay refused THIS caller's credential" — the class that re-pulling the
// per-user password from Convex can repair.
//
// relayCodeAuthBackendUnavailable is deliberately excluded: the credential is
// fine and the backend is merely down. Treating that as a bad password is what
// turned a Convex blip into a fleet-wide outage in 2026-07-13 — every agent
// "self-healed" a working credential, got the identical password back, and sat
// in a permanent rejection loop. The device codes are excluded because the
// relay authorized us just fine; the tunnel is what is missing.
func isRelayCredentialDenyCode(code string) bool {
	switch strings.TrimSpace(code) {
	case relayCodePasswordMissing, relayCodePasswordInvalid, relayCodePasswordRateLimited:
		return true
	}
	return false
}

// relayDenyCodeFromBody pulls the relay's stable `code` out of a body that may
// be raw JSON or wrapped by a caller ("remote GET /info failed: HTTP 401: {…}").
// Go call sites stringify bodies into error text, so this is what lets a code
// survive to the classifiers without rewriting every call site.
func relayDenyCodeFromBody(body string) string {
	start := strings.Index(body, "{")
	end := strings.LastIndex(body, "}")
	if start < 0 || end <= start {
		return ""
	}
	var parsed struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal([]byte(body[start:end+1]), &parsed); err != nil {
		return ""
	}
	return strings.TrimSpace(parsed.Code)
}

// isRelayCredentialDenyText is the ONE predicate. Code first, prose second.
//
// The prose layer is the union of the two predicates it replaced:
//   - "password" + invalid|rejected|denied  (the historic looksLikeStaleRelayPassword)
//   - "relay" + "password" + missing        (the staleRelayPasswordHTTP addition)
//   - the explicit register-path reasons the relay embeds in its prose
//
// reason=device_mismatch is NOT included, in either layer: the password owner
// does not own this deviceId, and refetching the password provably cannot help.
// classifyRelayAuthFailure remains the finer-grained router for that.
func isRelayCredentialDenyText(text string) bool {
	if strings.TrimSpace(text) == "" {
		return false
	}
	if code := relayDenyCodeFromBody(text); code != "" {
		if isRelayCredentialDenyCode(code) {
			return true
		}
		switch code {
		case relayCodeDeviceNotConnected, relayCodeDeviceOwnerMismatch, relayCodeAuthBackendUnavailable:
			// A stable code is authoritative in BOTH directions.
			return false
		}
	}
	msg := strings.ToLower(text)
	if strings.Contains(msg, "reason=dead_token") || strings.Contains(msg, "reason=bad_password") {
		return true
	}
	if !strings.Contains(msg, "password") {
		return false
	}
	if strings.Contains(msg, "invalid") || strings.Contains(msg, "rejected") || strings.Contains(msg, "denied") {
		return true
	}
	// "relay password missing — sign in again to fetch it": the one deny that
	// most needs the refetch (a fresh or rotated user simply has no password
	// yet), and the one the old looksLikeStaleRelayPassword silently dropped.
	return strings.Contains(msg, "relay") && strings.Contains(msg, "missing")
}
