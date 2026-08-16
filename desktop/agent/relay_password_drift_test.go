package main

import (
	"testing"
)

// Regression (2026-08-10, ubuntu-4gb-hel1-1): refreshRelayPasswordFromConvex
// used to write ONLY cfg.RelayPassword. CachedRelayPassword stayed stale, and
// transportHeadersForBase read the CACHED field first — so every relay request
// shipped the old password until the relay's invalid-auth limiter locked the
// owner's own IP out with "too many invalid relay password attempts".
//
// persistFreshRelayPassword is the single writer that updates BOTH fields (and
// the per-server Password entries) in one pass; refresh must route through it.
// This test pins the no-drift contract: after a refresh, the canonical field,
// the cached field and the cached-servers entry all carry the SAME password.
//
// PROVEN BY BREAKING: reverting main.go's refresh back to a bare
// `cfg.RelayPassword = pw` leaves CachedRelayPassword at its old value — the
// assertion below fails exactly the way the live box failed.
func TestPersistFreshRelayPassword_NoCanonicalCachedDrift(t *testing.T) {
	cfg := &Config{}
	cfg.CachedRelayPassword = "old-cached"
	cfg.RelayServers = []RelayServerConfig{{HttpURL: "https://relay.example.com"}}
	cfg.CachedRelayServers = []RelayServerConfig{{HttpURL: "https://relay.example.com", Password: "old-server"}}

	persistFreshRelayPassword(cfg, "https://relay.example.com", "fresh-password")

	if cfg.RelayPassword != "fresh-password" {
		t.Fatalf("RelayPassword = %q, want the fresh password", cfg.RelayPassword)
	}
	if cfg.CachedRelayPassword != "fresh-password" {
		t.Fatalf("CachedRelayPassword = %q, want the fresh password — a stale cached copy is what shipped the old password over the relay and triggered the owner self-lockout", cfg.CachedRelayPassword)
	}
	if len(cfg.RelayServers) != 1 || cfg.RelayServers[0].Password != "fresh-password" {
		t.Fatalf("RelayServers[0].Password = %q, want the fresh password", cfg.RelayServers[0].Password)
	}
	if len(cfg.CachedRelayServers) != 1 || cfg.CachedRelayServers[0].Password != "fresh-password" {
		t.Fatalf("CachedRelayServers[0].Password = %q, want the fresh password", cfg.CachedRelayServers[0].Password)
	}
}

// transportHeadersForBase must prefer the canonical cfg.RelayPassword over the
// cached copy when only the canonical field was refreshed (a legacy state a
// pre-fix machine can be carrying). This is the second half of the drift fix:
// even if CachedRelayPassword is somehow stale on disk, the header sent to the
// relay must use the field every refresh path writes.
//
// PROVEN BY BREAKING: reverting the cached-servers branch to read
// CachedRelayPassword first makes this test send "old-cached" and fail.
func TestTransportHeadersForBase_PrefersCanonicalRelayPassword(t *testing.T) {
	cfg := &Config{
		ConvexSiteURL:       "https://convex.example.com",
		RelayPassword:       "fresh-canonical",
		CachedRelayPassword: "old-cached",
		CachedRelayServers: []RelayServerConfig{
			{HttpURL: "https://public.yaver.io"},
		},
	}

	// Real callers always address a device through the relay (/d/<id>), and
	// transportHeadersForBase only attaches relay credentials on that path —
	// a bare origin URL is the pre-auth/health path with no password needed.
	headers, err := transportHeadersForBase(cfg, "https://public.yaver.io/d/2ed7da41-bd6c-4dad-8a13-116756a7ed02")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	got := headers["X-Relay-Password"]
	if got != "fresh-canonical" {
		t.Fatalf("X-Relay-Password = %q, want the canonical RelayPassword — the stale cached copy must never win", got)
	}
}
