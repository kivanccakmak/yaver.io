package main

// devport_preflight_test.go — the port pre-flight and bind-failure classifier.
//
// Incident these encode (2026-07-25, Mac mini / e-mobile Flutter preview):
// an orphaned `flutter run -d web-server --web-port 9100` from an unrelated
// project still held :9100. The new preview's flutter died with "Failed to bind
// web development server: Address already in use", the readiness probe was
// answered BY THE ORPHAN, and /dev/status reported running:true, serving:true —
// pointing the phone at a different project's app for 23 hours' worth of
// leftover state.

import (
	"fmt"
	"net"
	"testing"
)

func TestPickFreeDevPortLeavesAFreePortAlone(t *testing.T) {
	// Find a port nothing holds, then assert we don't move off it.
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	probe.Close() // now free

	got, substituted := pickFreeDevPort(port, devPortProbeSpan)
	if substituted {
		t.Errorf("free port %d was substituted for %d — a free port must be used as-is", port, got)
	}
	if got != port {
		t.Errorf("pickFreeDevPort(%d) = %d, want %d", port, got, port)
	}
}

func TestPickFreeDevPortSkipsAnOccupiedPort(t *testing.T) {
	// Stand in for the orphaned dev server: hold the preferred port.
	orphan, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer orphan.Close()
	held := orphan.Addr().(*net.TCPAddr).Port

	got, substituted := pickFreeDevPort(held, devPortProbeSpan)
	if !substituted {
		t.Fatalf("port %d is held by another listener but pickFreeDevPort kept it — "+
			"the dev server would die on bind while the probe answered from the wrong process", held)
	}
	if got == held {
		t.Fatalf("substituted but returned the same port %d", got)
	}
	if got <= held || got > held+devPortProbeSpan {
		t.Errorf("substituted port %d is outside the announced span (%d..%d)", got, held+1, held+devPortProbeSpan)
	}
	// The replacement must actually be bindable — otherwise we've only moved
	// the failure.
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", got))
	if err != nil {
		t.Fatalf("substituted port %d is not bindable: %v", got, err)
	}
	ln.Close()
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
		{"node/vite/next", "Error: listen EADDRINUSE: address already in use :::5173", true},
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
