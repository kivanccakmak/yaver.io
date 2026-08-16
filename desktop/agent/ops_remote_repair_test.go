package main

import (
	"strings"
	"testing"
)

// Captured verbatim from ubuntu-4gb-hel1-1 on 2026-08-01, after the day's
// repairs. Using real output as the fixture is the point: the parser is the
// half that rots silently when a remote tool changes its wording, and a
// hand-written fixture would keep passing while the real probe drifted.
const realProbeHealthy = `binary_path=/root/.yaver/bin/current/linux-arm64/yaver
binary_exec_ok=1
backup_present=1
service_active=1
health_http=200
session_valid=1
cached_pin=8zLwlbw+Nh5aTWr4lil/kBZVFS78XPPkDVEU6oXJRGA=
disk_used_pct=99
`

// The same box earlier that day: binary replaced by a symlink to itself, unit
// stuck in activating, nothing answering.
const realProbeBricked = `binary_path=/root/.yaver/bin/current/linux-arm64/yaver
binary_exec_ok=0
binary_exec_err=/root/.yaver/bin/current/linux-arm64/yaver: Too many levels of symbolic links
backup_present=1
service_active=0
health_http=0
session_valid=0
cached_pin=inNVAkIr2T7gJ/pLlP5QNjnicyDAwqwnKVT2PSnQjpI=
disk_used_pct=99
`

const currentPlatformPin = "8zLwlbw+Nh5aTWr4lil/kBZVFS78XPPkDVEU6oXJRGA="

func TestParseRemoteBoxProbe_RealHealthyBox(t *testing.T) {
	obs := parseRemoteBoxProbe(realProbeHealthy, currentPlatformPin)

	if !obs.AgentBinaryExecutable || !obs.BackupBinaryPresent || !obs.ServiceActive {
		t.Fatalf("healthy box misparsed: %+v", obs)
	}
	if obs.HealthHTTP != 200 || !obs.SessionValid {
		t.Fatalf("health/session misparsed: %+v", obs)
	}
	if obs.CachedSpkiPin != currentPlatformPin {
		t.Fatalf("pin misparsed: %q", obs.CachedSpkiPin)
	}
	if obs.DiskUsedPct != 99 {
		t.Fatalf("disk misparsed: %d", obs.DiskUsedPct)
	}

	// End to end: the only thing wrong with this box is the disk, and it must
	// not be auto-"fixed" by deleting anything.
	findings := planRemoteBoxRepair(obs)
	if len(findings) != 1 || findings[0].Check != "disk" {
		t.Fatalf("expected exactly one disk finding, got %+v", findings)
	}
	if findings[0].AutoFixable {
		t.Fatal("disk pressure must never be auto-fixed — Yaver does not delete files it did not create")
	}
}

func TestParseRemoteBoxProbe_RealBrickedBox(t *testing.T) {
	obs := parseRemoteBoxProbe(realProbeBricked, currentPlatformPin)

	if obs.AgentBinaryExecutable {
		t.Fatal("bricked binary parsed as runnable")
	}
	if !strings.Contains(obs.AgentBinaryError, "symbolic links") {
		t.Fatalf("the OS reason must survive the parse: %q", obs.AgentBinaryError)
	}

	// The cause, and only the cause. The stale pin and dead session in this
	// probe are consequences of an agent that cannot start.
	findings := planRemoteBoxRepair(obs)
	if len(findings) != 1 || findings[0].Check != "agent_binary" {
		t.Fatalf("expected the blocking cause alone, got %+v", findings)
	}
	if !findings[0].AutoFixable {
		t.Fatal("a backup exists — the unbrick is deterministic")
	}
}

// A probe that fails halfway must not manufacture findings out of its own
// gaps. Unknown is not the same as broken.
func TestParseRemoteBoxProbe_PartialOutputDoesNotInventFaults(t *testing.T) {
	obs := parseRemoteBoxProbe("binary_exec_ok=1\nservice_active=1\nhealth_http=200\nsession_valid=1\n", "")
	if obs.CachedSpkiPin != "" || obs.PlatformSpkiPin != "" {
		t.Fatalf("absent pins must stay empty: %+v", obs)
	}
	findings := planRemoteBoxRepair(obs)
	if !remoteBoxRepairIsClean(findings) {
		t.Fatalf("a partial probe invented findings: %+v", findings)
	}
}

// Only three checks may ever run unattended, and each must act on the path the
// probe resolved rather than a guess at the install layout.
func TestRemoteRepairCommand_OnlyDeterministicRepairsAreOffered(t *testing.T) {
	bin := "/root/.yaver/bin/current/linux-arm64/yaver"

	cmd := remoteRepairCommand(remoteBoxFinding{Check: "agent_binary"}, bin, "")
	if !strings.Contains(cmd, bin+`.previous`) || !strings.Contains(cmd, "mv -f") {
		t.Fatalf("binary restore must come from the backup via rename: %q", cmd)
	}
	if strings.Contains(cmd, "cp -a "+bin+`.previous" "`+bin+`"`) {
		t.Fatal("must not cp over a possibly-running binary")
	}

	if got := remoteRepairCommand(remoteBoxFinding{Check: "agent_service"}, bin, ""); got != "systemctl restart yaver" {
		t.Fatalf("service repair = %q", got)
	}

	// A pin repair with nothing authoritative to write is not a repair.
	if got := remoteRepairCommand(remoteBoxFinding{Check: "relay_pin"}, bin, ""); got != "" {
		t.Fatalf("pin repair without a platform pin must be refused, got %q", got)
	}
	if got := remoteRepairCommand(remoteBoxFinding{Check: "relay_pin"}, bin, currentPlatformPin); !strings.Contains(got, currentPlatformPin) {
		t.Fatalf("pin repair must write the authoritative pin: %q", got)
	}

	// Everything else is reported, never executed.
	for _, check := range []string{"session", "disk", "", "something_new"} {
		if got := remoteRepairCommand(remoteBoxFinding{Check: check}, bin, currentPlatformPin); got != "" {
			t.Fatalf("check %q must not be auto-executed, got %q", check, got)
		}
	}
}

func TestRemoteBinaryPathFromProbe(t *testing.T) {
	if got := remoteBinaryPathFromProbe(realProbeHealthy); got != "/root/.yaver/bin/current/linux-arm64/yaver" {
		t.Fatalf("got %q", got)
	}
	if got := remoteBinaryPathFromProbe("no path here\n"); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}
