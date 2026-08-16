package main

import (
	"strings"
	"testing"
)

// healthyBox is the baseline every case below perturbs by exactly one field, so
// a failure names the fault rather than the fixture.
func healthyBox() remoteBoxObservation {
	return remoteBoxObservation{
		AgentBinaryExecutable: true,
		BackupBinaryPresent:   true,
		ServiceActive:         true,
		HealthHTTP:            200,
		SessionValid:          true,
		CachedSpkiPin:         "8zLwlbw+Nh5aTWr4lil/kBZVFS78XPPkDVEU6oXJRGA=",
		PlatformSpkiPin:       "8zLwlbw+Nh5aTWr4lil/kBZVFS78XPPkDVEU6oXJRGA=",
		DiskUsedPct:           40,
	}
}

func TestPlanRemoteBoxRepair_HealthyBoxHasNothingToSay(t *testing.T) {
	if got := planRemoteBoxRepair(healthyBox()); !remoteBoxRepairIsClean(got) {
		t.Fatalf("healthy box produced findings: %+v", got)
	}
}

// ubuntu-4gb-hel1-1, 2026-08-01. An update left the binary as a symlink to its
// own path; exec failed with ELOOP, systemd reported 203 and parked the unit in
// 'activating'. Everything downstream was unobservable, so the plan must stop.
func TestPlanRemoteBoxRepair_UnrunnableBinaryIsBlockingAndStopsThePlan(t *testing.T) {
	obs := healthyBox()
	obs.AgentBinaryExecutable = false
	obs.AgentBinaryError = "too many levels of symbolic links"
	// Everything else also looks broken — because the agent is not running.
	obs.ServiceActive = false
	obs.HealthHTTP = 0
	obs.SessionValid = false
	obs.DiskUsedPct = 99

	got := planRemoteBoxRepair(obs)
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 finding (the cause), got %d: %+v", len(got), got)
	}
	f := got[0]
	if f.Check != "agent_binary" || f.Severity != "blocking" {
		t.Fatalf("got %+v, want blocking agent_binary", f)
	}
	if !f.AutoFixable {
		t.Fatal("a yaver.previous backup exists — the unbrick is deterministic and must be auto-fixable")
	}
	if f.Reason != ReasonAgentBinaryUnrunnable {
		t.Fatalf("reason = %q, want %q", f.Reason, ReasonAgentBinaryUnrunnable)
	}
	if !strings.Contains(f.Detail, "symbolic links") {
		t.Fatalf("the OS reason must survive into the detail: %q", f.Detail)
	}
}

// Without the backup there is nothing safe to restore, so the same fault must
// stop claiming it can fix itself.
func TestPlanRemoteBoxRepair_UnrunnableBinaryWithoutBackupIsNotAutoFixable(t *testing.T) {
	obs := healthyBox()
	obs.AgentBinaryExecutable = false
	obs.BackupBinaryPresent = false

	got := planRemoteBoxRepair(obs)
	if got[0].AutoFixable {
		t.Fatal("no yaver.previous — nothing to restore from, must not claim auto-fixable")
	}
	if !strings.Contains(got[0].Remedy, "npm install -g yaver-cli") {
		t.Fatalf("remedy must name the reinstall: %q", got[0].Remedy)
	}
}

// "active" with no HTTP answer is the false green: the inventory says yes, the
// operation says no.
func TestPlanRemoteBoxRepair_ActiveButNotAnsweringIsBlocking(t *testing.T) {
	obs := healthyBox()
	obs.ServiceActive = true
	obs.HealthHTTP = 0

	got := planRemoteBoxRepair(obs)
	if len(got) != 1 || got[0].Check != "agent_service" {
		t.Fatalf("got %+v, want a single agent_service finding", got)
	}
	if got[0].Severity != "blocking" || !got[0].AutoFixable {
		t.Fatalf("a restart is deterministic and the box is down: %+v", got[0])
	}
}

// The 2026-08-01 pair: relay key rotated AND session expired at the same time.
// The pin must come first — it aborts the TLS handshake before any credential
// is presented, so fixing the session first changes nothing.
func TestPlanRemoteBoxRepair_StalePinIsReportedBeforeDeadSession(t *testing.T) {
	obs := healthyBox()
	obs.CachedSpkiPin = "inNVAkIr2T7gJ/pLlP5QNjnicyDAwqwnKVT2PSnQjpI=" // the dead key
	obs.SessionValid = false

	got := planRemoteBoxRepair(obs)
	if len(got) != 2 {
		t.Fatalf("expected pin + session, got %+v", got)
	}
	if got[0].Check != "relay_pin" || got[1].Check != "session" {
		t.Fatalf("order wrong: %s then %s — the handshake failure precedes the credential one",
			got[0].Check, got[1].Check)
	}
	if !got[0].AutoFixable {
		t.Fatal("re-pulling a published pin is deterministic and must be auto-fixable")
	}
}

// Signing a box in needs an OAuth round trip. Automating a guess at it is
// exactly the class of "fix" this codebase refuses.
func TestPlanRemoteBoxRepair_DeadSessionIsNeverAutoFixable(t *testing.T) {
	obs := healthyBox()
	obs.SessionValid = false

	got := planRemoteBoxRepair(obs)
	if len(got) != 1 || got[0].Check != "session" {
		t.Fatalf("got %+v", got)
	}
	if got[0].AutoFixable {
		t.Fatal("re-auth requires a human OAuth round trip and must never be auto-applied")
	}
	if !strings.Contains(got[0].Remedy, "yaver auth --headless") {
		t.Fatalf("remedy must name the command: %q", got[0].Remedy)
	}
	// The circular remedy is the trap the web UI fell into on 2026-07-31.
	if !strings.Contains(got[0].Remedy, "rides the tunnel that is missing") {
		t.Fatalf("remedy must warn that web re-auth cannot work here: %q", got[0].Remedy)
	}
	if got[0].Reason != ReasonConnectivityRelayAuthExpired {
		t.Fatalf("reason = %q", got[0].Reason)
	}
}

// A pin is only stale when BOTH sides are known and differ. A box that pins
// nothing, or a control plane that publishes nothing, is not a fault — and
// calling it one would send every unpinned box into a pointless repair.
func TestPlanRemoteBoxRepair_MissingPinsAreNotAMismatch(t *testing.T) {
	for name, mutate := range map[string]func(*remoteBoxObservation){
		"box pins nothing":        func(o *remoteBoxObservation) { o.CachedSpkiPin = "" },
		"platform publishes none": func(o *remoteBoxObservation) { o.PlatformSpkiPin = "" },
		"neither":                 func(o *remoteBoxObservation) { o.CachedSpkiPin, o.PlatformSpkiPin = "", "" },
	} {
		t.Run(name, func(t *testing.T) {
			obs := healthyBox()
			mutate(&obs)
			if got := planRemoteBoxRepair(obs); !remoteBoxRepairIsClean(got) {
				t.Fatalf("got %+v, want no findings", got)
			}
		})
	}
}

func TestPlanRemoteBoxRepair_DiskPressureWarnsButNeverDeletes(t *testing.T) {
	obs := healthyBox()
	obs.DiskUsedPct = 99

	got := planRemoteBoxRepair(obs)
	if len(got) != 1 || got[0].Check != "disk" {
		t.Fatalf("got %+v", got)
	}
	if got[0].Severity != "warning" {
		t.Fatalf("severity = %q, want warning — the box still runs", got[0].Severity)
	}
	if got[0].AutoFixable {
		t.Fatal("Yaver must not delete files it did not create")
	}
	// 94% must stay quiet, or the warning becomes background noise.
	obs.DiskUsedPct = 94
	if got := planRemoteBoxRepair(obs); !remoteBoxRepairIsClean(got) {
		t.Fatalf("94%% should not warn yet: %+v", got)
	}
}
