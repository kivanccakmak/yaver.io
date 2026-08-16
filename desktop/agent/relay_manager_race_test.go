package main

import (
	"context"
	"sync"
	"testing"
	"time"
)

// TestRelayManagerConcurrentAccess proves the rm.mu guard with the race
// detector: watchConfig and healthCheckLoop write relayManager's maps from
// different goroutines, and their unguarded collision was a
// `fatal error: concurrent map writes` — instant, defer-skipping process
// death (prime suspect for the mac mini's 3-hour silence, 2026-07-27; see
// docs/audits/agent-fork-exhaustion-deep-analysis-2026-07.md).
//
// Prove-by-breaking: remove rm.mu.Lock() from applyRelayServers or the
// accessors and `go test -race -run TestRelayManagerConcurrentAccess` fails.
// applyRelayServers is exercised with an empty desired set so no tunnel
// goroutines (network dials) are spawned.
func TestRelayManagerConcurrentAccess(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rm := newRelayManager(ctx, "test-device", "tok", "127.0.0.1:0", "pw", "")

	var wg sync.WaitGroup
	// close() broadcasts to every goroutine; a time.After channel delivers its
	// single value to exactly ONE receiver and leaves the rest spinning forever.
	stop := make(chan struct{})
	time.AfterFunc(300*time.Millisecond, func() { close(stop) })
	loop := func(fn func()) {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				fn()
			}
		}
	}

	wg.Add(5)
	go loop(func() { rm.applyRelayServers(nil, map[string]string{}) })                // watchConfig path
	go loop(func() { rm.setHealthStatus("https://r.example", &RelayHealthStatus{}) }) // healthCheckLoop path
	go loop(func() { _ = rm.tunnelCount() })
	go loop(func() { rm.setLastSettingsRelay("https://r.example"); _ = rm.getLastSettingsRelay() })
	go loop(func() { rm.setGlobalPassword("pw2") })
	wg.Wait()
}
