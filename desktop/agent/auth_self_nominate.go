package main

import (
	"log"
	"strings"
	"sync"
	"time"
)

// A box with a dead session asks to be rescued, instead of waiting for a shell.
//
// The gap this closes, measured on this account 2026-08-01: four machines sat in
// "Alive · can't reach (Relay refused: account relay password missing or stale)"
// with no way out. Their sessions had expired, so they could not refresh the
// relay password (the refetch authenticates with the very token that is dead),
// and `yaver auth fix` from a healthy machine answered "already signed in"
// because markBootstrap could not flag needsAuth. The only remedy was a shell on
// each box — including one on a LAN nobody was on.
//
// Every other piece of the rescue already existed and was idle:
//
//   - requestDeviceCode + completeDeviceCodeInBackground (auth_recover.go) —
//     the same flow `yaver auth --headless` runs.
//   - mobile/src/lib/deviceCodeApprove.ts — one-tap approval from a phone that
//     is ALREADY signed in, no browser, no code typed.
//   - backend/convex/deviceCode.ts authorizeDeviceCode — derives the user from
//     the caller's bearer token and mints the session.
//
// What was missing is the trigger. A device code only ever got created when a
// human ran `yaver auth --headless` ON the box, so the phone had an approver
// with nothing to approve. This makes the box nominate itself the moment it
// learns its session is dead — which it now does reliably, because relay 0.1.23
// answers registration with reason=dead_token and classifyRelayAuthFailure
// routes it here.
//
// ── Why publishing the user code is safe ────────────────────────────────────
//
// The code is an INVITATION, not a credential. authorizeDeviceCode derives the
// account from the approver's bearer token, so a stranger holding the code
// cannot authorize anything — they would have to already be signed in as the
// owner, at which point the code adds nothing. The minted session token is
// never published; the box polls for it over the same channel `yaver auth`
// uses. Nothing here trusts the box's stale credential, which is the whole
// point: that credential is the thing that died.
//
// This deliberately does NOT relax the (deviceId, hardwareId, publicKey) triple
// that markBootstrap enforces. That guard is correct and stays; self-nomination
// routes around the consequence of failing it rather than weakening it.

var (
	selfNominateMu   sync.Mutex
	selfNominateAt   time.Time
	selfNominateCode string
)

// selfNominateCooldown bounds how often a box may ask to be rescued.
//
// The relay reconnect loop calls into here on every refused registration —
// roughly once a minute, forever, on a box nobody is fixing. Without a cooldown
// that is a device code per minute against Convex: a cost that scales with how
// broken the fleet is, which is exactly the shape that turned a guest poll into
// 40% of a bill. One live code is all a rescue needs.
const selfNominateCooldown = 10 * time.Minute

// currentSelfNominatedCode returns the user code this box is currently offering
// for approval, or "" when none is live. Surfaces render it as an Approve
// button; the heartbeat publishes it.
func currentSelfNominatedCode() string {
	selfNominateMu.Lock()
	defer selfNominateMu.Unlock()
	if selfNominateCode == "" || time.Since(selfNominateAt) > 15*time.Minute {
		return ""
	}
	return selfNominateCode
}

// beginSelfNomination creates a device code and starts polling for its
// approval, so any surface the owner is already signed in on can rescue this
// box with one tap.
//
// Best-effort and non-blocking by construction: it is called from the relay
// reconnect loop, which must never be delayed by a network round trip, and a
// failure here must leave the box exactly as it was — still refused, still
// retrying, no worse.
func beginSelfNomination(convexURL string, s *HTTPServer) {
	convexURL = strings.TrimRight(strings.TrimSpace(convexURL), "/")
	if convexURL == "" {
		return
	}

	selfNominateMu.Lock()
	if time.Since(selfNominateAt) < selfNominateCooldown && selfNominateCode != "" {
		selfNominateMu.Unlock()
		return
	}
	selfNominateAt = time.Now()
	selfNominateMu.Unlock()

	go func() {
		// A rescue attempt must never be able to take down an agent that is
		// otherwise serving fine.
		defer func() { _ = recover() }()
		dc, err := requestDeviceCode(convexURL)
		if err != nil || dc == nil || dc.UserCode == "" {
			log.Printf("[auth-rescue] could not create a sign-in code (%v) — "+
				"this box still needs `yaver auth --headless` run on it directly", err)
			return
		}
		selfNominateMu.Lock()
		selfNominateCode = dc.UserCode
		selfNominateAt = time.Now()
		selfNominateMu.Unlock()

		// Loud on purpose. Until every surface renders the Approve button, this
		// line IS the route to fix: an operator with journalctl or `yaver logs`
		// can read the code and approve from a phone that is already signed in.
		log.Printf("[auth-rescue] this box's session is dead — approve code %s from any signed-in "+
			"Yaver surface (phone: open the app; web: /auth/device) to sign it back in. "+
			"No browser login needed on this machine.", dc.UserCode)

		// Same polling loop `yaver auth --headless` uses; writes the token to
		// config and the agent picks it up through the auth cache.
		completeDeviceCodeInBackground(convexURL, dc.DeviceCode, nil, s)

		selfNominateMu.Lock()
		selfNominateCode = ""
		selfNominateMu.Unlock()
	}()
}
