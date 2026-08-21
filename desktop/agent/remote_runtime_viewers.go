package main

// remote_runtime_viewers.go — Phase-A viewer registry for shared live
// sessions. Before this file, a remote-runtime session knew only about
// WebRTC peers (remoteRuntimeLiveState.peers) and "someone pulled a
// frame recently" (lastFrameAt); there was no notion of WHO was watching.
// That made every surface create its own private session: nothing could
// join an existing one, nothing could show "2 devices watching", and a
// viewer leaving destroyed the session for everyone.
//
// This adds a per-session viewer registry keyed by clientId. A viewer is
// registered when it attaches (WebRTC offer with a clientId) or when it
// polls /frame (relay-jpeg-poll with ?clientId=). Presence changes
// broadcast `viewer_joined` / `viewer_left` on the session's events
// DataChannel so attached peers can render "N watching". A refcounted
// `leave` detaches a single viewer and only tears the session down when
// the last viewer leaves.
//
// Deliberately in-process only, matching the control lease: arbitration
// among the clients this agent serves. A fleet-wide registry is the
// deferred relay-bus work; nothing here depends on it.

import (
	"fmt"
	"strings"
	"time"
)

// remoteRuntimeViewerFresh is how long a frame-poll viewer counts as
// present after its last /frame pull, so a relay-jpeg-poll phone that
// polls every ~900ms keeps its presence row without us needing a
// disconnect signal. WebRTC viewers are alive as long as their peer is.
const remoteRuntimeViewerFresh = 15 * time.Second

// remoteRuntimeViewer is one device attached to a shared session.
type remoteRuntimeViewer struct {
	// ID is the stable surface id (clientId), e.g. "tvos-<uuid>" or a
	// web viewer's generated id. Empty when a legacy client attaches
	// without identifying itself; those still count toward viewerCount
	// but cannot be individually addressed by `leave`.
	ID string
	// Surface is the normalized X-Yaver-Surface value when known.
	Surface string
	// Kind is "webrtc" (a peer in live.peers) or "frame-poll"
	// (relay-jpeg-poll client hitting /frame).
	Kind string
	// peer links a webrtc viewer to its PeerConnection so leave() can
	// close exactly that peer. Nil for frame-poll viewers.
	peer *remoteRuntimePeer
	// lastSeen drives freshness for frame-poll viewers.
	lastSeen time.Time
}

// registerViewer adds or refreshes a viewer row and broadcasts
// `viewer_joined` when it is new. The caller holds live.mu.
func (live *remoteRuntimeLiveState) registerViewerLocked(v remoteRuntimeViewer) {
	if live.viewers == nil {
		live.viewers = map[string]*remoteRuntimeViewer{}
	}
	key := strings.TrimSpace(v.ID)
	if key == "" {
		// Unidentified client: one anonymous row shared by all such
		// viewers so presence doesn't multiply from polling. It is
		// refreshed but never individually leavable.
		key = "\x00anonymous"
	}
	existing, ok := live.viewers[key]
	if ok {
		existing.Surface = v.Surface
		existing.lastSeen = time.Now()
		if v.Kind == "webrtc" {
			existing.Kind = "webrtc"
			existing.peer = v.peer
		}
		return
	}
	v.lastSeen = time.Now()
	live.viewers[key] = &v
	count := len(live.viewers)
	live.sendEventJSONLocked(map[string]any{
		"type":        "viewer_joined",
		"sessionId":   live.sessionID,
		"viewerId":    v.ID,
		"surface":     v.Surface,
		"viewerCount": count,
	})
}

// unregisterViewer removes a viewer and broadcasts `viewer_left`.
// Returns (wasLast, true) when this was the final viewer.
// The caller holds live.mu.
func (live *remoteRuntimeLiveState) unregisterViewerLocked(id string) (wasLast bool, removed bool) {
	key := strings.TrimSpace(id)
	if key == "" {
		return false, false // anonymous rows are not individually leavable
	}
	if _, ok := live.viewers[key]; !ok {
		return false, false
	}
	delete(live.viewers, key)
	count := len(live.viewers)
	live.sendEventJSONLocked(map[string]any{
		"type":        "viewer_left",
		"sessionId":   live.sessionID,
		"viewerId":    id,
		"viewerCount": count,
	})
	return count == 0, true
}

// viewerCountLocked counts present viewers. Caller holds live.mu.
func (live *remoteRuntimeLiveState) viewerCountLocked() int {
	if len(live.viewers) == 0 {
		return 0
	}
	now := time.Now()
	n := 0
	for _, v := range live.viewers {
		if v.Kind == "webrtc" && v.peer != nil {
			n++ // alive while the peer is attached
			continue
		}
		if now.Sub(v.lastSeen) <= remoteRuntimeViewerFresh {
			n++
		}
	}
	return n
}

// viewerSurfaceByPeer returns the registered surface for a peer, so
// teardown paths can say who left. Caller holds live.mu.
func (live *remoteRuntimeLiveState) viewerIDForPeerLocked(peer *remoteRuntimePeer) string {
	for id, v := range live.viewers {
		if v.peer == peer {
			return id
		}
	}
	return ""
}

// stampViewerCount fills the DTO's ViewerCount from live state (no-op
// for sessions with no live state, e.g. proxied builder sessions where
// the builder holds the real viewers).
func (m *RemoteRuntimeManager) stampViewerCount(session RemoteRuntimeSession) RemoteRuntimeSession {
	live, ok := m.getLive(session.ID)
	if !ok {
		return session
	}
	live.mu.Lock()
	session.ViewerCount = live.viewerCountLocked()
	live.mu.Unlock()
	return session
}

// latestPeerLocked returns the most recently attached peer, which is the
// one an in-flight offer just created. Caller holds live.mu.
func (live *remoteRuntimeLiveState) latestPeerLocked() *remoteRuntimePeer {
	if n := len(live.peers); n > 0 {
		return live.peers[n-1]
	}
	return nil
}

// leaveViewer detaches one viewer by clientId. If the viewer owned a
// WebRTC peer, that peer is closed. When the last viewer leaves, the
// session is torn down (device released) so the box stops looking full.
// This is the refcounted replacement for unconditional DELETE: a viewer
// detaching must not kill the session for everyone else still watching.
func (m *RemoteRuntimeManager) leaveViewer(sessionID, clientID string) (RemoteRuntimeSession, bool, error) {
	sessionID = strings.TrimSpace(sessionID)
	clientID = strings.TrimSpace(clientID)
	live, ok := m.getLive(sessionID)
	if !ok {
		return RemoteRuntimeSession{}, false, fmt.Errorf("remote runtime state missing")
	}

	// Find the peer BEFORE unregistering: the viewer row is the only
	// link from clientId → peer, and unregister deletes it.
	var peerToClose *remoteRuntimePeer
	live.mu.Lock()
	for id, v := range live.viewers {
		if id == clientID {
			peerToClose = v.peer
			break
		}
	}
	wasLast, removed := live.unregisterViewerLocked(clientID)
	if removed && peerToClose != nil {
		live.dropPeerLocked(peerToClose)
		remaining := len(live.peers)
		rtpMode := live.videoTrack != nil
		live.mu.Unlock()
		closeRemoteRuntimePeer(peerToClose)
		if remaining == 0 && !rtpMode {
			live.closePeer()
		}
	} else {
		live.mu.Unlock()
	}

	session, _ := m.Get(sessionID)
	session = m.stampViewerCount(session)

	// Last viewer gone and no frame-pull evidence → tear the session
	// down now instead of waiting for the reaper's grace window.
	if wasLast {
		if live, ok := m.getLive(sessionID); ok {
			live.mu.Lock()
			stillPulling := !live.lastFrameAt.IsZero() && time.Since(live.lastFrameAt) < remoteRuntimeViewerFresh
			live.mu.Unlock()
			if !stillPulling {
				m.CloseSession(sessionID)
				session, _ = m.Get(sessionID) // now empty
				return session, true, nil
			}
		}
	}
	return session, false, nil
}
