package main

// The other half of exclusivity: a claim must have a defined way to be LOST.
//
// Within minutes of shipping exclusive device claims, two abandoned sessions had
// the Mac mini's only iPhone simulator locked with nobody watching either stream.
// The error was honest ("already claimed by another session") and useless: the
// machine reported full while completely idle.

import (
	"testing"
	"time"
)

func newReaperTestManager() *RemoteRuntimeManager {
	return &RemoteRuntimeManager{
		sessions: map[string]RemoteRuntimeSession{},
		live:     map[string]*remoteRuntimeLiveState{},
		proxied:  map[string]*proxiedSession{},
	}
}

func TestReaperFreesAPeerlessSessionAfterGrace(t *testing.T) {
	m := newReaperTestManager()
	m.sessions["s1"] = RemoteRuntimeSession{ID: "s1", Status: "control-ready", TargetID: "ios-simulator"}
	m.live["s1"] = &remoteRuntimeLiveState{sessionID: "s1"}

	released := false
	m.live["s1"].releaseDevice = func() { released = true }

	now := time.Now()
	// First sweep only MARKS it peerless — reaping mid-handshake would be its own
	// bug (offer → ICE → answer legitimately takes seconds).
	if got := m.ReapAbandonedSessions(now); len(got) != 0 {
		t.Fatalf("reaped inside the grace window: %v", got)
	}
	if released {
		t.Fatal("device released during the handshake grace window")
	}

	// Past grace with still no viewer: gone.
	if got := m.ReapAbandonedSessions(now.Add(remoteRuntimeIdleGrace + time.Second)); len(got) != 1 {
		t.Fatalf("an abandoned session survived the grace window: %v", got)
	}
	if !released {
		t.Fatal("session was closed but its exclusive device was NOT released — the machine keeps " +
			"reporting full while idle, which is the whole leak")
	}
}

func TestReaperNeverTouchesAWatchedSession(t *testing.T) {
	m := newReaperTestManager()
	m.sessions["s2"] = RemoteRuntimeSession{ID: "s2", Status: "control-ready"}
	live := &remoteRuntimeLiveState{sessionID: "s2"}
	live.peers = []*remoteRuntimePeer{{}} // one viewer
	released := false
	live.releaseDevice = func() { released = true }
	m.live["s2"] = live

	// Hours later, still watching: this is the product working.
	for _, at := range []time.Duration{0, time.Hour, 3 * time.Hour} {
		if got := m.ReapAbandonedSessions(time.Now().Add(at)); len(got) != 0 {
			t.Fatalf("reaped a session with a live viewer at +%s: %v", at, got)
		}
	}
	if released {
		t.Fatal("pulled the device out from under an active viewer")
	}
}

// A terminal session has nothing coming — no grace needed.
func TestReaperClosesTerminalSessionsImmediately(t *testing.T) {
	for _, status := range []string{"attach-failed", "stopped", "closed"} {
		m := newReaperTestManager()
		m.sessions["s"] = RemoteRuntimeSession{ID: "s", Status: status}
		m.live["s"] = &remoteRuntimeLiveState{sessionID: "s"}
		if got := m.ReapAbandonedSessions(time.Now()); len(got) != 1 {
			t.Errorf("status %q was not reaped on the first sweep: %v", status, got)
		}
	}
}

// A viewer that reconnects resets the clock — otherwise a long-lived session
// would be reaped moments after a reload.
func TestReaperResetsGraceWhenAViewerReturns(t *testing.T) {
	m := newReaperTestManager()
	m.sessions["s3"] = RemoteRuntimeSession{ID: "s3", Status: "control-ready"}
	live := &remoteRuntimeLiveState{sessionID: "s3"}
	m.live["s3"] = live

	t0 := time.Now()
	m.ReapAbandonedSessions(t0) // marks peerless

	// Viewer arrives before grace elapses.
	live.mu.Lock()
	live.peers = []*remoteRuntimePeer{{}}
	live.mu.Unlock()
	m.ReapAbandonedSessions(t0.Add(30 * time.Second)) // clears the mark

	// Viewer leaves again — grace must start over, not carry the old mark.
	live.mu.Lock()
	live.peers = nil
	live.mu.Unlock()
	if got := m.ReapAbandonedSessions(t0.Add(60 * time.Second)); len(got) != 0 {
		t.Fatalf("grace was not reset by the reconnect — a page reload would kill the session: %v", got)
	}
}
