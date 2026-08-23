package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestCheckRunnerBinaryCachesSuccessfulProbe(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script probe test is Unix-only")
	}

	clearRunnerBinaryCheckCache()
	dir := t.TempDir()
	countFile := filepath.Join(dir, "count.txt")
	cmdPath := filepath.Join(dir, "fake-runner")
	script := "#!/bin/sh\n" +
		"printf '1\\n' >> " + shellQuoteForTest(countFile) + "\n" +
		"echo '1.2.3'\n"
	if err := os.WriteFile(cmdPath, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake runner: %v", err)
	}

	oldPath := os.Getenv("PATH")
	t.Setenv("PATH", dir+string(os.PathListSeparator)+oldPath)

	if err := CheckRunnerBinary("fake-runner"); err != nil {
		t.Fatalf("first CheckRunnerBinary: %v", err)
	}
	if err := CheckRunnerBinary("fake-runner"); err != nil {
		t.Fatalf("second CheckRunnerBinary: %v", err)
	}

	data, err := os.ReadFile(countFile)
	if err != nil {
		t.Fatalf("read count file: %v", err)
	}
	if got := strings.Count(strings.TrimSpace(string(data)), "1"); got != 1 {
		t.Fatalf("probe count = %d, want 1", got)
	}
}

func TestCheckRunnerBinaryDoesNotCacheMissingRunner(t *testing.T) {
	clearRunnerBinaryCheckCache()
	name := "definitely-missing-yaver-runner"
	if err := CheckRunnerBinary(name); err == nil {
		t.Fatalf("expected missing runner error")
	}
	if _, ok := cachedRunnerBinaryPath(name); ok {
		t.Fatalf("missing runner %q should not be cached", name)
	}
}

// Incident guard (2026-08-23): the mobile Tasks composer showed "Codex
// ready", then rejected Send with `codex found but not working: signal:
// killed (output: )`. The agent log showed successful Codex version/auth
// probes immediately before and after the rejected request. Under load, one
// duplicate version child missed its deadline while the same executable had
// already answered another probe. A transient inventory probe must not veto
// the real runner operation when a recent success exists.
func TestCheckRunnerBinaryUsesRecentSuccessAfterEmptyTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script probe test is Unix-only")
	}

	clearRunnerBinaryCheckCache()
	t.Cleanup(clearRunnerBinaryCheckCache)
	oldTimeout := runnerVersionProbeTimeout
	runnerVersionProbeTimeout = 40 * time.Millisecond
	t.Cleanup(func() { runnerVersionProbeTimeout = oldTimeout })

	dir := t.TempDir()
	cmdPath := filepath.Join(dir, "slow-runner")
	if err := os.WriteFile(cmdPath, []byte("#!/bin/sh\nsleep 5\n"), 0o755); err != nil {
		t.Fatalf("write fake runner: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	// Expired for skip-probe purposes, still recent enough to establish that
	// this exact executable worked before the transient timeout.
	runnerBinaryCheckCache.Store("slow-runner", runnerBinaryCheckEntry{
		path: cmdPath,
		at:   time.Now().Add(-runnerBinaryCheckCacheTTL - time.Second),
	})

	if err := CheckRunnerBinary("slow-runner"); err != nil {
		t.Fatalf("recent successful probe should let the real operation run: %v", err)
	}
}

func TestCheckRunnerBinaryRejectsTimeoutAfterStaleSuccessGrace(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script probe test is Unix-only")
	}

	clearRunnerBinaryCheckCache()
	t.Cleanup(clearRunnerBinaryCheckCache)
	oldTimeout := runnerVersionProbeTimeout
	runnerVersionProbeTimeout = 40 * time.Millisecond
	t.Cleanup(func() { runnerVersionProbeTimeout = oldTimeout })

	dir := t.TempDir()
	cmdPath := filepath.Join(dir, "stuck-runner")
	if err := os.WriteFile(cmdPath, []byte("#!/bin/sh\nsleep 5\n"), 0o755); err != nil {
		t.Fatalf("write fake runner: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	runnerBinaryCheckCache.Store("stuck-runner", runnerBinaryCheckEntry{
		path: cmdPath,
		at:   time.Now().Add(-runnerBinaryCheckStaleSuccessTTL - time.Second),
	})

	if err := CheckRunnerBinary("stuck-runner"); err == nil {
		t.Fatal("a genuinely stale success must not hide a newly stuck runner")
	}
}

func shellQuoteForTest(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}
