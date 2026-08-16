package main

import (
	"os/exec"
	"strings"
	"testing"
)

// TestDevServerStatus_DeadProcessIsNotServing — /info must not claim a dev
// server is serving when its process is gone.
//
// Measured on ubuntu-4gb, 2026-08-03:
//
//	/info      running=true serving=true port=8081 pid=11999
//	ss -lntp   NOTHING listening on 8081
//	ps         pid 11999 does not exist
//
// The kernel had been OOM-killing 5-6 GB `git` processes on that box, and the
// bookkeeping goroutine that clears `b.running` did not survive whatever took
// the dev server with it. The visionOS arc trusted `serving:true`, pointed the
// capture browser at :8081 and got net::ERR_CONNECTION_REFUSED — a confusing
// error where "the dev server is not running" was the truth.
//
// `Serving: b.running` reads an in-memory flag. The liveness check existed all
// along (`PidAlive`, signal-0, in the heartbeat snapshot) and the field
// everyone actually reads never consulted it — a producer with no consumer.
//
// Remove the signal-0 probe from Status() and this test fails.
func TestDevServerStatus_DeadProcessIsNotServing(t *testing.T) {
	// A REAL process that exits immediately, so the pid is genuinely dead by
	// the time Status() runs — nothing about the thing under test is mocked.
	cmd := exec.Command("true")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	pid := cmd.Process.Pid
	if err := cmd.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}

	b := &baseDevServer{
		name:    "expo",
		running: true, // the stale flag, exactly as the OOM kill left it
		port:    8081,
		workDir: t.TempDir(),
		cmd:     cmd,
	}

	s := b.Status()
	if s.Serving {
		t.Fatalf("Status() reported serving=true for dead pid %d — that is the false green "+
			"that sent the visionOS arc at a refused connection", pid)
	}
	if s.Running {
		t.Fatalf("Status() reported running=true for dead pid %d", pid)
	}
	// A silent serving:false leaves a surface rendering an empty panel with no
	// cause. The status has to name what happened.
	if !strings.Contains(strings.ToLower(s.Error), "gone") {
		t.Fatalf("status did not say WHY it is not serving: %q", s.Error)
	}
}

// The mirror, and it is not optional: a LIVE process must still report serving,
// or the fix would quietly turn every healthy dev server off — a worse bug than
// the one being fixed.
func TestDevServerStatus_LiveProcessStillServes(t *testing.T) {
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	b := &baseDevServer{
		name:    "expo",
		running: true,
		port:    8081,
		workDir: t.TempDir(),
		cmd:     cmd,
	}

	s := b.Status()
	if !s.Serving || !s.Running {
		t.Fatalf("a live dev server was reported as not serving: running=%v serving=%v err=%q",
			s.Running, s.Serving, s.Error)
	}
	if s.Error != "" {
		t.Fatalf("a healthy dev server carried an error: %q", s.Error)
	}
}
