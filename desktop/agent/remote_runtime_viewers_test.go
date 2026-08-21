package main

// remote_runtime_viewers_test.go — Phase-A shared-session tests.
//
// The premise: a vibe room is one live capture with N surfaces attached —
// a phone driving, a TV watching, a desktop joining, a watch participating
// by voice. The viewer registry is what makes that legible (roster counts,
// who is who) and what makes leave safe (refcounted, not destructive).
//
// The load-bearing guard here is the refcount: a viewer detaching must
// NEVER kill the session for everyone else still watching. The proof is
// TestLeaveViewer_SecondViewerSurvives; break the refcount and it fails.

import (
	"testing"
	"time"
)

// seedViewers registers the given viewers against a primed live state so
// tests don't have to stand up real WebRTC peers.
func seedViewers(t *testing.T, live *remoteRuntimeLiveState, ids ...string) {
	t.Helper()
	live.mu.Lock()
	defer live.mu.Unlock()
	for i, id := range ids {
		live.registerViewerLocked(remoteRuntimeViewer{
			ID:      id,
			Surface: "mobile",
			Kind:    "frame-poll",
		})
		_ = i
	}
}

func TestViewerCount_CountsWebRTCAndFreshFramePollers(t *testing.T) {
	mgr, sessionID := newPrimedManager(t, "android-emulator")
	live, _ := mgr.getLive(sessionID)

	live.mu.Lock()
	live.registerViewerLocked(remoteRuntimeViewer{ID: "phone-1", Surface: "mobile", Kind: "webrtc"})
	live.registerViewerLocked(remoteRuntimeViewer{ID: "tv-1", Surface: "tvos", Kind: "frame-poll"})
	got := live.viewerCountLocked()
	live.mu.Unlock()

	if got != 2 {
		t.Fatalf("viewerCount = %d, want 2 (phone webrtc + tv frame-poll)", got)
	}

	// Stale frame-poller must drop off the count.
	live.mu.Lock()
	live.viewers["tv-1"].lastSeen = time.Now().Add(-remoteRuntimeViewerFresh - time.Second)
	got = live.viewerCountLocked()
	live.mu.Unlock()
	if got != 1 {
		t.Fatalf("viewerCount after stale poller = %d, want 1", got)
	}
}

func TestViewerCount_StampOnSessionDTO(t *testing.T) {
	mgr, sessionID := newPrimedManager(t, "android-emulator")
	live, _ := mgr.getLive(sessionID)
	seedViewers(t, live, "phone-1", "tv-1")

	stamped := mgr.stampViewerCount(mgr.sessions[sessionID])
	if stamped.ViewerCount != 2 {
		t.Fatalf("stamped viewerCount = %d, want 2", stamped.ViewerCount)
	}
}

func TestRegisterViewer_BroadcastsJoinedEvent(t *testing.T) {
	mgr, sessionID := newPrimedManager(t, "android-emulator")
	live, _ := mgr.getLive(sessionID)

	live.mu.Lock()
	live.registerViewerLocked(remoteRuntimeViewer{ID: "tv-1", Surface: "tvos", Kind: "frame-poll"})
	live.mu.Unlock()

	found := false
	for _, ev := range live.eventBacklog {
		if ev["type"] == "viewer_joined" && ev["viewerId"] == "tv-1" && ev["viewerCount"] == 1 {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected a viewer_joined event for tv-1 in the backlog, got %#v", live.eventBacklog)
	}
}

func TestLeaveViewer_SecondViewerSurvives(t *testing.T) {
	// THE guard: a viewer detaching must not kill the session for the
	// other viewer. This is the "break it and watch it fail" invariant.
	mgr, sessionID := newPrimedManager(t, "android-emulator")
	live, _ := mgr.getLive(sessionID)
	seedViewers(t, live, "phone-1", "tv-1")

	session, closed, err := mgr.leaveViewer(sessionID, "tv-1")
	if err != nil {
		t.Fatalf("leaveViewer: %v", err)
	}
	if closed {
		t.Fatal("session closed after one of two viewers left — refcount broken")
	}
	if session.ViewerCount != 1 {
		t.Fatalf("viewerCount after one leaves = %d, want 1", session.ViewerCount)
	}
	if _, ok := mgr.Get(sessionID); !ok {
		t.Fatal("session should still exist after a viewer left")
	}
}

func TestLeaveViewer_LastViewerClosesSession(t *testing.T) {
	mgr, sessionID := newPrimedManager(t, "android-emulator")
	live, _ := mgr.getLive(sessionID)
	seedViewers(t, live, "phone-1")

	session, closed, err := mgr.leaveViewer(sessionID, "phone-1")
	if err != nil {
		t.Fatalf("leaveViewer: %v", err)
	}
	if !closed {
		t.Fatal("expected last viewer leave to close the session")
	}
	if _, ok := mgr.Get(sessionID); ok {
		t.Fatal("session should be gone after the last viewer left")
	}
	_ = session
}

func TestLeaveViewer_UnregisteredViewerIsNoop(t *testing.T) {
	mgr, sessionID := newPrimedManager(t, "android-emulator")
	live, _ := mgr.getLive(sessionID)
	seedViewers(t, live, "phone-1")

	session, closed, err := mgr.leaveViewer(sessionID, "nobody")
	if err != nil {
		t.Fatalf("leaveViewer: %v", err)
	}
	if closed {
		t.Fatal("session closed when an unknown viewer left")
	}
	if session.ViewerCount != 1 {
		t.Fatalf("viewerCount = %d, want 1 (unknown leave is a no-op)", session.ViewerCount)
	}
}

func TestLeaveViewer_UnknownSessionErrors(t *testing.T) {
	mgr := NewRemoteRuntimeManager()
	if _, _, err := mgr.leaveViewer("rr_doesnotexist", "phone-1"); err == nil {
		t.Fatal("expected an error leaving an unknown session")
	}
}

func TestRoster_ReturnsViewerCountsAndFilters(t *testing.T) {
	mgr := NewRemoteRuntimeManager()
	now := time.Now().UTC().Format(time.RFC3339)
	ids := []string{"rr_roster_a", "rr_roster_b"}
	for i, id := range ids {
		mgr.mu.Lock()
		mgr.sessions[id] = RemoteRuntimeSession{
			ID:        id,
			WorkDir:   "/tmp/project-" + string(rune('a'+i)),
			TargetID:  "browser-window",
			Status:    "streaming",
			DeviceID:  "DEVICE-" + string(rune('a'+i)),
			CreatedAt: now,
			UpdatedAt: now,
		}
		mgr.live[id] = &remoteRuntimeLiveState{sessionID: id, targetID: "browser-window", deviceID: "DEVICE-" + string(rune('a'+i))}
		mgr.mu.Unlock()
	}
	seedViewers(t, mgr.live["rr_roster_a"], "phone-1")

	// All sessions, stamped counts — mirror the HTTP roster contract
	// (remote_runtime.go:1928-1937 stamps each session before returning).
	all := mgr.List()
	if len(all) != 2 {
		t.Fatalf("List() = %d sessions, want 2", len(all))
	}
	counts := map[string]int{}
	for _, s := range mgr.List() {
		counts[s.ID] = mgr.stampViewerCount(s).ViewerCount
	}
	if counts["rr_roster_a"] != 1 {
		t.Fatalf("roster_a viewerCount = %d, want 1", counts["rr_roster_a"])
	}
	if counts["rr_roster_b"] != 0 {
		t.Fatalf("roster_b viewerCount = %d, want 0", counts["rr_roster_b"])
	}

	// Stamped via the handler's stampViewerCount path (the GET contract).
	if got := mgr.stampViewerCount(mgr.sessions["rr_roster_a"]).ViewerCount; got != 1 {
		t.Fatalf("handler-stamped viewerCount = %d, want 1", got)
	}
}

func TestCreateWith_SeedsCreatorAttribution(t *testing.T) {
	// The vibe-room contract: when a surface creates a session with its
	// clientId + surface, the DTO and the viewer roster both record WHO
	// started it, so a returning surface can find "the room I began" by
	// startedBy/sourceSurface and the roster can say "Kivan · phone started
	// this". Break this and a TV that leaves and returns cannot rejoin its
	// own room by attribution.
	mgr := NewRemoteRuntimeManager()
	creator := remoteRuntimeCreator{ClientID: "tvos-abc123", Surface: string(SurfaceTV)}
	session, err := mgr.CreateWith("/tmp/project", "swift", "ios-simulator", "direct-webrtc", creator)
	if err != nil {
		t.Fatalf("CreateWith: %v", err)
	}
	if session.StartedBy != "tvos-abc123" {
		t.Fatalf("StartedBy = %q, want tvos-abc123", session.StartedBy)
	}
	if session.SourceSurface != "tv" {
		t.Fatalf("SourceSurface = %q, want tv", session.SourceSurface)
	}

	live, ok := mgr.getLive(session.ID)
	if !ok {
		t.Fatal("session has no live state")
	}
	live.mu.Lock()
	defer live.mu.Unlock()
	v, ok := live.viewers["tvos-abc123"]
	if !ok {
		t.Fatalf("creator viewer not seeded; roster = %#v", live.viewers)
	}
	if v.Surface != "tv" || v.Kind != "webrtc" {
		t.Fatalf("creator viewer = %+v, want surface=tv kind=webrtc", v)
	}
}

func TestCreateWith_NoCreatorKeepsLegacyShape(t *testing.T) {
	// An anonymous create (legacy clients, or a create that omits clientId)
	// must not seed a viewer row nor set startedBy — the exact pre-Phase-A
	// behaviour. This pins that the attribution change is additive.
	mgr := NewRemoteRuntimeManager()
	session, err := mgr.CreateWith("/tmp/project", "swift", "ios-simulator", "direct-webrtc", remoteRuntimeCreator{})
	if err != nil {
		t.Fatalf("CreateWith: %v", err)
	}
	if session.StartedBy != "" || session.SourceSurface != "" {
		t.Fatalf("anonymous create attributed creator: startedBy=%q sourceSurface=%q", session.StartedBy, session.SourceSurface)
	}
	live, ok := mgr.getLive(session.ID)
	if !ok {
		t.Fatal("session has no live state")
	}
	live.mu.Lock()
	defer live.mu.Unlock()
	if len(live.viewers) != 0 {
		t.Fatalf("anonymous create seeded viewers: %#v", live.viewers)
	}
}
