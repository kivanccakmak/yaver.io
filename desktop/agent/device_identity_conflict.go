package main

import "strings"

// Naming the one failure that silences a box completely.
//
// Incident 2026-07-31, ubuntu-4gb-hel1-1. Two `yaver serve` daemons ran on one
// machine — the real agent under root, and `yaver-sim` (the circuit-sim cell)
// under its own service account — from configs carrying the SAME device_id
// 2ed7da41. Whichever registered last wrote its hardwareId + publicKey onto the
// single Convex device row; the other was locked out of the identity triple
// forever. The journal repeated, every two minutes:
//
//	[auth-expired-convex] Convex returned 400: {"error":"Uncaught Error: Public key mismatch ..."}
//	[auth-expired-convex] Convex returned 400: {"error":"Uncaught Error: Hardware ID mismatch ..."}
//
// That is a stack trace, not a diagnosis. Nobody reading it learns that the
// box's ONLY remaining way to ask for help is the thing that just failed.
//
// The Convex guard itself is correct and must not be relaxed: markBootstrap
// authenticates a token-dead box on (deviceId, hardwareId, publicKey) precisely
// because the session token is gone, and dropping either half would let any
// caller flip a stranger's device into bootstrap mode. So the fix is not to
// weaken the check — it is to make its consequence legible, and to stop the
// agent reporting a no-op as if it had worked.

// deviceIdentityConflictKind names which half of the identity triple failed.
type deviceIdentityConflictKind int

const (
	// identityConflictNone — not an identity rejection.
	identityConflictNone deviceIdentityConflictKind = iota
	// identityConflictHardware — the deviceId belongs to different hardware.
	// Typically a ~/.yaver/config.json copied to another machine or user.
	identityConflictHardware
	// identityConflictPublicKey — same machine, different keypair. Typically a
	// second daemon under another account with its own ~/.yaver/device.key, or
	// a keys directory that was wiped while the Convex row survived.
	identityConflictPublicKey
)

// classifyBootstrapRejection reads Convex's answer to /devices/bootstrap.
//
// It matches on the error TEXT because that is what the endpoint returns today
// (an uncaught mutation error, verbatim). That is a wire contract we do not
// control, so the matcher is deliberately loose about surrounding punctuation
// and case, and returns identityConflictNone when it recognises nothing —
// callers must degrade to their previous behaviour rather than guess.
func classifyBootstrapRejection(status int, body string) deviceIdentityConflictKind {
	if status < 400 {
		return identityConflictNone
	}
	msg := strings.ToLower(body)
	switch {
	case strings.Contains(msg, "hardware id mismatch"):
		return identityConflictHardware
	case strings.Contains(msg, "public key mismatch"):
		return identityConflictPublicKey
	}
	return identityConflictNone
}

// deviceIdentityConflictRemedy is the operator-facing diagnosis: what is true,
// what it costs, and the next command. It replaces a raw Convex stack trace.
//
// Written for whoever is staring at a box that "looks fine" while every surface
// says unreachable — which is exactly the position this failure puts them in.
func deviceIdentityConflictRemedy(kind deviceIdentityConflictKind, deviceID string) string {
	if kind == identityConflictNone {
		return ""
	}
	short := deviceID
	if len(short) > 8 {
		short = short[:8]
	}
	var cause string
	switch kind {
	case identityConflictHardware:
		cause = "registered to DIFFERENT hardware — this config was almost certainly copied from another machine"
	case identityConflictPublicKey:
		cause = "registered with a different key — another yaver instance (a second service account, or a reinstall that regenerated ~/.yaver/device.key) owns this identity"
	}
	return "device identity conflict: deviceId " + short + " is " + cause + ". " +
		"This machine cannot mark itself as needing sign-in, so web and mobile will show it as UNREACHABLE rather than NEEDS AUTH, " +
		"and no amount of waiting or retrying will change that. " +
		"Fix: run `yaver auth` on THIS machine to register it under its own identity. " +
		"If a second yaver daemon runs here, give it its own ~/.yaver (never a copied config) before re-authing."
}
