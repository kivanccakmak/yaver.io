package main

// device_identity_conflict_state.go — give the identity conflict a WIRE.
//
// THE PROBLEM THIS SOLVES, and why it is not just a missing consumer.
//
// Convex's markBootstrap authenticates a token-dead box on the
// (deviceId, hardwareId, publicKey) triple — the one proof that survives an
// expired session — and rejects a mismatch outright. That rejection is CORRECT
// and must never be relaxed: it is what stops a stranger toggling someone
// else's device row.
//
// The consequence is what needed a name. A box that fails the check cannot set
// needsAuth, so it has NO channel left to say "I am alive and need signing in",
// and every surface can only render it as unreachable — sending the user to
// check a network that is fine. Seen live on ubuntu-4gb-hel1-1 (2026-07-31),
// where a second daemon ran from a COPIED config carrying the same deviceId, so
// whichever registered last owned the row and locked the other out.
//
// ReasonDeviceIdentityConflict was added for exactly this and then only ever
// reached a log.Printf. The 2026-08-04 audit counted it as "emitted with no
// consumer"; measuring more carefully showed something worse — it was on NO WIRE
// AT ALL, so no surface could have consumed it even in principle. Writing a
// client for it first would have been wasted work.
//
// THE CHANNEL. Not Convex — that is precisely what is refusing the box. The
// honest channel is the one that still works: the agent's own HTTP surface. A
// phone on the LAN, the dashboard over the relay, or `yaver status` can all read
// /info, and /info is already where this codebase puts local truth. So the
// conflict is recorded here and published there, which turns "unreachable" into
// "this box is running and its device identity is claimed by other hardware".

import "sync"

type deviceIdentityConflictState struct {
	// Active stays true for the process lifetime once observed: the conflict is
	// resolved by changing configuration on one of the two boxes, never by the
	// losing agent retrying, so treating it as transient would hide it.
	Active   bool   `json:"active"`
	Kind     string `json:"kind,omitempty"`
	DeviceID string `json:"deviceId,omitempty"`
	Remedy   string `json:"remedy,omitempty"`
	Code     string `json:"code,omitempty"`
}

var (
	identityConflictMu    sync.RWMutex
	identityConflictValue deviceIdentityConflictState
)

// markDeviceIdentityConflict records that Convex refused this box's identity.
func markDeviceIdentityConflict(kind, deviceID, remedy string) {
	identityConflictMu.Lock()
	defer identityConflictMu.Unlock()
	identityConflictValue = deviceIdentityConflictState{
		Active:   true,
		Kind:     kind,
		DeviceID: deviceID,
		Remedy:   remedy,
		Code:     ReasonDeviceIdentityConflict,
	}
}

// DeviceIdentityConflict returns the recorded conflict, or a zero value.
func DeviceIdentityConflict() deviceIdentityConflictState {
	identityConflictMu.RLock()
	defer identityConflictMu.RUnlock()
	return identityConflictValue
}
