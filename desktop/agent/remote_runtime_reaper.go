package main

// remote_runtime_reaper.go — abandoned WebRTC sessions must give their device
// back.
//
// ── The leak ─────────────────────────────────────────────────────────────────
//
// A session claims a simulator/emulator EXCLUSIVELY at attach (runtime_devices.go)
// and releases it in CloseSession. That covers the polite path. It does not cover
// the common one: a browser tab closed, a phone that went to sleep, a Playwright
// run that timed out, a client that crashed mid-negotiation. Those sessions keep
// their claim forever, and the next request gets
//
//   every ios-simulator on this machine is already claimed by another session
//
// which is TRUE, honest, actionable — and completely useless, because the session
// holding it no longer exists in any meaningful sense. Observed within minutes of
// shipping the claim mechanism: two abandoned test sessions had the mini's only
// iPhone simulator locked with nobody watching either stream.
//
// A claim with no live claimant is worse than no claim: the machine looks full
// while it is idle. So the reaper is not a nicety — it is the other half of
// exclusivity. Anything that can be claimed needs a defined way to be lost.
//
// ── The rule ─────────────────────────────────────────────────────────────────
//
// A session is reapable when it has NO connected peer and has been in that state
// past a grace period:
//
//   • control-ready / signaling with zero peers → the client never came back, or
//     left. Grace exists because a legitimate viewer takes seconds to negotiate
//     (offer → ICE → answer), and reaping mid-handshake would be its own bug.
//   • attach-failed / stopped → nothing is coming; reap on the next sweep.
//
// A session with ≥1 peer is NEVER reaped regardless of age: a person watching a
// simulator for three hours is the product working, not a leak.

import (
	"log"
	"strings"
	"sync"
	"time"
)

const (
	// remoteRuntimeIdleGrace is how long a peerless session keeps its device.
	// Long enough to survive a slow WebRTC handshake and a page reload; short
	// enough that a closed tab frees the simulator before the user gives up and
	// asks why the machine is "full".
	remoteRuntimeIdleGrace = 90 * time.Second
	// remoteRuntimeSweepEvery is the reaper cadence.
	remoteRuntimeSweepEvery = 30 * time.Second
)

// peerlessSince records when a session was first seen with no peers, so grace is
// measured from THAT moment rather than from session creation (a session that
// streamed for an hour and then lost its viewer gets the same grace as a new one).
var (
	peerlessMu    sync.Mutex
	peerlessSince = map[string]time.Time{}
)

// StartRemoteRuntimeReaper runs the sweep until ctx is done. Started once
// alongside the manager.
func (m *RemoteRuntimeManager) StartRemoteRuntimeReaper(stop <-chan struct{}) {
	go func() {
		ticker := time.NewTicker(remoteRuntimeSweepEvery)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				m.ReapAbandonedSessions(time.Now())
			}
		}
	}()
}

// ReapAbandonedSessions closes sessions that have no live viewer, releasing their
// exclusive devices. Exported (and time-injected) so a test can drive it without
// waiting on wall-clock.
func (m *RemoteRuntimeManager) ReapAbandonedSessions(now time.Time) []string {
	type candidate struct {
		id        string
		status    string
		peers     int
		lastFrame time.Time
	}

	m.mu.RLock()
	cands := make([]candidate, 0, len(m.sessions))
	for id, sess := range m.sessions {
		live := m.live[id]
		peers := 0
		var lastFrame time.Time
		if live != nil {
			live.mu.Lock()
			peers = len(live.peers)
			lastFrame = live.lastFrameAt
			live.mu.Unlock()
		}
		cands = append(cands, candidate{id: id, status: sess.Status, peers: peers, lastFrame: lastFrame})
	}
	m.mu.RUnlock()

	var reaped []string
	for _, c := range cands {
		// ── A frame pull is a viewer, even with zero WebRTC peers ───────────
		//
		// peers counts WEBRTC peer connections. A client polling /frame over
		// HTTP has none — and that is not an edge case, it is the shipped
		// `relay-jpeg-poll` transport, the one a phone falls back to on
		// cellular. CaptureFrame even marks those sessions
		// Status="streaming", Note="Relay frame polling active."
		//
		// So the reaper was closing sessions that someone was actively
		// WATCHING: measured 2026-07-25, a session died 4s after a successful
		// 58 KB JPEG pull, and the next request answered "remote runtime
		// session not found" mid-stream. The inventory (peer count) said nobody
		// was there while the operation (frames leaving every 4s) said someone
		// plainly was — and the exclusive simulator was yanked out from under
		// them.
		//
		// Frames are the evidence that matters: no viewer means no one is
		// pulling them.
		if !c.lastFrame.IsZero() && now.Sub(c.lastFrame) < remoteRuntimeIdleGrace {
			peerlessMu.Lock()
			delete(peerlessSince, c.id)
			peerlessMu.Unlock()
			continue
		}
		if c.peers > 0 {
			// Someone is watching. Never reap, and forget any earlier peerless
			// mark so a reconnect resets the clock.
			peerlessMu.Lock()
			delete(peerlessSince, c.id)
			peerlessMu.Unlock()
			continue
		}

		terminal := c.status == "attach-failed" || c.status == "stopped" || c.status == "closed"

		peerlessMu.Lock()
		first, seen := peerlessSince[c.id]
		if !seen {
			peerlessSince[c.id] = now
			first = now
		}
		peerlessMu.Unlock()

		if !terminal && now.Sub(first) < remoteRuntimeIdleGrace {
			continue // still inside the handshake grace window
		}

		log.Printf("[runtime-reaper] closing session %s (status=%s, no viewer for %s) — releasing its exclusive device so the machine stops looking full while idle",
			shortSessionID(c.id), c.status, now.Sub(first).Round(time.Second))
		m.CloseSession(c.id)

		peerlessMu.Lock()
		delete(peerlessSince, c.id)
		peerlessMu.Unlock()
		reaped = append(reaped, c.id)
	}
	return reaped
}

func shortSessionID(id string) string {
	id = strings.TrimSpace(id)
	if len(id) > 10 {
		return id[:10]
	}
	return id
}
