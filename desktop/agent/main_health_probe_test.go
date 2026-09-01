package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A busy but healthy local agent must not be reported as unreachable. This
// reproduces the Mac release-preflight incident where /health answered in more
// than 800 ms and `yaver status` showed a false offline state.
func TestProbeLocalAgentHealthInfoAllowsBusyHealthyAgent(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(1100 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"version":"test"}`))
	}))
	defer server.Close()

	port := server.Listener.Addr().(*net.TCPAddr).Port
	if got := probeLocalAgentHealthInfo(port); got == nil || !got.OK || got.Version != "test" {
		t.Fatalf("probe = %#v, want healthy agent", got)
	}
}
