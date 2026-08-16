package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withTempDiagLogger points the process-wide diagnostic logger at a temp file
// for the duration of a test.
//
// diagInst is guarded by a sync.Once that another test in this package may
// already have spent, so setting HOME is not enough to redirect it. Spending
// the Once explicitly and swapping the instance works regardless of test
// ordering.
func withTempDiagLogger(t *testing.T) string {
	t.Helper()
	diagOnce.Do(func() {}) // ensure diag() will not overwrite our instance
	path := filepath.Join(t.TempDir(), "agent.log")
	prev := diagInst
	diagInst = &diagLogger{path: path, min: diagDebug}
	t.Cleanup(func() { diagInst = prev })
	return path
}

// The incident, as a test: a stdlib log.Printf on a serving agent must be
// readable in ~/.yaver/agent.log.
//
// On 2026-07-31 it was not. The relay refusal repeated in journald every 60s
// while agent.log — the file `yaver logs`, `yaver doctor` and every support
// bundle read — contained zero relay lines, so the box looked healthy in the
// one place anyone was told to look.
func TestStdlibLogBridge_WritesToAgentLog(t *testing.T) {
	path := withTempDiagLogger(t)

	prevOut := log.Writer()
	prevFlags := log.Flags()
	t.Cleanup(func() {
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	})

	installStdlibLogBridge()

	// Verbatim shape of the line that went missing.
	log.Printf("[RELAY %s] Connection lost after 0s: registration rejected: invalid relay password",
		"198.51.100.7:4433")

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("agent.log unreadable: %v", err)
	}
	if !strings.Contains(string(data), "registration rejected: invalid relay password") {
		t.Fatalf("stdlib log line never reached agent.log.\ngot: %q", string(data))
	}
	if !strings.Contains(string(data), "[RELAY 198.51.100.7:4433]") {
		t.Fatalf("bridge dropped the tag that makes the line greppable.\ngot: %q", string(data))
	}
}

// NEGATIVE CONTROL — prove the guard by breaking it.
//
// Without the bridge installed, stdlib log goes to stderr only and agent.log
// stays empty. That is the pre-fix behaviour; if this test ever fails, the
// bridge is no longer the thing doing the work and the first test above has
// stopped proving anything.
func TestStdlibLogBridge_AbsentBridgeLeavesAgentLogEmpty(t *testing.T) {
	path := withTempDiagLogger(t)

	prevOut := log.Writer()
	t.Cleanup(func() { log.SetOutput(prevOut) })

	log.SetOutput(os.Stderr) // the pre-fix wiring

	log.Printf("[RELAY] this line must not reach the file")

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return // file never created — correct
		}
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(string(data), "must not reach the file") {
		t.Fatal("agent.log received a stdlib line with no bridge installed — " +
			"something else is now writing it, so the bridge test proves nothing")
	}
}

// writeRaw must respect the size ceiling. The bridge multiplies what lands in
// agent.log (1135 call sites, a 2s status poll among them), so a rotation bug
// here fills the disk of exactly the small remote boxes this product targets.
func TestDiagWriteRaw_RotatesAtCeiling(t *testing.T) {
	path := withTempDiagLogger(t)

	line := append([]byte(strings.Repeat("x", 4096)), '\n')
	for written := 0; written < diagMaxBytes+len(line); written += len(line) {
		diagInst.writeRaw(line)
	}

	if _, err := os.Stat(path + ".1"); err != nil {
		t.Fatalf("no rotation happened past diagMaxBytes: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("live log missing after rotation: %v", err)
	}
	if info.Size() >= diagMaxBytes {
		t.Fatalf("live log is %d bytes, expected a fresh file under %d", info.Size(), diagMaxBytes)
	}
}

// A disabled logger (disk full) must swallow writes rather than spin. Logging
// is never allowed to be the thing that breaks the agent.
func TestDiagWriteRaw_DisabledIsInert(t *testing.T) {
	d := &diagLogger{disabled: true, path: filepath.Join(t.TempDir(), "agent.log")}
	d.writeRaw([]byte("should not panic or create a file\n"))
	if _, err := os.Stat(d.path); !os.IsNotExist(err) {
		t.Fatal("disabled logger created a file")
	}
}
