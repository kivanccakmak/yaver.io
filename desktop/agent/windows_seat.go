//go:build windows
// +build windows

package main

// windows_seat.go — the in-process Windows seat manager: the native
// replacement for the tmux seat layer (tmux.go / tmux_panes.go) on Windows.
//
// WHY THIS EXISTS — the second half of the tmux-on-Windows replacement
// (2026-08-12): pty_master_windows.go gives Windows a real ConPTY, so a
// runner CAN spawn a TUI. But the runner-seat contract also needs PERSISTENCE
// (a session survives the client dropping and is reattachable by name — the
// job tmux's `new-session -A` + server does) and NAME-BASED REATTACH (a fresh
// WebSocket with the same name lands back in the same TUI). On Windows there
// is no tmux server to hold that; the agent process IS the daemon (schtasks),
// so the seat registry lives here, in-process.
//
// Contract: seats are keyed by the same names the tmux path uses
// ("yaver-<runner>", or the caller's ?name=). A reconnect with the same name
// resumes the live ConPTY terminal session (its terminalSessions entry) — the
// Windows twin of `tmux new-session -A`. The map is advisory bookkeeping: the
// authoritative liveness is the terminalSession itself; entries are pruned
// when the session closes or the name is explicitly released.

import (
	"sync"
)

// windowsSeatIndex maps a seat name ("yaver-opencode", "yaver-codex", …) to
// the live terminalSession id that currently owns it. Only meaningful on
// Windows where there is no tmux server to hold the mapping.
type windowsSeatIndex struct {
	mu      sync.Mutex
	byName  map[string]string // seat name → terminal session id
	bySess  map[string]string // terminal session id → seat name
}

func newWindowsSeatIndex() *windowsSeatIndex {
	return &windowsSeatIndex{
		byName: make(map[string]string),
		bySess: make(map[string]string),
	}
}

// register claims seatName for sessionID, returning the previous holder (if
// any) so the caller can decide whether to retire a stale session first.
func (w *windowsSeatIndex) register(seatName, sessionID string) (previous string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	previous = w.byName[seatName]
	w.byName[seatName] = sessionID
	w.bySess[sessionID] = seatName
	return previous
}

// lookup returns the terminal session id currently holding seatName, "" when
// the seat is free or was never claimed.
func (w *windowsSeatIndex) lookup(seatName string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.byName[seatName]
}

// release drops the seat claim when sessionID still holds it (a stale release
// from an already-replaced session must not unseat the new holder).
func (w *windowsSeatIndex) release(sessionID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	name := w.bySess[sessionID]
	if name == "" {
		return
	}
	if w.byName[name] == sessionID {
		delete(w.byName, name)
	}
	delete(w.bySess, sessionID)
}

// seatNameFor returns the seat name owning sessionID, "" if unclaimed.
func (w *windowsSeatIndex) seatNameFor(sessionID string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.bySess[sessionID]
}

// platform hooks — the Windows side of the shared seam in pty_master.go.

func platformWindowsSeatsEnabled(s *HTTPServer) bool { return s != nil }

func platformWindowsSeatResume(s *HTTPServer, seatName string) string {
	if s == nil || s.windowsSeats == nil {
		return ""
	}
	return s.windowsSeats.lookup(seatName)
}

func platformWindowsSeatClaim(s *HTTPServer, seatName, sessionID string) string {
	if s == nil || s.windowsSeats == nil {
		return ""
	}
	return s.windowsSeats.register(seatName, sessionID)
}

func platformWindowsSeatRelease(s *HTTPServer, sessionID string) {
	if s == nil || s.windowsSeats == nil {
		return
	}
	s.windowsSeats.release(sessionID)
}
