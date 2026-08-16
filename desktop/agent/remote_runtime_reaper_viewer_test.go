package main

import (
	"testing"
	"time"
)

// A client polling /frame over HTTP has ZERO WebRTC peers. That is the shipped
// `relay-jpeg-poll` transport — the one a phone falls back to on cellular — so
// "no peers" must never mean "nobody is watching".
//
// Measured 2026-07-25: a session was reaped 4 seconds after a successful 58 KB
// JPEG pull, and the very next frame request answered "remote runtime session
// not found" mid-stream, with the exclusive simulator released underneath it.
func TestReaperKeepsSessionWithRecentFramePullAndNoPeers(t *testing.T) {
	m := &RemoteRuntimeManager{
		sessions: map[string]RemoteRuntimeSession{},
		live:     map[string]*remoteRuntimeLiveState{},
	}
	const id = "rr_polling_viewer"
	m.sessions[id] = RemoteRuntimeSession{ID: id, Status: "streaming"}
	now := time.Now()
	lr := &remoteRuntimeLiveState{}
	lr.lastFrameAt = now // a frame went out just now
	m.live[id] = lr      // and there are NO WebRTC peers

	m.ReapAbandonedSessions(now) // mark peerless once, like the real reaper loop
	lr.lastFrameAt = now.Add(remoteRuntimeIdleGrace + time.Minute)

	// Push well past the original peerless grace so only the fresh frame evidence
	// can save it. Without the frame guard, this second sweep reaps the session.
	reaped := m.ReapAbandonedSessions(now.Add(remoteRuntimeIdleGrace + time.Minute + time.Second))
	for _, r := range reaped {
		if r == id {
			t.Fatal("reaped a session whose viewer was actively pulling frames")
		}
	}
}

// The other direction must still work: genuinely abandoned sessions hold an
// exclusive simulator and MUST be released, or the box reports itself full.
func TestReaperStillClosesTrulyAbandonedSession(t *testing.T) {
	m := &RemoteRuntimeManager{
		sessions: map[string]RemoteRuntimeSession{},
		live:     map[string]*remoteRuntimeLiveState{},
	}
	const id = "rr_abandoned"
	m.sessions[id] = RemoteRuntimeSession{ID: id, Status: "control-ready"}
	lr := &remoteRuntimeLiveState{}
	lr.lastFrameAt = time.Now().Add(-30 * time.Minute) // nobody has looked in ages
	m.live[id] = lr

	now := time.Now()
	m.ReapAbandonedSessions(now) // marks it peerless
	reaped := m.ReapAbandonedSessions(now.Add(remoteRuntimeIdleGrace + time.Minute))
	found := false
	for _, r := range reaped {
		if r == id {
			found = true
		}
	}
	if !found {
		t.Fatal("an abandoned session was not reaped — its simulator stays locked and the box looks full")
	}
}
