package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Regression (2026-08-10, owner self-lockout): a long-lived `yaver mcp`
// process keeps serving the binary it STARTED with. The npm launcher resolves
// ~/.yaver/bin/current at spawn time, so an update that replaces `current`
// leaves every already-running MCP process silently on the old version —
// "inventory says current → 1.99.411, operation says 1.99.409". That drift is
// how exec_command returned `Status: <nil>` for hours after the fix shipped.
// mcpProcessIsStale must report the drift so the guard can NAME it on stderr.
//
// PROVEN BY BREAKING: reverting to a comparison that resolves only `current`
// (never the running exe) makes the stale case compare equal and the test
// fails with "stale = false, want true".
func TestMCPProcessIsStale_DetectsCurrentDrift(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".yaver", "bin")
	// The running process was started from an OLD versioned tree.
	runningExe := filepath.Join(binDir, "1.99.409", "linux-arm64", "yaver")
	if err := os.MkdirAll(filepath.Dir(runningExe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(runningExe, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	// `current` now points at a NEWER version.
	newExe := filepath.Join(binDir, "1.99.411", "linux-arm64", "yaver")
	if err := os.MkdirAll(filepath.Dir(newExe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newExe, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	currentSymlink := filepath.Join(binDir, "current")
	if err := os.Symlink(newExe, currentSymlink); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}

	stale, running, current := mcpProcessIsStale(runningExe, currentSymlink)
	if !stale {
		t.Fatalf("stale = false, want true — a process on 1.99.409 with current → 1.99.411 IS stale (running=%s current=%s)", running, current)
	}
	if filepath.Base(filepath.Dir(filepath.Dir(running))) != "1.99.409" {
		t.Errorf("running = %s, want the old versioned tree", running)
	}
	if filepath.Base(filepath.Dir(filepath.Dir(current))) != "1.99.411" {
		t.Errorf("current = %s, want the new versioned tree", current)
	}

	// And a process actually started FROM current is NOT stale.
	notStale, _, _ := mcpProcessIsStale(newExe, currentSymlink)
	if notStale {
		t.Fatal("a process running the exact binary current points to must not be stale")
	}
}
