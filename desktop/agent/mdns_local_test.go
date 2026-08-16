package main

// mdns_local_test.go — guard for the mDNS *.local LAN-name capability.
//
// Covers what can be tested without root: input validation (the false-green
// shapes that would silently produce an unusable name), state persistence
// round-trip for restore, and the status read-model (managed-by-yaver flag).
// The Set() root path (scutil/hostnamectl) is exercised on the real box by
// `dns_localname_status` verification inside Set — a name that is set but not
// advertised on a LAN interface returns a loud WARNING, never a silent ok.

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalNameSetRejectsBadNames(t *testing.T) {
	mgr := &LocalNameManager{configPath: filepath.Join(t.TempDir(), localNameStateFile)}
	ctx := context.Background()

	bad := []string{"", "  ", "with space", "with.dot", ".leading", "trailing.", "a b"}
	for _, name := range bad {
		if _, err := mgr.Set(ctx, name); err == nil {
			t.Errorf("Set(%q) should reject a malformed .local name", name)
		}
	}
}

func TestLocalNameTrailingDotLocalStripped(t *testing.T) {
	// "yaver.local" typed by a user should be accepted as "yaver".
	// trimLocalSuffix lives in mdns_local.go — this test guards the real
	// production normalization, not a copy.
	for name, want := range map[string]string{
		"yaver.local": "yaver",
		"yaver":       "yaver",
		"  yaver  ":   "yaver",
		"y.local":     "y", // 6 chars total: exactly ".local" suffix
	} {
		if got := trimLocalSuffix(name); got != want {
			t.Errorf("trimLocalSuffix(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestLocalNameStateRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), localNameStateFile)
	mgr := &LocalNameManager{configPath: path}

	// Nothing set yet → restore must say so, not wipe anything.
	if _, err := mgr.Restore(context.Background()); err == nil {
		t.Fatal("Restore on a fresh manager should error (no yaver-managed name)")
	}

	// Simulate a Set by writing state directly (the root path is not
	// testable here), then verify Status sees it as yaver-managed and
	// Restore clears it.
	st := LocalNameState{Name: "yaver", PrevName: "old-host", PrevComputer: "Old Computer", ManagedBy: localNameMarker}
	if err := mgr.saveState(&st); err != nil {
		t.Fatalf("saveState: %v", err)
	}

	s := mgr.Status()
	if !s.ManagedByYaver {
		t.Error("Status should report ManagedByYaver after a yaver Set")
	}
	if s.ExpectedName != "yaver.local" {
		t.Errorf("ExpectedName = %q, want yaver.local", s.ExpectedName)
	}

	// Restore on darwin shells to scutil (root); on a unit test we only
	// check the state file is removed afterwards by calling the cleanup
	// path via os.Remove-equivalent — Restore itself needs root on darwin,
	// so instead assert the state file exists, then remove it the way
	// Restore does and confirm the manager reports unmanaged.
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("state file should exist: %v", err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatalf("remove state: %v", err)
	}
	s2 := mgr.Status()
	if s2.ManagedByYaver {
		t.Error("Status should report unmanaged after state cleared")
	}
}
