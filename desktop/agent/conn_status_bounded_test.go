package main

// conn_status_bounded_test.go — the heartbeat must never be wedgeable by its own
// advisory probes.
//
// The incident (2026-07-25, Mac mini): `tailscale status --json` wedged (a child
// of the killed CLI kept the stdout pipe open, so Cmd.Wait blocked past its 4s
// context — the CLAUDE.md grandchild-pipe trap). SendHeartbeat sat in that call
// for 40 MINUTES; the agent never sent its initial heartbeat; the dashboard
// showed the box offline all day. Six agent restarts all died on the same line.
// The liveness signal was blocked by a nice-to-have topology hint.

import (
	"os"
	"strings"
	"testing"
	"time"
)

// TestBoundedConnStatusSurvivesAWedgedProbe wedges the underlying probe (by
// holding the tailscale status cache mutex, which currentConnStatus needs) and
// asserts the bounded wrapper still returns — without it, this test hangs the
// way the agent did.
func TestBoundedConnStatusSurvivesAWedgedProbe(t *testing.T) {
	// Simulate the wedge: hold the mutex the probe must take. This is exactly
	// what a stuck `tailscale status` does to every other caller.
	tsStatusMu.Lock()
	defer tsStatusMu.Unlock()

	done := make(chan map[string]interface{}, 1)
	go func() { done <- connStatusForHeartbeatBounded(300 * time.Millisecond) }()

	select {
	case cs := <-done:
		if cs != nil {
			t.Errorf("a probe that could not answer must degrade to nil (omit the field), got %v", cs)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("connStatusForHeartbeatBounded blocked on a wedged probe — the heartbeat would " +
			"never be sent and the box would look offline while perfectly healthy (the 40-minute incident)")
	}
}

func TestBoundedConnStatusPassesThroughWhenHealthy(t *testing.T) {
	// Unwedged: whatever the real probe answers (nil on an unchanged status is
	// fine) must come back within the budget, not be replaced by the timeout.
	done := make(chan struct{})
	go func() {
		_ = connStatusForHeartbeatBounded(4 * time.Second)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("healthy probe did not answer inside its budget")
	}
}

// The exec that caused it all must carry WaitDelay — a context deadline alone
// does not free Output() while a grandchild holds the pipe.
func TestTailscaleExecHasWaitDelay(t *testing.T) {
	data, err := os.ReadFile("tailscale_peers.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	src := string(data)
	if !strings.Contains(src, "WaitDelay") {
		t.Fatal("tailscale_peers.go lost its WaitDelay — the 40-minute heartbeat wedge comes straight back")
	}
}

// SendHeartbeat itself must use the BOUNDED wrapper. A direct call compiles and
// works fine every day the box is healthy — and wedges the beat the day a probe
// hangs, which is precisely when liveness matters.
func TestSendHeartbeatUsesTheBoundedProbe(t *testing.T) {
	data, err := os.ReadFile("auth.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(string(data), "connStatusForHeartbeatBounded(") {
		t.Fatal("SendHeartbeat no longer uses connStatusForHeartbeatBounded — a wedged advisory probe " +
			"blocks the heartbeat again (the 40-minute offline-all-day incident)")
	}
}
