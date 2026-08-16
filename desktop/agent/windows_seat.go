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
