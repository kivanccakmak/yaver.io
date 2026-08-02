package main

import (
	"log"
	"os"
)

// Bridge the standard library logger into ~/.yaver/agent.log.
//
// Incident 2026-07-31. ubuntu-4gb-hel1-1 spent hours unreachable, repeating
// this in journald every ~60 seconds:
//
//	[RELAY 46.224.110.38:4433] Connection lost after 0s: registration rejected: invalid relay password
//	[relay] watchdog: no live tunnel for 2m0s despite 1 configured relay(s) — forcing redial
//
// while `grep -iE 'relay|register|tunnel' ~/.yaver/agent.log agent.log.1`
// returned ZERO lines. agent.log is the file `yaver logs` prints, the file
// `yaver doctor` reads and the file every support bundle ships — and it showed
// a box with no connectivity problem whatsoever. diaglog.go's own comment
// claimed `journalctl -u yaver` "carries the same tagged trace as agent.log";
// for anything written through stdlib log.Printf that was never true.
//
// The split was structural, not accidental: diag() writes the file and mirrors
// INFO+ to stderr, whereas stdlib log writes ONLY to stderr. Under systemd
// stderr is journald, so every one of the 1135 log.Printf call sites in this
// package — including all 30 [RELAY] lines, the single most important lane on
// a remote box — was journal-only. Converting the relay call sites alone would
// have fixed this box and left the same trap set for every other subsystem.
//
// installStdlibLogBridge redirects stdlib log at the destination instead, so
// the fix is one seam rather than 1135 edits, and code written tomorrow
// inherits it without knowing this file exists.

// stdlibLogBridge receives already-formatted lines from the standard logger.
type stdlibLogBridge struct{}

func (stdlibLogBridge) Write(p []byte) (int, error) {
	// stderr FIRST, and unconditionally. stdlib log's destination has always
	// been stderr, which under systemd is the journal; that lane must survive
	// byte-for-byte. It is also the lane that outlives a full disk, which is
	// precisely the run whose trace matters most.
	n, err := os.Stderr.Write(p)

	// …then the file, best-effort. writeRaw never returns an error and never
	// panics: logging must not be the thing that takes the agent down.
	diag().writeRaw(p)

	return n, err
}

// installStdlibLogBridge points the standard logger at the bridge. Safe to
// call more than once.
//
// Deliberately called from the serve path only. One-shot CLI commands write
// their own output for a human who is watching; appending that to the daemon's
// diagnostic file would interleave two unrelated stories in one log.
func installStdlibLogBridge() {
	log.SetOutput(stdlibLogBridge{})
}
