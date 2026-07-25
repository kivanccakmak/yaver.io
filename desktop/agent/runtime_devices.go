package main

// runtime_devices.go — exclusive assignment of simulators / emulators / attached
// devices to a vibe session, and the one place that joins ALL machine resources
// (ports + devices) back to the session holding them.
//
// ── The bug this closes ──────────────────────────────────────────────────────
//
// testkit.rankSimulatorsFromList scores an already-booted simulator +100 because
// reusing a warm device is seconds instead of a cold boot. Correct — but the old
// code returned only the winner, so EVERY session on the machine picked the SAME
// simulator. Two people vibing two projects both drove one device: the second
// `simctl install` replaced the first's app, both WebRTC streams showed the same
// screen, taps from one participant moved the other's UI, and nothing said so.
// `firstOnlineEmulator` had the identical shape on the Android side.
//
// This is the port bug wearing different clothes (devserver_ports.go), so it gets
// the same treatment and shares the same registry (exclusive_claims.go): rank the
// candidates, claim the first one nobody holds, boot it if cold, release on stop.
//
// What it deliberately does NOT do: stop a human from opening Simulator.app and
// tapping. Claims arbitrate Yaver against itself; they cannot own the machine.

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/yaver-io/agent/testkit"
)

var runtimeDeviceClaims = newClaimRegistry[string]()

// AcquireRuntimeDevice claims the best AVAILABLE device from a ranked candidate
// list for `owner` (a vibeOwnerTag). Returns the chosen id and a release func.
//
// `kind` is the target family ("ios-simulator", "android-emulator", …) and is
// carried into the report so a client can say "iPhone 15 simulator" rather than a
// bare UDID.
func AcquireRuntimeDevice(kind, owner string, ranked []string) (string, func(), error) {
	for _, id := range ranked {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if release, ok := runtimeDeviceClaims.tryClaim(id, kind, owner); ok {
			if len(ranked) > 1 && id != ranked[0] {
				log.Printf("[devices] %s: %s is in use by another session — assigned %s instead",
					kind, shortDeviceID(ranked[0]), shortDeviceID(id))
			}
			return id, release, nil
		}
	}
	// Everything is claimed. Name WHO has them: "no simulator available" sends the
	// user hunting a phantom, while "Batikan's session on the web has both" is
	// immediately actionable (ask them, or boot another device).
	if len(ranked) == 0 {
		return "", nil, fmt.Errorf("no %s is available on this machine", kind)
	}
	var holders []string
	for _, id := range ranked {
		if who, ok := runtimeDeviceClaims.heldBy(id); ok {
			holders = append(holders, fmt.Sprintf("%s→%s", shortDeviceID(id), who))
		}
	}
	return "", nil, fmt.Errorf("every %s on this machine is already claimed by another session (%s) — "+
		"free one, or create another device so the sessions can run side by side",
		kind, strings.Join(holders, ", "))
}

// RuntimeDeviceClaimedBy reports which session holds a device, for the roster and
// for honest error messages.
func RuntimeDeviceClaimedBy(deviceID string) (string, bool) {
	return runtimeDeviceClaims.heldBy(deviceID)
}

// ClaimAwareSimulatorChooser returns a testkit Chooser that claims exclusively on
// behalf of `owner`. Wiring it into IOSSimDriver keeps testkit free of any notion
// of sessions: it ranks, we arbitrate.
//
// The returned release func is captured by the caller through `out`, because the
// Chooser signature (candidates → chosen) has nowhere to put it.
func ClaimAwareSimulatorChooser(kind, owner string, out *func()) func([]string) (string, bool) {
	return func(candidates []string) (string, bool) {
		id, release, err := AcquireRuntimeDevice(kind, owner, candidates)
		if err != nil {
			log.Printf("[devices] %s: %v", kind, err)
			return "", false
		}
		if out != nil {
			*out = release
		}
		return id, true
	}
}

// RankedAndroidEmulators lists online emulator serials, warmest first, so the
// same claim-walk works on Android.
func RankedAndroidEmulators(ctx context.Context) []string {
	return testkit.OnlineEmulators(ctx)
}

// shortDeviceID lives in git_push_creds_cmd.go — one truncation rule for device
// identifiers, reused rather than re-implemented.

// ─── the single resource join ────────────────────────────────────────────────

// resourcesForOwner returns every machine resource — ports AND devices — held by
// one session, in the one shape every client surface renders.
//
// This function is why the two brokers share a registry: a session's "what am I
// holding?" must be answerable in one place, or the UI grows two lists that
// disagree (and eventually a third for the next resource type).
func resourcesForOwner(owner string) []VibeResourceView {
	out := []VibeResourceView{}
	for _, p := range DevPortSnapshot() {
		if p.Owner != owner {
			continue
		}
		out = append(out, VibeResourceView{
			Type:  "port",
			Kind:  p.Kind,
			Value: fmt.Sprintf("%d", p.Port),
			Label: fmt.Sprintf("%s on :%d", p.Kind, p.Port),
			Since: p.Since.UTC().Format(time.RFC3339),
		})
	}
	for _, c := range runtimeDeviceClaims.snapshot() {
		if c.Owner != owner {
			continue
		}
		out = append(out, VibeResourceView{
			Type:  "device",
			Kind:  c.Kind,
			Value: c.Key,
			Label: fmt.Sprintf("%s %s", c.Kind, shortDeviceID(c.Key)),
			Since: c.Since.UTC().Format(time.RFC3339),
		})
	}
	return out
}

// MachineResourceReport is the whole machine in one payload: every live vibe
// session, its participants, and the resources it holds. One endpoint, one shape,
// rendered identically by web / mobile / TV / watch.
type MachineResourceReport struct {
	Hostname string            `json:"hostname"`
	Sessions []VibeSessionView `json:"sessions"`
	// Unattributed resources are held by something that predates this model (or a
	// non-session caller). Reported rather than hidden — an unexplained port is
	// exactly what the user wants to see when a start fails.
	Unattributed []VibeResourceView `json:"unattributed"`
	GeneratedAt  string             `json:"generatedAt"`
}
