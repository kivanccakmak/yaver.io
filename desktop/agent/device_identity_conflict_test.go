package main

import (
	"strings"
	"testing"
)

// Both bodies are verbatim from ubuntu-4gb-hel1-1's journal on 2026-07-31 —
// the real wire shape, uncaught mutation error and all.
func TestClassifyBootstrapRejection_RealConvexBodies(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   deviceIdentityConflictKind
	}{
		{
			name:   "public key mismatch (root agent, 2026-07-31)",
			status: 400,
			body:   `{"error":"Uncaught Error: Public key mismatch\n    at handler (../convex/devices.ts:2246:23)\n"}`,
			want:   identityConflictPublicKey,
		},
		{
			name:   "hardware id mismatch (yaver-sim, 2026-07-31)",
			status: 400,
			body:   `{"error":"Uncaught Error: Hardware ID mismatch\n    at handler (../convex/devices.ts:2245:51)\n"}`,
			want:   identityConflictHardware,
		},
		{
			name:   "unrelated failure must not be claimed",
			status: 500,
			body:   `{"error":"Uncaught Error: Device not found"}`,
			want:   identityConflictNone,
		},
		{
			name:   "success is never a conflict",
			status: 200,
			body:   `{"ok":true}`,
			want:   identityConflictNone,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyBootstrapRejection(tc.status, tc.body); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

// The remedy exists to replace a stack trace, so it has to carry the three
// things a stack trace does not: what is true, what it costs, and the command.
func TestDeviceIdentityConflictRemedy_NamesCauseCostAndCommand(t *testing.T) {
	msg := deviceIdentityConflictRemedy(identityConflictPublicKey, "2ed7da41-bd6c-4dad-8a13-116756a7ed02")

	for _, want := range []string{
		"2ed7da41",      // which device, short form
		"different key", // the cause
		"UNREACHABLE",   // the cost the user actually sees on their screen
		"yaver auth",    // the command that fixes it
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("remedy is missing %q — a diagnosis without it sends the operator back to guessing.\ngot: %s", want, msg)
		}
	}

	// It must NOT leak the whole device id: these lines land in logs that get
	// pasted into issues and support bundles.
	if strings.Contains(msg, "116756a7ed02") {
		t.Fatalf("remedy leaked the full deviceId into log output:\n%s", msg)
	}
}

func TestDeviceIdentityConflictRemedy_EmptyWhenNoConflict(t *testing.T) {
	if got := deviceIdentityConflictRemedy(identityConflictNone, "abc12345"); got != "" {
		t.Fatalf("expected empty remedy for identityConflictNone, got %q", got)
	}
}
