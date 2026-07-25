package main

// devport_preflight_test.go — the dev-server port broker and the bind-failure
// classifier: the two things that let one machine host many previews honestly.
//
// Incidents these encode, both from one Mac mini on 2026-07-25:
//
//   • An orphaned `flutter run -d web-server --web-port 9100` from an unrelated
//     project (23h old) still held :9100. The new preview died with "Address
//     already in use" while the readiness probe was answered BY THE ORPHAN, so
//     /dev/status reported running:true, serving:true and pointed the phone at a
//     different project's app.
//   • `freeswitch` had held :8081 — Metro's canonical port — for four days. Any
//     RN/Expo preview on that box would have been reported healthy while serving
//     from a telephony daemon.
//
// The broker's third job has no incident yet because it is a race, not a state:
// two concurrent starts probing the same "free" port both win. That is what
// TestBrokerNeverHandsTheSamePortToTwoCallers pins down.

import (
	"fmt"
	"net"
	"sync"
	"testing"
)

// unusedPort returns a port nothing is listening on (bind, note it, release).
// Named to avoid colliding with oauth_wizard.go's freePort().
func unusedPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	p := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return p
}

func TestBrokerKeepsAFreePreferredPort(t *testing.T) {
	want := unusedPort(t)
	got, substituted, release := AcquireDevPort("flutter", "/work/app", want)
	defer release()
	if substituted || got != want {
		t.Errorf("AcquireDevPort(%d) = %d (substituted=%v) — a free port must be used as-is", want, got, substituted)
	}
}

func TestBrokerSkipsAPortHeldByAnotherProcess(t *testing.T) {
	// Stand in for the orphaned dev server / freeswitch.
	squatter, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer squatter.Close()
	held := squatter.Addr().(*net.TCPAddr).Port

	got, substituted, release := AcquireDevPort("metro", "u1:/work/app", held)
	defer release()
	if !substituted {
		t.Fatalf(":%d is held by a foreign listener but the broker handed it out — "+
			"the dev server would die on bind while the readiness probe was answered by the squatter", held)
	}
	if got == held {
		t.Fatalf("substituted but returned the same port %d", got)
	}
	// The replacement must actually be bindable, or we only moved the failure.
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", got))
	if err != nil {
		t.Fatalf("substituted port %d is not bindable: %v", got, err)
	}
	ln.Close()
}

// The race a probe alone cannot close: choosing a port and binding it are not
// atomic, so the winner must be recorded at choice time.
func TestBrokerNeverHandsTheSamePortToTwoCallers(t *testing.T) {
	start := unusedPort(t)

	const callers = 12
	var wg sync.WaitGroup
	ports := make([]int, callers)
	releases := make([]func(), callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			p, _, release := AcquireDevPort("metro", fmt.Sprintf("u%d:/work/p%d", i, i), start)
			ports[i] = p
			releases[i] = release
		}(i)
	}
	wg.Wait()
	defer func() {
		for _, r := range releases {
			if r != nil {
				r()
			}
		}
	}()

	seen := map[int]int{}
	for i, p := range ports {
		if prev, dup := seen[p]; dup {
			t.Fatalf("callers %d and %d were both given :%d — two dev servers would fight over it "+
				"and one would die with a bind error the user never asked for", prev, i, p)
		}
		seen[p] = i
	}
	if len(seen) != callers {
		t.Errorf("expected %d distinct ports, got %d", callers, len(seen))
	}
}

func TestBrokerReleaseReturnsThePortToThePool(t *testing.T) {
	want := unusedPort(t)

	first, _, release := AcquireDevPort("vite", "/work/a", want)
	if first != want {
		t.Fatalf("setup: wanted %d, got %d", want, first)
	}
	// While held, the next caller asking for the same port must be moved along.
	second, substituted, release2 := AcquireDevPort("vite", "/work/b", want)
	defer release2()
	if !substituted || second == first {
		t.Fatalf("a held reservation was handed out twice (:%d)", first)
	}

	release()
	release() // idempotent — a double stop must not corrupt the pool

	third, _, release3 := AcquireDevPort("vite", "/work/c", want)
	defer release3()
	if third != want {
		t.Errorf("after release, :%d should be available again, got :%d — leaked reservations "+
			"shrink the machine's usable range until the agent restarts", want, third)
	}
}

func TestBrokerSnapshotAttributesEveryHeldPort(t *testing.T) {
	p := unusedPort(t)
	got, _, release := AcquireDevPort("flutter", "abcd1234:/work/e-mobile", p)
	defer release()

	var found *devPortReservation
	for _, r := range DevPortSnapshot() {
		if r.Port == got {
			rr := r
			found = &rr
			break
		}
	}
	if found == nil {
		t.Fatalf(":%d is reserved but absent from the snapshot — a user asking "+
			"\"why is my preview on %d?\" has no way to find out", got, got)
	}
	if found.Kind != "flutter" || found.Owner != "abcd1234:/work/e-mobile" {
		t.Errorf("snapshot lost the attribution: kind=%q owner=%q", found.Kind, found.Owner)
	}
	if found.Since.IsZero() {
		t.Error("snapshot has no reservation timestamp")
	}
}

// The multi-user slot allocator and the broker must not disagree during the
// window between reserving a port and binding it.
func TestSlotAllocatorSkipsPortsTheBrokerHolds(t *testing.T) {
	base := unusedPort(t)
	alloc := &DevPortAllocator{
		metroBase: base,
		webBase:   base + 100,
		maxSlots:  4,
		taken:     map[int]string{},
	}

	// A single-user session (or another user's) reserves slot 0's metro port
	// first — reserved, not yet bound, so the OS still sees it as free.
	_, _, release := AcquireDevPort("metro", "owner:/work/owner-app", base)
	defer release()

	pair, err := alloc.Reserve("user-2")
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if pair.MetroPort == base {
		t.Errorf("slot allocator handed out :%d while the broker holds it — both sessions "+
			"would point at the same port, and only one would survive the bind", base)
	}
}

func TestPortBindFailureNamesEveryFrameworkPhrasing(t *testing.T) {
	real := "Failed to bind web development server:\n" +
		"SocketException: Failed to create server socket (OS Error: Address already in use, errno = 48), address = 0.0.0.0, port = 9100"
	cases := []struct {
		name string
		tail string
		want bool
	}{
		{"flutter/dart (the observed failure)", real, true},
		{"node/vite/next/metro", "Error: listen EADDRINUSE: address already in use :::5173", true},
		{"generic", "port is already in use", true},
		{"empty tail", "", false},
		{"healthy compile output", "Compiling lib/main.dart for the Web...\nBuilt build/web", false},
		{"unrelated failure", "Error: Could not find a file named \"pubspec.yaml\"", false},
	}
	for _, tc := range cases {
		if got := portBindFailure(tc.tail); got != tc.want {
			t.Errorf("%s: portBindFailure = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// portBusy has to predict OUR outcome, not just "did a bind succeed".
//
// Both cases below were measured on a Mac mini on 2026-07-25 and each defeated a
// single-probe implementation:
//
//   - node held `*:8081` (IPv6 wildcard) and binding 127.0.0.1:8081 still
//     SUCCEEDED → a loopback-bind probe called Metro's port free when Metro could
//     not take it.
//   - The mirror case: a loopback-only listener, where Go's SO_REUSEADDR lets the
//     wildcard bind succeed → a wildcard-bind probe calls the port free, but the
//     agent's /dev/ proxy dials 127.0.0.1 and would reach the SQUATTER instead of
//     our dev server. Serving another process's app is worse than failing.
func TestPortBusyDetectsBothListenerShapes(t *testing.T) {
	t.Run("loopback-only listener (proxy would reach the squatter)", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		defer ln.Close()
		port := ln.Addr().(*net.TCPAddr).Port
		go func() { // accept, so the connect probe has something to reach
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				_ = c.Close()
			}
		}()
		if !portBusy(port) {
			t.Errorf("port %d has a loopback listener but portBusy said free — the /dev/ proxy dials "+
				"127.0.0.1, so our users' traffic would land on that process", port)
		}
	})

	t.Run("wildcard listener", func(t *testing.T) {
		ln, err := net.Listen("tcp", ":0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		defer ln.Close()
		port := ln.Addr().(*net.TCPAddr).Port
		if !portBusy(port) {
			t.Errorf("port %d has a wildcard listener but portBusy said free", port)
		}
	})

	t.Run("genuinely free port", func(t *testing.T) {
		port := unusedPort(t)
		if portBusy(port) {
			t.Errorf("port %d is free but portBusy said busy — every dev server would be pushed off "+
				"its canonical port for no reason", port)
		}
	})
}
