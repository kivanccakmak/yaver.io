package main

import (
	"os"
	"strings"
	"testing"
)

// A rescue code nobody can read is not a rescue.
//
// beginSelfNomination creates a device code when the relay refuses this box
// with reason=dead_token, so an owner already signed in on a phone or a browser
// can sign the box back in with one tap. It shipped 2026-08-01 logging that
// code — and only logging it.
//
// That is circular. The entire premise is that the box is unreachable: its
// session is dead, the relay refuses it, and it is on a LAN nobody is on. An
// operator who could read its log could just run `yaver auth --headless` there
// and would never need the feature. currentSelfNominatedCode() had zero
// consumers in the whole tree — a correct producer wired to nothing, which is
// the exact corollary CLAUDE.md names: "a signal with no consumer is not
// shipped".
//
// The heartbeat is the one channel that still works in this state. It is
// outbound HTTPS to Convex and needs no relay, no inbound port, and no
// reachability — the same property that lets a dead-session box pull a queued
// agent update. So the code rides there, and every surface can render it.
//
// Publishing it is safe and is not a credential leak: authorizeDeviceCode
// derives the account from the APPROVER's bearer token, so a stranger holding
// the code authorizes nothing — they would have to already be signed in as the
// owner, at which point the code adds nothing. The minted session token never
// travels this way; the box polls for it over the channel `yaver auth` uses.

func TestSelfNominatedCodeIsPublishedOnTheHeartbeat(t *testing.T) {
	src, err := os.ReadFile("auth.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)

	i := strings.Index(body, "func SendHeartbeat(")
	if i < 0 {
		t.Fatal("SendHeartbeat is gone — re-point this test at whatever replaced it")
	}
	// Bound the window to the function itself; a mention anywhere else in the
	// file would be a false green.
	window := body[i:]
	if j := strings.Index(window[1:], "\nfunc "); j > 0 {
		window = window[:j]
	}
	if !strings.Contains(window, "currentSelfNominatedCode()") {
		t.Fatal("SendHeartbeat no longer publishes currentSelfNominatedCode() — " +
			"the box is back to logging its rescue code to a log nobody can reach")
	}
	if !strings.Contains(window, `payload["pendingAuthCode"]`) {
		t.Fatal(`the heartbeat payload has no "pendingAuthCode" field — ` +
			"surfaces have nothing to render an Approve button from")
	}
}

// The producer must stay reachable from the failure that creates it, or the
// code is only ever minted by a human running `yaver auth --headless` — which
// is the friction the feature exists to remove.
func TestDeadTokenStillTriggersSelfNomination(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), "beginSelfNomination(") {
		t.Fatal("nothing in main.go calls beginSelfNomination — a box with a dead " +
			"session never offers a code, so the whole rescue path is unreachable")
	}
}

// The field is bounded at the edge. It lands on a row every surface renders, so
// it must never become a channel for arbitrary agent-controlled text.
func TestPendingAuthCodeIsShapeCheckedServerSide(t *testing.T) {
	src, err := os.ReadFile("../../backend/convex/http.ts")
	if err != nil {
		t.Skipf("backend not present in this tree: %v", err)
	}
	body := string(src)
	k := strings.Index(body, "pendingAuthCode:")
	if k < 0 {
		t.Fatal("the heartbeat handler dropped pendingAuthCode — the agent publishes " +
			"a code that Convex throws away, so no surface ever sees it")
	}
	window := body[k:]
	if len(window) > 600 {
		window = window[:600]
	}
	if !strings.Contains(window, "[A-Z0-9]{4}-[A-Z0-9]{4}") {
		t.Fatal("pendingAuthCode is stored without a shape check — an agent could " +
			"put arbitrary text on a row every surface renders")
	}
}

// A relay-password DEADLOCK must offer a rescue, not prescribe a shell visit.
//
// When the relay refuses our credentials and Convex either does not answer or
// hands back the very password that was just refused, retrying is provably
// useless. The loop used to log "run `yaver auth` on this machine to restore
// the tunnel" and back off — the exact remedy this chain exists to delete.
//
// Measured 2026-08-01: `linux-2` sat in that state, heartbeating to Convex every
// minute, on the current agent, unreachable, while the dashboard read "Alive ·
// can't reach (Relay refused: account relay password missing or stale)". The
// account-level repair endpoint answered "already in sync" — correctly, because
// the account was never the problem. Only that box's cached copy was, and only a
// shell could fix it.
//
// A box in this state still reaches Convex outbound, which is the whole premise
// of self-nomination.
func TestRelayPasswordDeadlockOffersARescue(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)

	if !strings.Contains(body, "func offerRelayRescue(") {
		t.Fatal("offerRelayRescue is gone — a relay-password deadlock is back to telling " +
			"the user to walk to the machine")
	}
	// Both deadlock branches, not just one. The fresh=="" branch and the
	// same-password branch are different failures with the same dead end.
	if n := strings.Count(body, "offerRelayRescue("); n < 3 {
		t.Fatalf("offerRelayRescue is referenced %d times (want the definition plus BOTH "+
			"deadlock branches) — one of them still dead-ends", n)
	}
	// The old remedy must not be what a deadlocked box prints.
	if strings.Contains(body, "run `yaver auth` on this machine to restore the tunnel\", relayAddr)") &&
		!strings.Contains(body, "no Convex URL configured on this machine") {
		t.Fatal("the shell-visit remedy is back on the deadlock path")
	}
}
