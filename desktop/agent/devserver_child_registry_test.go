package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// alive reports whether pid still exists (signal 0 probes without delivering).
func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

// spawnDetached starts a long sleep in its OWN process group — the same shape as
// a dev-server child, so the reaper's group-kill is exercised for real.
func spawnDetached(t *testing.T, marker string) *exec.Cmd {
	t.Helper()
	// `sh -c 'exec sleep 300 #<marker>'` puts the marker in argv so the identity
	// check has something to match, exactly like `--port 19007` does in real argv.
	cmd := exec.Command("sh", "-c", fmt.Sprintf("exec sleep 300 %s", marker))
	setProcGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	t.Cleanup(func() {
		_ = killProcessGroup(cmd.Process.Pid, "KILL")
		_ = cmd.Wait()
	})
	return cmd
}

// withTempYaverDir points yaverDir() at a scratch HOME so the test never touches
// the developer's real ~/.yaver/dev-children.json.
func withTempYaverDir(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("YAVER_HOME", filepath.Join(dir, ".yaver"))
	if err := os.MkdirAll(filepath.Join(dir, ".yaver"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	got, err := devChildRegistryPath()
	if err != nil {
		t.Fatalf("registry path: %v", err)
	}
	if !strings.HasPrefix(got, dir) {
		t.Fatalf("registry path %s escaped the temp HOME %s — the test would clobber the real registry", got, dir)
	}
}

// TestReapOrphanedDevChildrenKillsOurs is the leak this file exists for: an agent
// restart must not leave a live dev child holding a port.
func TestReapOrphanedDevChildrenKillsOurs(t *testing.T) {
	withTempYaverDir(t)
	marker := "yaver-reap-mine-19007"
	cmd := spawnDetached(t, marker)
	pid := cmd.Process.Pid

	RecordDevChild(devChildRecord{
		PID: pid, Port: 19007, Kind: "expo-web",
		Match: "sleep,19007", WorkDir: "/tmp/yaver-todo-rn",
	})

	actions := ReapOrphanedDevChildren()
	if len(actions) != 1 || !strings.Contains(actions[0], "stopped orphaned expo-web") {
		t.Fatalf("expected one 'stopped orphaned' action naming the port, got %v", actions)
	}

	// Wait for the real exit. `kill(pid, 0)` cannot answer this here: the test
	// process is the child's parent, so a killed child lingers as a zombie and
	// signal-0 keeps succeeding. A real orphan is parented to init, so only the
	// exit status proves the reaper actually took it down.
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		if err == nil {
			t.Fatalf("child exited cleanly — expected death by signal from the reaper")
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("pid %d survived the reaper — the port stays bound and the next start drifts to a new one", pid)
	}
	if recs := loadDevChildren(); len(recs) != 0 {
		t.Fatalf("reaped record should be dropped, still have %+v", recs)
	}
}

// TestReapSparesRecycledPID is the guard that makes the reaper safe to run at
// every startup: a stale record whose PID now belongs to someone else's process
// must NEVER be killed. A PID is a proxy for identity; argv is the identity.
func TestReapSparesRecycledPID(t *testing.T) {
	withTempYaverDir(t)
	marker := "yaver-someone-elses-editor"
	cmd := spawnDetached(t, marker)
	pid := cmd.Process.Pid

	// Record claims this PID was an expo-web on :19008 — it is not.
	RecordDevChild(devChildRecord{
		PID: pid, Port: 19008, Kind: "expo-web",
		Match: "expo start,--web,19008", WorkDir: "/tmp/gone",
	})

	actions := ReapOrphanedDevChildren()
	if len(actions) != 1 || !strings.Contains(actions[0], "left alone") {
		t.Fatalf("expected the mismatch to be reported and spared, got %v", actions)
	}
	if !alive(pid) {
		t.Fatalf("reaper killed pid %d on a PID match alone — that is how a reaper kills a user's editor", pid)
	}
	if recs := loadDevChildren(); len(recs) != 0 {
		t.Fatalf("stale record should be dropped even when spared, still have %+v", recs)
	}
}

// TestReapDropsDeadRecordsSilently keeps the registry from growing forever.
func TestReapDropsDeadRecordsSilently(t *testing.T) {
	withTempYaverDir(t)
	cmd := spawnDetached(t, "yaver-already-dead")
	pid := cmd.Process.Pid
	_ = killProcessGroup(pid, "KILL")
	_, _ = cmd.Process.Wait()

	RecordDevChild(devChildRecord{PID: pid, Port: 8087, Kind: "metro", Match: "sleep,8087"})
	if actions := ReapOrphanedDevChildren(); len(actions) != 0 {
		t.Fatalf("a process that is already gone needs no announcement, got %v", actions)
	}
	if recs := loadDevChildren(); len(recs) != 0 {
		t.Fatalf("dead record should be pruned, still have %+v", recs)
	}
}

// TestRecordDevChildRefusesUnverifiableRecords — a record with no match string
// could only ever be reaped on PID alone, which is the dangerous case. Refuse to
// store it rather than store something the reaper must then distrust.
func TestRecordDevChildRefusesUnverifiableRecords(t *testing.T) {
	withTempYaverDir(t)
	RecordDevChild(devChildRecord{PID: 4242, Port: 3000, Kind: "next", Match: "  "})
	RecordDevChild(devChildRecord{PID: 0, Port: 3000, Kind: "next", Match: "npx,3000"})
	if recs := loadDevChildren(); len(recs) != 0 {
		t.Fatalf("unverifiable records must not be stored, got %+v", recs)
	}
}

// TestArgvMatchesAllRequiresEveryNeedle — "all", not "any". One weak needle
// ("npx") would let a recycled PID through; npx AND the port together will not.
func TestArgvMatchesAllRequiresEveryNeedle(t *testing.T) {
	argv := "npx next dev --port 3000"
	for _, tc := range []struct {
		match string
		want  bool
	}{
		{"npx,3000", true},
		{"npx,19007", false}, // right binary, wrong port — a DIFFERENT dev server
		{"vite,3000", false},
		{"", false}, // an empty match must never match anything
	} {
		if got := argvMatchesAll(argv, tc.match); got != tc.want {
			t.Errorf("argvMatchesAll(%q, %q) = %v, want %v", argv, tc.match, got, tc.want)
		}
	}
}
