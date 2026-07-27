package main

// runtime_render_target_parity_test.go — the run-guest target allowlist
// exists in THREE places: isRNSimulatorTarget (Go, authoritative — the
// daemon rejects run-guest for anything else), canRunGuestOnRemoteTarget
// in mobile/src/lib/feedbackTrigger.ts, and canRunGuestOnRemoteTarget in
// web/components/dashboard/RuntimeLabView.tsx. The clients use their copy
// to decide whether to auto-fire run-guest on runtime_render_requested.
// Copies drift invisibly — neither tsc nor go vet sees a target added to
// the daemon but missing from a client (the client silently never
// rerenders that surface), or present in a client but rejected by the
// daemon (the client spams 400s). Same trap as the beaconParity.test.ts
// precedent: two independent implementations of one contract need a test
// that reads both sources.

import (
	"os"
	"strings"
	"testing"
)

var runGuestTargets = []string{
	"ios-simulator",
	"ipados-simulator",
	"watchos-simulator",
	"tvos-simulator",
	"visionos-simulator",
	"android-emulator",
	"android-wear",
	"android-tv",
	"android-xr",
	"android-auto",
	remoteRuntimeRedroidTargetID,
}

func TestRunGuestTargetListMatchesGoAllowlist(t *testing.T) {
	// The mirror list above must be exactly what isRNSimulatorTarget
	// accepts — it is the reference the client-parity checks compare
	// against, so it must not drift from the daemon either.
	for _, id := range runGuestTargets {
		if !isRNSimulatorTarget(id) {
			t.Errorf("test mirror lists %q but isRNSimulatorTarget rejects it", id)
		}
	}
	for _, no := range []string{"ios-device", "android-device", "browser-window", "desktop-screen"} {
		if isRNSimulatorTarget(no) {
			t.Errorf("isRNSimulatorTarget accepts %q — physical/stream-only targets must stay rejected", no)
		}
	}
}

func TestRunGuestTargetListMatchesClientAllowlists(t *testing.T) {
	// go test runs with cwd = desktop/agent inside the monorepo.
	clients := map[string]string{
		"mobile": "../../mobile/src/lib/feedbackTrigger.ts",
		"web":    "../../web/components/dashboard/RuntimeLabView.tsx",
	}
	for surface, path := range clients {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s client source not readable (monorepo layout changed?): %v", surface, err)
		}
		src := string(raw)
		if !strings.Contains(src, "canRunGuestOnRemoteTarget") {
			t.Fatalf("%s: canRunGuestOnRemoteTarget gone from %s — the client no longer gates run-guest, update this parity test with the new seam", surface, path)
		}
		for _, id := range runGuestTargets {
			if !strings.Contains(src, `"`+id+`"`) {
				t.Errorf("%s: daemon accepts run-guest for %q but %s does not list it — that surface will silently never auto-rerender it", surface, id, path)
			}
		}
	}
}
