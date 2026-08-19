package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// openTestBusStore opens a scratch AutorunStore so tests never touch
// ~/.yaver/autoruns.db.
func openTestBusStore(t *testing.T) *AutorunStore {
	t.Helper()
	db, err := openSQLiteAt(t.TempDir() + "/test-bus.db")
	if err != nil {
		t.Fatal(err)
	}
	s := &AutorunStore{db: db}
	if err := s.migrate(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return s
}

// The core invariant: two sessions acquiring the same {app}@{target} — the
// second one sees a structured BuildBusHeld naming the first, never a silent
// double-build. The store is a real cross-process mutex (single-writer conn),
// so this exercises the same code path two `yaver mcp` processes would.
func TestBuildBusSecondAcquireIsBlocked(t *testing.T) {
	st := openTestBusStore(t)
	// Swap the global bus's store with the scratch one.
	global := globalBuildBus()
	global.mu.Lock()
	old := global.st
	global.st = st
	global.mu.Unlock()
	defer func() {
		global.mu.Lock()
		global.st = old
		global.mu.Unlock()
	}()

	ctx := context.Background()
	lease1, held, err := AcquireBuildBus(ctx, "medici.ai", "testflight", "/ws/medici.ai", "main", "508", BuildBusFailFast)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if held != nil {
		t.Fatalf("first acquire must succeed, got held: %v", held)
	}
	defer lease1.Release("success")

	lease2, held2, err := AcquireBuildBus(ctx, "medici.ai", "testflight", "/ws/medici.ai", "main", "509", BuildBusFailFast)
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if lease2 != nil {
		t.Fatalf("second acquire must not get a lease; got %+v", lease2)
	}
	if held2 == nil {
		t.Fatal("second acquire must report BuildBusHeld")
	}
	if held2.Code != "build_bus_held" {
		t.Fatalf("code = %q, want build_bus_held", held2.Code)
	}
	if held2.Key != "medici.ai@testflight" {
		t.Fatalf("key = %q, want medici.ai@testflight", held2.Key)
	}
	if held2.Holder != lease1.Holder {
		t.Fatalf("holder = %q, want %q (the first session)", held2.Holder, lease1.Holder)
	}
}

// Different apps to the same channel must NOT block each other — medici.ai's
// TestFlight run and yaver.io's TestFlight run are different archives.
func TestBuildBusDifferentAppsDoNotCollide(t *testing.T) {
	st := openTestBusStore(t)
	global := globalBuildBus()
	global.mu.Lock()
	old := global.st
	global.st = st
	global.mu.Unlock()
	defer func() {
		global.mu.Lock()
		global.st = old
		global.mu.Unlock()
	}()

	ctx := context.Background()
	l1, h1, err := AcquireBuildBus(ctx, "medici.ai", "testflight", "/ws/medici.ai", "main", "508", BuildBusFailFast)
	if err != nil || h1 != nil {
		t.Fatalf("app1 acquire: err=%v held=%v", err, h1)
	}
	defer l1.Release("success")

	l2, h2, err := AcquireBuildBus(ctx, "yaver.io", "testflight", "/ws/yaver.io", "main", "509", BuildBusFailFast)
	if err != nil || h2 != nil {
		t.Fatalf("app2 acquire: err=%v held=%v", err, h2)
	}
	defer l2.Release("success")
}

// A released lease frees the slot: the next acquire succeeds.
func TestBuildBusReleaseFreesSlot(t *testing.T) {
	st := openTestBusStore(t)
	global := globalBuildBus()
	global.mu.Lock()
	old := global.st
	global.st = st
	global.mu.Unlock()
	defer func() {
		global.mu.Lock()
		global.st = old
		global.mu.Unlock()
	}()

	ctx := context.Background()
	l1, h1, err := AcquireBuildBus(ctx, "yaver.io", "npm", "/ws/yaver.io", "main", "1.99.410", BuildBusFailFast)
	if err != nil || h1 != nil {
		t.Fatalf("first acquire: err=%v held=%v", err, h1)
	}
	l1.Release("success")

	l2, h2, err := AcquireBuildBus(ctx, "yaver.io", "npm", "/ws/yaver.io", "main", "1.99.411", BuildBusFailFast)
	if err != nil || h2 != nil {
		t.Fatalf("second acquire after release: err=%v held=%v", err, h2)
	}
	defer l2.Release("success")
}

// Wait mode blocks until the holder releases, then succeeds.
func TestBuildBusWaitMode(t *testing.T) {
	st := openTestBusStore(t)
	global := globalBuildBus()
	global.mu.Lock()
	old := global.st
	global.st = st
	global.mu.Unlock()
	defer func() {
		global.mu.Lock()
		global.st = old
		global.mu.Unlock()
	}()

	ctx := context.Background()
	l1, h1, err := AcquireBuildBus(ctx, "yaver.io", "convex", "/ws/yaver.io", "main", "", BuildBusFailFast)
	if err != nil || h1 != nil {
		t.Fatalf("first acquire: err=%v held=%v", err, h1)
	}
	// Release in the background after a moment.
	go func() {
		time.Sleep(300 * time.Millisecond)
		l1.Release("success")
	}()

	start := time.Now()
	l2, h2, err := AcquireBuildBus(ctx, "yaver.io", "convex", "/ws/yaver.io", "main", "", BuildBusWait)
	if err != nil {
		t.Fatalf("wait acquire: %v", err)
	}
	if h2 != nil {
		t.Fatalf("wait acquire got held: %v", h2)
	}
	if l2 == nil {
		t.Fatal("wait acquire returned nil lease")
	}
	defer l2.Release("success")
	if time.Since(start) < 100*time.Millisecond {
		t.Fatal("wait acquire returned before the holder released — it did not actually wait")
	}
}

// An expired lease (TTL passed with no heartbeat) must be taken over.
func TestBuildBusExpiredLeaseTakeover(t *testing.T) {
	st := openTestBusStore(t)
	global := globalBuildBus()
	global.mu.Lock()
	old := global.st
	global.st = st
	global.mu.Unlock()
	defer func() {
		global.mu.Lock()
		global.st = old
		global.mu.Unlock()
	}()

	ctx := context.Background()
	// Acquire with a 1-second TTL; don't release (simulates a crashed holder).
	l1, h1, err := AcquireBuildBus(ctx, "yaver.io", "cloudflare-web", "/ws/yaver.io", "main", "", BuildBusFailFast)
	if err != nil || h1 != nil {
		t.Fatalf("first acquire: err=%v held=%v", err, h1)
	}
	// Override the TTL post-hoc so expiry comes fast: the store rows use the
	// lease's TTL; instead we just wait past it by re-writing expires_at.
	if _, err := st.db.Exec(`UPDATE build_leases SET expires_at=? WHERE target=?`,
		time.Now().Add(-time.Second).Unix(), "yaver.io@cloudflare-web"); err != nil {
		t.Fatal(err)
	}
	l1.Release("success") // Release after expiry is a no-op-ish cleanup

	l2, h2, err := AcquireBuildBus(ctx, "yaver.io", "cloudflare-web", "/ws/yaver.io", "main", "", BuildBusFailFast)
	if err != nil {
		t.Fatalf("takeover acquire: %v", err)
	}
	if h2 != nil {
		t.Fatalf("expired lease must be taken over, got held: %v", h2)
	}
	if l2 == nil {
		t.Fatal("takeover returned nil lease")
	}
	defer l2.Release("success")
}

// StatusAll lists live leases.
func TestBuildBusStatusAll(t *testing.T) {
	st := openTestBusStore(t)
	global := globalBuildBus()
	global.mu.Lock()
	old := global.st
	global.st = st
	global.mu.Unlock()
	defer func() {
		global.mu.Lock()
		global.st = old
		global.mu.Unlock()
	}()

	ctx := context.Background()
	l1, _, err := AcquireBuildBus(ctx, "medici.ai", "testflight", "/ws/medici.ai", "main", "508", BuildBusFailFast)
	if err != nil {
		t.Fatal(err)
	}
	defer l1.Release("success")

	rows, err := BuildBusStatusAll()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range rows {
		if r.Key == "medici.ai@testflight" {
			found = true
			if r.Holder == "" || r.Stage == "" {
				t.Fatalf("status row missing holder/stage: %+v", r)
			}
		}
	}
	if !found {
		t.Fatalf("status did not list medici.ai@testflight: %+v", rows)
	}
}

// The flock backend must also reject a second holder on the same key.
func TestBuildBusFlockSecondHolderBlocked(t *testing.T) {
	// Force the no-store path by pointing the global bus at a closed store.
	st := openTestBusStore(t)
	st.db.Close() // simulate store failure → flock backend
	global := globalBuildBus()
	global.mu.Lock()
	global.st = st
	global.mu.Unlock()
	defer func() {
		global.mu.Lock()
		global.st = nil
		global.mu.Unlock()
	}()

	ctx := context.Background()
	l1, h1, err := AcquireBuildBus(ctx, "yaver.io", "go-agent", "/ws/yaver.io", "main", "", BuildBusFailFast)
	if err != nil {
		t.Fatalf("flock acquire: %v", err)
	}
	if h1 != nil {
		t.Fatalf("first flock acquire got held: %v", h1)
	}
	if l1 == nil || l1.flockFile == nil {
		t.Fatal("flock lease must hold the lock file")
	}
	defer l1.Release("success")

	l2, h2, err := AcquireBuildBus(ctx, "yaver.io", "go-agent", "/ws/yaver.io", "main", "", BuildBusFailFast)
	if err != nil {
		t.Fatalf("second flock acquire: %v", err)
	}
	if l2 != nil {
		t.Fatalf("second flock acquire must fail; got %+v", l2)
	}
	if h2 == nil || h2.Code != "build_bus_held" {
		t.Fatalf("second flock acquire must report held; got %+v", h2)
	}
}

// The structured held error must carry the stable code so surfaces don't
// regex prose.
func TestBuildBusHeldErrorShape(t *testing.T) {
	e := &BuildBusHeld{Code: "build_bus_held", Key: "medici.ai@testflight", Holder: "box/pid1", Stage: "archiving", StartedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(10 * time.Minute).Unix()}
	if !errors.Is(e, e) {
		t.Fatal("BuildBusHeld must be a comparable error")
	}
	msg := e.Error()
	if msg == "" || len(msg) < 20 {
		t.Fatalf("held error message too short: %q", msg)
	}
}

// Concurrency smoke: 20 goroutines competing for one slot → exactly one wins,
// the other 19 report held (never a nil/nil double-success). The winner HOLDS
// its lease until every goroutine has attempted — a real build holds for
// minutes, and releasing early would let stragglers re-acquire the freed slot
// and look like extra "winners".
func TestBuildBusConcurrentRaceOneWinner(t *testing.T) {
	st := openTestBusStore(t)
	global := globalBuildBus()
	global.mu.Lock()
	old := global.st
	global.st = st
	global.mu.Unlock()
	defer func() {
		global.mu.Lock()
		global.st = old
		global.mu.Unlock()
	}()

	ctx := context.Background()
	const n = 20
	var wg sync.WaitGroup
	win := make(chan *BuildBusLease, n)
	held := make(chan *BuildBusHeld, n)
	leaks := make(chan struct{}, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			l, h, err := AcquireBuildBus(ctx, "race-app", "testflight", "/ws/race", "main", "", BuildBusFailFast)
			if err != nil {
				t.Errorf("acquire err: %v", err)
				return
			}
			if l != nil && h != nil {
				leaks <- struct{}{} // both set — a double-acquire bug
				return
			}
			if l != nil {
				win <- l // hold it — do NOT release until the race is over
				return
			}
			if h != nil {
				held <- h
			}
		}()
	}
	wg.Wait()
	if len(win) != 1 {
		t.Fatalf("winners = %d, want exactly 1 (the rest must report held)", len(win))
	}
	if len(leaks) != 0 {
		t.Fatal("some acquire returned BOTH lease and held — double-acquire")
	}
	if len(held) != n-1 {
		t.Fatalf("held reports = %d, want %d", len(held), n-1)
	}
	// Now the race is over: release the winner's lease.
	(<-win).Release("success")
}
