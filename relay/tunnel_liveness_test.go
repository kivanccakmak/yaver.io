package main

import (
	"context"
	"testing"
	"time"
)

func TestTunnelClientHealthPathIsNarrow(t *testing.T) {
	for _, path := range []string{"/info", "/healthmon", "/dev/build-native", "/tasks/id/output"} {
		if isTunnelClientHealthPath(path) {
			t.Fatalf("slow or unrelated path %q received the health deadline", path)
		}
	}
	if !isTunnelClientHealthPath("/health") {
		t.Fatal("canonical /health path did not receive the liveness deadline")
	}
}

func TestClientHealthTimeoutEvictsZombieTunnelImmediately(t *testing.T) {
	srv, addr, cleanup := startTestRelayQUIC(t, "test-pw")
	defer cleanup()

	conn, registered, err := dialAndRegister(t, addr, "device-health-zombie", "tok", "test-pw")
	if err != nil || !registered.OK {
		t.Fatalf("register: err=%v response=%+v", err, registered)
	}
	defer conn.CloseWithError(0, "test done")

	srv.mu.RLock()
	tunnel := srv.tunnels["device-health-zombie"]
	srv.mu.RUnlock()
	if tunnel == nil {
		t.Fatal("registered tunnel missing")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	stream, err := tunnel.conn.OpenStreamSync(ctx)
	if err != nil {
		t.Fatalf("open server stream: %v", err)
	}
	defer stream.CancelRead(0)

	// The test agent deliberately never accepts or answers this stream: the
	// exact zombie shape seen by the phone. A real /health must remove it on its
	// own deadline rather than wait for the periodic watcher.
	if _, err := srv.readTunnelFirstByteWithin(tunnel, stream, "/health", 50*time.Millisecond); err == nil {
		t.Fatal("silent tunnel unexpectedly answered health")
	}
	srv.mu.RLock()
	_, stillRegistered := srv.tunnels["device-health-zombie"]
	srv.mu.RUnlock()
	if stillRegistered {
		t.Fatal("timed-out health request left zombie tunnel registered")
	}
}
