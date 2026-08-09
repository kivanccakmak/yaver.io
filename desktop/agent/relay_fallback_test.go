package main

import (
	"testing"
)

// appendFreeRelayFallbacks — joint-inclusive Free + Relay Pro. A device whose
// primary relay is a user-private managed relay keeps the shared free relays
// as lower-priority OFF-LAN fallbacks, with the per-user password on each.
func TestAppendFreeRelayFallbacks(t *testing.T) {
	primary := RelayServerInfo{ID: "user-managed-mybox", HttpURL: "https://abc123.relay.yaver.io", QuicAddr: "abc123.relay.yaver.io:4433", Region: "user", Priority: 0}
	free1 := RelayServerInfo{ID: "free-eu", HttpURL: "https://relay.yaver.io", QuicAddr: "relay.yaver.io:4433", Region: "eu"}
	free2 := RelayServerInfo{ID: "free-us", HttpURL: "https://relay-us.yaver.io", QuicAddr: "relay-us.yaver.io:4433", Region: "us"}

	t.Run("private relay keeps free relays as fallbacks", func(t *testing.T) {
		servers := []RelayServerInfo{primary}
		passwords := map[string]string{primary.QuicAddr: "pw"}
		out, pw := appendFreeRelayFallbacks(servers, passwords, []RelayServerInfo{free1, free2}, primary.HttpURL, "pw")
		if len(out) != 3 {
			t.Fatalf("got %d relays, want 3 (private + 2 free)", len(out))
		}
		// Order: private first (primary), then free fallbacks.
		if out[0].ID != primary.ID {
			t.Fatalf("primary must stay first, got %s", out[0].ID)
		}
		if out[1].ID != free1.ID || out[2].ID != free2.ID {
			t.Fatalf("free fallbacks misplaced: %v", []string{out[1].ID, out[2].ID})
		}
		if pw[free1.QuicAddr] != "pw" || pw[free2.QuicAddr] != "pw" {
			t.Fatalf("per-user password not attached to free fallbacks: %v", pw)
		}
		if pw[primary.QuicAddr] != "pw" {
			t.Fatalf("primary password lost: %v", pw)
		}
	})

	t.Run("never duplicates the primary relay", func(t *testing.T) {
		// The free list contains the SAME relay the user set as primary
		// (e.g. relayUrl matches a platform entry).
		servers := []RelayServerInfo{free1}
		out, _ := appendFreeRelayFallbacks(servers, nil, []RelayServerInfo{free1, free2}, free1.HttpURL, "pw")
		if len(out) != 2 {
			t.Fatalf("got %d relays, want 2 (primary + one non-matching free)", len(out))
		}
	})

	t.Run("empty platform leaves the private relay alone", func(t *testing.T) {
		servers := []RelayServerInfo{primary}
		out, pw := appendFreeRelayFallbacks(servers, nil, nil, primary.HttpURL, "pw")
		if len(out) != 1 || out[0].ID != primary.ID {
			t.Fatalf("got %v, want primary only", out)
		}
		if pw != nil {
			t.Fatal("early return must not touch the password map")
		}
	})

	t.Run("no password means no password entries", func(t *testing.T) {
		servers := []RelayServerInfo{primary}
		out, pw := appendFreeRelayFallbacks(servers, nil, []RelayServerInfo{free1}, primary.HttpURL, "")
		if len(out) != 2 {
			t.Fatalf("got %d relays, want 2", len(out))
		}
		if pw[free1.QuicAddr] != "" {
			t.Fatalf("unexpected password on free fallback: %v", pw)
		}
	})

	t.Run("no primary URL is a no-op", func(t *testing.T) {
		servers := []RelayServerInfo{primary}
		out, _ := appendFreeRelayFallbacks(servers, nil, []RelayServerInfo{free1}, "", "pw")
		if len(out) != 1 {
			t.Fatalf("got %d relays, want 1 (no fallbacks without primary URL)", len(out))
		}
	})
}

// The helper must never pair a password with a relay whose QUIC address is
// unknown — a password on a dead entry is a credential sitting in a map that
// can never be dialled, which invites copy-paste into the wrong server.
func TestAppendFreeRelayFallbacksSkipsQuicLessEntries(t *testing.T) {
	primary := RelayServerInfo{ID: "user-managed-mybox", HttpURL: "https://abc123.relay.yaver.io", QuicAddr: "abc123.relay.yaver.io:4433"}
	quicLess := RelayServerInfo{ID: "broken", HttpURL: "https://broken.yaver.io"} // no QuicAddr
	servers := []RelayServerInfo{primary}
	out, pw := appendFreeRelayFallbacks(servers, nil, []RelayServerInfo{quicLess}, primary.HttpURL, "pw")
	// The quic-less entry is still appended (the manager filters it), but it
	// must NOT receive a password.
	if len(out) != 2 {
		t.Fatalf("got %d relays, want 2", len(out))
	}
	if _, ok := pw["broken.yaver.io:4433"]; ok {
		t.Fatalf("password attached to a quic-less fallback entry: %v", pw)
	}
}
