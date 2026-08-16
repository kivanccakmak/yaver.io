package main

// tmux_stream.go — live runner-pane SSE for surfaces that cannot run a PTY.
//
//	GET /tmux/stream?session=<name>|pane=%37|all=1
//
// tvOS, visionOS and the web sidebar today either poll `/tmux/sessions`
// snapshots or attach a full xterm over `/ws/runner`. Both are wrong for a
// constrained surface: polling hides the moment a pane flips to awaiting-input,
// and a raw PTY needs a terminal emulator. This endpoint streams VibePane
// deltas as Server-Sent Events — the same classification the task list renders
// (working / awaiting-input / idle / dead / no-agent), pushed the instant it
// changes, so a TV can show "claude is waiting for your input" without polling
// and without owning a TUI.
//
// Events:
//
//	event: pane    data: {VibePane}     — a pane's state changed (or initial)
//	event: done    data: {reason}       — target vanished / stream closed
//	event: ping    data: {}             — keepalive while quiet
//
// The stream targets ONE pane by default (the safest unit: send-keys and
// capture-pane are both pane-scoped). `session` picks the session's active
// pane; `all=1` streams every pane on the box. State is read at a bounded
// cadence so a 4 GB Ubuntu host is not asked to fork tmux per frame.

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	tmuxStreamPollInterval = 1500 * time.Millisecond
	tmuxStreamKeepalive    = 25 * time.Second
)

// streamTarget selects what a /tmux/stream caller wants to watch.
type streamTarget struct {
	sessionName string
	paneID      string
	all         bool
}

func parseTmuxStreamTarget(r *http.Request) streamTarget {
	q := r.URL.Query()
	t := streamTarget{
		sessionName: strings.TrimSpace(q.Get("session")),
		paneID:      strings.TrimSpace(q.Get("pane")),
		all:         q.Get("all") == "1" || q.Get("all") == "true",
	}
	if t.paneID == "" && t.sessionName == "" {
		t.all = true
	}
	return t
}

// handleTmuxStream serves GET /tmux/stream.
func (s *HTTPServer) handleTmuxStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		jsonError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}
	if !tmuxAvailable() {
		jsonError(w, http.StatusServiceUnavailable, "tmux is not available on this machine")
		return
	}

	target := parseTmuxStreamTarget(r)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()

	// Keep track of each pane's last signature so a quiet pane does not
	// re-emit every poll. Signature covers status+agent+preview tail; a working
	// agent redraws its spinner so status churn is naturally caught by the
	// sampler the VibePane already carries.
	send := func(event string, payload interface{}) bool {
		data, err := json.Marshal(payload)
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	lastSig := map[string][32]byte{}
	lastPane := map[string]VibePane{}
	tick := time.NewTicker(tmuxStreamPollInterval)
	defer tick.Stop()
	lastPing := time.Now()

	// Initial snapshot is always pushed so a late join is not blank. Read the
	// machine ONCE: the old path called ListVibePanes twice back-to-back, paying
	// for two process-tree/capture probes and sometimes seeding signatures from
	// a different frame than the one it had just emitted.
	panes, err := ListVibePanes(ctx)
	if err != nil {
		_ = send("done", map[string]string{"reason": err.Error()})
		return
	}
	initial := matchingStreamPanes(target, panes)
	if !target.all && len(initial) == 0 {
		_ = send("done", map[string]string{"reason": "target session or pane is not live"})
		return
	}
	if len(initial) == 0 {
		if !send("pane", nil) { // all-mode empty snapshot, not an error
			return
		}
	}
	for _, p := range initial {
		if !send("pane", p) {
			return
		}
		lastSig[p.PaneID] = paneStreamSig(p)
		lastPane[p.PaneID] = p
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}

		if time.Since(lastPing) > tmuxStreamKeepalive {
			if !send("ping", map[string]string{}) {
				return
			}
			lastPing = time.Now()
		}

		panes, err := ListVibePanes(ctx)
		if err != nil {
			if !send("done", map[string]string{"reason": err.Error()}) {
				return
			}
			return
		}
		matched := matchingStreamPanes(target, panes)
		if !target.all && len(matched) == 0 {
			_ = send("done", map[string]string{"reason": "target session or pane is gone"})
			return
		}
		live := map[string]bool{}
		for _, p := range matched {
			live[p.PaneID] = true
			sig := paneStreamSig(p)
			prev, known := lastSig[p.PaneID]
			if known && prev == sig {
				continue
			}
			lastSig[p.PaneID] = sig
			lastPane[p.PaneID] = p
			if !send("pane", p) {
				return
			}
		}
		// In all-mode, a vanished pane is a state change too. Emit one terminal
		// pane frame so a TV/web list can remove or dim it; otherwise the last
		// live frame stays painted forever even though the pane is gone.
		if target.all {
			for id, previous := range lastPane {
				if live[id] {
					continue
				}
				previous.Status = VibeStatusDead
				previous.StatusReason = "The tmux pane closed."
				previous.Options = nil
				if !send("pane", previous) {
					return
				}
				delete(lastPane, id)
				delete(lastSig, id)
			}
		}
	}
}

func matchingStreamPanes(t streamTarget, panes []VibePane) []VibePane {
	out := make([]VibePane, 0, len(panes))
	for _, p := range panes {
		if targetMatchesPane(t, p) {
			out = append(out, p)
		}
	}
	return out
}

// targetMatchesPane reports whether a pane is part of the requested stream.
func targetMatchesPane(t streamTarget, p VibePane) bool {
	if t.all {
		return true
	}
	if t.paneID != "" {
		return p.PaneID == t.paneID
	}
	if t.sessionName != "" {
		return p.SessionName == t.sessionName
	}
	return true
}

// paneStreamSig is the change-detection key for a pane. Status and agent
// identity are cheap to compare; the preview tail is what actually moves while
// an agent works.
func paneStreamSig(p VibePane) [32]byte {
	// Options/statusReason/model are user-visible state. The first draft keyed
	// only status+preview, so a menu whose wording changed under the same
	// awaiting-input status never reached the TV. IdleMs is deliberately left
	// out: it increments continuously and would turn an event stream back into
	// polling traffic.
	s := strings.Join([]string{
		p.Status, p.StatusReason, p.Agent, p.Model, p.SessionName, p.PaneID,
		p.Title, strings.Join(p.Options, "\x1e"), tailLines(p.Preview, 8),
	}, "|")
	return sha256.Sum256([]byte(s))
}
