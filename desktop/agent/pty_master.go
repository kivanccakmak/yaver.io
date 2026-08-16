package main

// pty_master.go — the PTY abstraction the terminal/runner layers need,
// so the SAME code runs on Unix (creack/pty) and native Windows (ConPTY).
//
// WHY THIS EXISTS — the tmux-on-Windows replacement (2026-08-12): tmux was
// the only thing keeping runner seats alive on Windows, but it is a Unix
// program that does not exist natively there. The WSL shim (tmux.go) bridged
// tmux itself, yet the deeper gap remained: creack/pty — the PTY library
// terminal_session.go and install_registry.go call — returns ErrUnsupported
// on GOOS=windows (verified in start_windows.go), so even the non-tmux PTY
// path could not spawn a runner TUI on native Windows. This file declares the
// narrow interface those call sites need; pty_master_unix.go and
// pty_master_windows.go provide the implementations per platform.
//
// The interface is deliberately the minimum: the callers read child output,
// write child input, resize, and close. ConPTY's separate input/output
// handles are hidden behind it, exactly as creack/pty hides the Unix pty pair.

import (
	"io"
	"os"
	"os/exec"
)

// ptyMaster is what the agent needs from a pseudo-terminal: read the child's
// output, write into its input, resize the window, and close. On Unix it is
// backed by creack/pty's master; on Windows by a ConPTY handle pair.
type ptyMaster interface {
	io.ReadWriteCloser
	// Resize sets the terminal window size in columns/rows. No-op-safe:
	// callers treat an error as best-effort (the session keeps running).
	Resize(cols, rows uint16) error
}

// ptyStart spawns cmd attached to a fresh pseudo-terminal and returns the
// master. Platform dispatch lives in pty_master_unix.go / pty_master_windows.go.
func ptyStart(cmd *exec.Cmd) (ptyMaster, error) {
	return platformPTYStart(cmd)
}

// osFilePTYMaster adapts a bare *os.File (e.g. a helper-brokered PTY master
// handed back over an FD) to ptyMaster. Used by newTerminalSessionFromPTY,
// which only ever receives a real FD on Unix (the privilege-separated helper
// is a Unix mechanism); on Windows the helper returns an error so this path
// never produces a session — but the adapter must still exist there to
// compile. Resize is best-effort: an os.File has no size channel, so it is a
// no-op unless the platform can reach one.
type osFilePTYMaster struct {
	*os.File
	resizer func(*os.File, uint16, uint16) error
}

func (m *osFilePTYMaster) Resize(cols, rows uint16) error {
	if m.resizer == nil {
		return nil
	}
	return m.resizer(m.File, cols, rows)
}

// ── Windows seat hooks (runner-pty persistence without tmux) ──────────────
//
// On Unix, tmux's `new-session -A` gives runner seats persistence: a fresh
// WebSocket with the same name reattaches to the live TUI. On native Windows
// there is no tmux server; the agent process IS the daemon, so the
// windowsSeatIndex (windows_seat.go) holds the name→session mapping in
// process. These four hooks are the platform seam: Windows implements them
// against the seat index; every other platform returns the "no seat layer"
// answers so the tmux path stays the only persistence mechanism there. The
// non-Windows impls live in windows_seat_stub.go, the Windows impls in
// windows_seat.go — but the runner-pty call sites reference only these, so
// they need no GOOS switch of their own.

// windowsSeatsEnabled reports whether the in-process Windows seat layer is
// the persistence mechanism for runner PTYs (true only on native Windows).
func windowsSeatsEnabled(s *HTTPServer) bool { return platformWindowsSeatsEnabled(s) }

// windowsSeatResume returns the live terminal session id holding seatName on
// the Windows seat layer, "" when the seat is free. The caller attaches to
// that session instead of spawning a second runner — tmux `-A` semantics.
func windowsSeatResume(s *HTTPServer, seatName string) string {
	return platformWindowsSeatResume(s, seatName)
}

// windowsSeatClaim registers sessionID under seatName on the Windows seat
// layer so a later reconnect resumes it. Returns the previous holder so the
// caller can retire a stale seat if needed.
func windowsSeatClaim(s *HTTPServer, seatName, sessionID string) string {
	return platformWindowsSeatClaim(s, seatName, sessionID)
}

// windowsSeatRelease drops the claim for sessionID (called from the
// terminalSession onClose hook).
func windowsSeatRelease(s *HTTPServer, sessionID string) {
	platformWindowsSeatRelease(s, sessionID)
}
