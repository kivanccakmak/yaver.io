package main

import (
	"os"
	"strings"
	"testing"
)

// The Convex bill, as a test.
//
// Measured on prod 2026-08-01 with the dashboard closed and every box idle,
// `npx convex logs --prod --success` over 90 seconds:
//
//	46  guests:getGuestUserIds
//	46  guests:getGuestConfig
//	20  userSettings:getByToken
//	12  auth:validateSession
//	 4  devices:heartbeat
//
// The two guest queries were the busiest functions in the deployment — together
// about 40% of all calls — for a feature family that ships OFF. Each is an HTTP
// action wrapping a query, so each poll bills twice. It is per-agent, so it
// scales with every machine every user connects: the shape that turns a public
// launch into a surprise invoice.
//
// httpserver.go already carried the scar: "A 24/7 10s Convex poll on every idle
// host dominated our Convex bill (~660K function calls/period)." The adaptive
// backoff added then does not save a host with a single stale grant, because it
// only slows down when there are no guest rows at all.

func TestGuestPollIsGatedOnTheFeatureFlag(t *testing.T) {
	src, err := os.ReadFile("httpserver.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)

	i := strings.Index(body, "func (s *HTTPServer) refreshGuestList(")
	if i < 0 {
		t.Fatal("refreshGuestList is gone — re-point this test at whatever replaced it")
	}
	// The guard has to be the FIRST thing the loop does. A gate placed after
	// the initial fetchOnce still pays for a poll on every agent start.
	head := body[i:]
	if len(head) > 1200 {
		head = head[:1200]
	}
	if !strings.Contains(head, "if !GuestAccessEnabled()") {
		t.Fatal("refreshGuestList no longer checks GuestAccessEnabled before polling — " +
			"every agent is back to two Convex calls every 10s for a disabled subsystem")
	}
	gate := strings.Index(head, "if !GuestAccessEnabled()")
	fetch := strings.Index(head, "fetchOnce()")
	if fetch >= 0 && fetch < gate {
		t.Fatal("the flag check comes AFTER the first fetch — the poll is still paid for once per agent start")
	}
}

// The flag must actually be off in the shipped build, or the gate above is
// decorative. If guest features are turned on later, this test is the reminder
// that the poll cost returns with them.
func TestGuestFeaturesShipOffInV1(t *testing.T) {
	t.Setenv(envEnableGuestAccess, "")
	if GuestAccessEnabled() {
		t.Fatal("ENABLE_GUEST_FEATURES is on — the guest Convex poll is live again, " +
			"at roughly 17k calls per day per agent")
	}
}

// The override must still work, so a host that genuinely shares can opt in on
// one box without a rebuild. A gate that cannot be lifted is a removed feature.
func TestGuestPollCanBeReEnabledPerBox(t *testing.T) {
	t.Setenv(envEnableGuestAccess, "1")
	if !GuestAccessEnabled() {
		t.Fatalf("%s=1 did not re-enable guest access", envEnableGuestAccess)
	}
}
