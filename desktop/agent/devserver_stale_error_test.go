package main

import (
	"strings"
	"testing"
)

// TestSuccessfulStartClearsEarlierError — a dev server that failed, then started
// fine, must not keep reporting the old failure.
//
// Observed on the Mac mini (2026-07-25): /dev/status returned
//
//	{"running":true, "framework":"nextjs", "port":3000,
//	 "error":"npm install failed: … ENOENT … package.json"}
//
// from an npm failure three hours earlier. Every client that renders `error`
// showed a broken preview over a working one. Same class as a false green,
// pointing the other way — and just as expensive, because it sends the reader
// hunting a fault that is already fixed.
func TestSuccessfulStartClearsEarlierError(t *testing.T) {
	b := &baseDevServer{name: "nextjs", port: 3000}

	b.SetError("npm install failed: exit status 254\nnpm error enoent Could not read package.json")
	if got := b.Status(); got.Error == "" || got.Running {
		t.Fatalf("after SetError expected a stated failure and running=false, got running=%v error=%q", got.Running, got.Error)
	}

	// What the readiness loop does on success.
	b.mu.Lock()
	b.running = true
	b.err = ""
	b.mu.Unlock()

	st := b.Status()
	if !st.Running {
		t.Fatalf("expected running=true after a successful start")
	}
	if st.Error != "" {
		t.Fatalf("running dev server still reports a stale failure %q — clients render this over a working preview", st.Error)
	}
	if strings.Contains(st.Error, "npm install") {
		t.Fatalf("stale npm error survived: %q", st.Error)
	}
}
