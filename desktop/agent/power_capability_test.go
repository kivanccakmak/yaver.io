package main

// Tests for the power-capability decision seam.
//
// These are the tests that let us claim a per-platform answer without owning a
// Raspberry Pi, a Docker container and a locked-down Mac. Every case below is a
// machine shape a real user has, and the assertion is always the same shape:
// when we say "no", we must say WHY, offer a REMEDY, and name an ALTERNATIVE —
// because a capability report that only says "no" is the half-product that sent
// users to a spinner in the first place.

import (
	"strings"
	"testing"
)

func actionFor(t *testing.T, f PowerFacts, id PowerActionID) PowerAction {
	t.Helper()
	a, ok := PowerActionByID(f, id)
	if !ok {
		t.Fatalf("no action %q in report", id)
	}
	return a
}

// A root Linux box with systemd is the easy case: a real reboot, a real command.
func TestHostRebootAvailableOnRootLinux(t *testing.T) {
	f := PowerFacts{GOOS: "linux", IsRoot: true, PasswordlessSudo: true, ServiceManager: "systemd-system", AgentUser: "root"}
	a := actionFor(t, f, ActionHostReboot)
	if !a.Available {
		t.Fatalf("root linux should be able to reboot; reason=%q", a.Reason)
	}
	if a.Scope != ScopeMachine {
		t.Errorf("scope = %q, want %q", a.Scope, ScopeMachine)
	}
	// Root must not be told to use sudo — that is the kind of copy that makes a
	// user think the feature is broken when it is working.
	if strings.Contains(a.Command, "sudo") {
		t.Errorf("root command should not use sudo, got %q", a.Command)
	}
	if a.ETASeconds != rebootETALinuxSeconds {
		t.Errorf("eta = %d, want %d", a.ETASeconds, rebootETALinuxSeconds)
	}
	if !a.Destructive {
		t.Error("host reboot must be marked destructive")
	}
	if len(a.Loses) == 0 {
		t.Error("a destructive action must enumerate what it destroys")
	}
}

// Passwordless sudo (the sudoers grant) is as good as root for this purpose.
func TestHostRebootAvailableWithPasswordlessSudo(t *testing.T) {
	f := PowerFacts{GOOS: "linux", PasswordlessSudo: true, ServiceManager: "systemd-system", AgentUser: "deploy"}
	a := actionFor(t, f, ActionHostReboot)
	if !a.Available {
		t.Fatalf("passwordless sudo should permit reboot; reason=%q", a.Reason)
	}
	if !strings.HasPrefix(a.Command, "sudo -n ") {
		t.Errorf("non-root command must go through sudo -n, got %q", a.Command)
	}
}

// macOS gets a longer recovery budget than Linux. Calling a Mac "overdue" at
// 60s would train the user to ignore the warning.
func TestDarwinRebootUsesLongerETA(t *testing.T) {
	f := PowerFacts{GOOS: "darwin", IsRoot: true, PasswordlessSudo: true, ServiceManager: "launchd", AgentUser: "root"}
	a := actionFor(t, f, ActionHostReboot)
	if !a.Available {
		t.Fatalf("root darwin should be able to reboot; reason=%q", a.Reason)
	}
	if !strings.Contains(a.Command, "shutdown -r now") {
		t.Errorf("darwin should use shutdown -r now, got %q", a.Command)
	}
	if a.ETASeconds != rebootETADarwinSeconds {
		t.Errorf("darwin eta = %d, want %d", a.ETASeconds, rebootETADarwinSeconds)
	}
	if a.ETASeconds <= rebootETALinuxSeconds {
		t.Error("darwin must get a longer recovery budget than linux")
	}
}

// The common real-world Mac: agent under launchd as a normal user, no sudo.
// This is the case that used to render an enabled button that could only fail.
func TestUnprivilegedMacCannotRebootButSaysWhyAndHow(t *testing.T) {
	f := PowerFacts{GOOS: "darwin", ServiceManager: "launchd", AgentUser: "kivanc", UID: 501}
	a := actionFor(t, f, ActionHostReboot)
	if a.Available {
		t.Fatal("an unprivileged agent must NOT advertise host reboot")
	}
	if !strings.Contains(a.Reason, "kivanc") {
		t.Errorf("reason must name the agent user so the remedy is actionable; got %q", a.Reason)
	}
	if a.Remedy == "" {
		t.Fatal("an unavailable-but-fixable action must carry a remedy")
	}
	// The remedy has to be the specific sudoers line, not "check your config".
	if !strings.Contains(a.Remedy, rebootSudoersPath) || !strings.Contains(a.Remedy, "kivanc") {
		t.Errorf("remedy must name the sudoers path and the user; got %q", a.Remedy)
	}
	if a.Alternative != ActionAgentRestart {
		t.Errorf("must offer the achievable alternative, got %q", a.Alternative)
	}
	// And the alternative must actually BE available on this box, or we are
	// pointing the user at a second dead end.
	alt := actionFor(t, f, ActionAgentRestart)
	if !alt.Available {
		t.Fatalf("the suggested alternative must be available; reason=%q", alt.Reason)
	}
}

// A container has no host to reboot. This must never render as an available
// "Reboot machine", and the refusal must not send the user off to configure
// sudo — that would be a fix for a problem they do not have.
func TestContainerNeverClaimsHostReboot(t *testing.T) {
	for _, runtimeName := range []string{"docker", "podman", "lxc", "kubernetes"} {
		t.Run(runtimeName, func(t *testing.T) {
			// Deliberately ROOT with passwordless sudo: privilege is not the
			// blocker here, and a decision that checked privilege first would
			// wrongly say yes.
			f := PowerFacts{
				GOOS: "linux", IsRoot: true, PasswordlessSudo: true,
				Container: runtimeName, ServiceManager: "systemd-system", AgentUser: "root",
			}
			a := actionFor(t, f, ActionHostReboot)
			if a.Available {
				t.Fatalf("%s container must not advertise a host reboot", runtimeName)
			}
			if a.Scope == ScopeMachine {
				t.Error("a container action must not claim machine scope")
			}
			if !strings.Contains(a.Means, runtimeName) {
				t.Errorf("Means must name the container runtime; got %q", a.Means)
			}
			// The dangerous misreading is "this will power-cycle the box".
			// State the opposite explicitly.
			if !strings.Contains(strings.ToLower(a.Means), "cannot power-cycle") {
				t.Errorf("Means must say it cannot power-cycle the host; got %q", a.Means)
			}
			if strings.Contains(a.Remedy, rebootSudoersPath) {
				t.Errorf("must NOT suggest a sudoers grant inside a container; got %q", a.Remedy)
			}
			if a.Alternative != ActionAgentRestart {
				t.Errorf("alternative = %q, want agent_restart", a.Alternative)
			}
		})
	}
}

// WSL: rebooting the distro is not rebooting Windows, and we cannot run
// `wsl.exe --shutdown` from inside it.
func TestWSLNeverClaimsHostReboot(t *testing.T) {
	f := PowerFacts{GOOS: "linux", IsRoot: true, PasswordlessSudo: true, WSLVersion: 2, ServiceManager: "systemd-system", AgentUser: "root"}
	a := actionFor(t, f, ActionHostReboot)
	if a.Available {
		t.Fatal("WSL must not advertise a host reboot")
	}
	if !strings.Contains(a.Means, "WSL2") {
		t.Errorf("Means must name WSL2; got %q", a.Means)
	}
	if !strings.Contains(strings.ToLower(a.Means), "never reboot windows") {
		t.Errorf("Means must be explicit that Windows does not reboot; got %q", a.Means)
	}
	if !strings.Contains(a.Remedy, "wsl.exe --shutdown") {
		t.Errorf("remedy must name the command that actually works, from Windows; got %q", a.Remedy)
	}
}

// An OS we have not implemented must say so plainly rather than offering a
// button that throws.
func TestUnsupportedOSRefusesHonestly(t *testing.T) {
	f := PowerFacts{GOOS: "windows", IsRoot: true, AgentUser: "dev"}
	a := actionFor(t, f, ActionHostReboot)
	if a.Available {
		t.Fatal("windows host reboot is not implemented; must not advertise it")
	}
	if !strings.Contains(a.Reason, "windows") {
		t.Errorf("reason must name the OS; got %q", a.Reason)
	}
}

// The agent-restart alternative is only real when something would bring the
// agent back. Offering "restart" with no supervisor is how you take a user's
// box permanently offline from a phone — the exact stuck state this feature is
// supposed to prevent.
func TestAgentRestartUnavailableWithoutSupervisor(t *testing.T) {
	f := PowerFacts{GOOS: "linux", AgentUser: "dev"} // hand-started `yaver serve`
	a := actionFor(t, f, ActionAgentRestart)
	if a.Available {
		t.Fatal("must not offer to restart an unsupervised agent — nothing would bring it back")
	}
	if !strings.Contains(strings.ToLower(a.Means), "unreachable") {
		t.Errorf("Means must state the risk of leaving the box unreachable; got %q", a.Means)
	}
	if a.Remedy == "" {
		t.Error("must say how to get a supervisor installed")
	}
}

func TestAgentRestartCommandPerServiceManager(t *testing.T) {
	cases := []struct {
		manager string
		goos    string
		uid     int
		want    string
	}{
		{"launchd", "darwin", 501, "launchctl kickstart -k gui/501/io.yaver.agent"},
		{"systemd-user", "linux", 1000, "systemctl --user restart yaver"},
		{"systemd-system", "linux", 1000, "sudo -n systemctl restart yaver"},
	}
	for _, tc := range cases {
		t.Run(tc.manager, func(t *testing.T) {
			f := PowerFacts{GOOS: tc.goos, ServiceManager: tc.manager, UID: tc.uid, AgentUser: "dev"}
			a := actionFor(t, f, ActionAgentRestart)
			if !a.Available {
				t.Fatalf("%s should permit an agent restart; reason=%q", tc.manager, a.Reason)
			}
			if a.Command != tc.want {
				t.Errorf("command = %q, want %q", a.Command, tc.want)
			}
			if a.Scope != ScopeAgent {
				t.Errorf("agent restart must be agent-scoped, got %q", a.Scope)
			}
		})
	}
}

// The invariant that makes the whole report trustworthy: any action we refuse
// must explain itself. A bare `available:false` is what we are replacing.
func TestEveryUnavailableActionExplainsItself(t *testing.T) {
	shapes := []PowerFacts{
		{GOOS: "linux", AgentUser: "dev", ServiceManager: "systemd-user"},
		{GOOS: "darwin", AgentUser: "dev", ServiceManager: "launchd"},
		{GOOS: "linux", Container: "docker", IsRoot: true, PasswordlessSudo: true, ServiceManager: "systemd-system"},
		{GOOS: "linux", WSLVersion: 2, IsRoot: true, PasswordlessSudo: true},
		{GOOS: "windows", AgentUser: "dev"},
		{GOOS: "linux", AgentUser: "dev"},
	}
	for _, f := range shapes {
		for _, a := range PowerActionsFor(f) {
			if a.Available {
				if a.Means == "" {
					t.Errorf("%+v: available action %q has no Means", f, a.ID)
				}
				continue
			}
			if a.Reason == "" {
				t.Errorf("%+v: unavailable %q has no Reason", f, a.ID)
			}
			if a.Remedy == "" {
				t.Errorf("%+v: unavailable %q has no Remedy", f, a.ID)
			}
			if a.Means == "" {
				t.Errorf("%+v: unavailable %q has no Means", f, a.ID)
			}
		}
	}
}

// Every destructive action must enumerate its cost — the confirm dialog renders
// this, and a confirm dialog that does not state what is lost is a trap.
func TestDestructiveActionsStateTheirCost(t *testing.T) {
	f := PowerFacts{GOOS: "linux", IsRoot: true, PasswordlessSudo: true, ServiceManager: "systemd-system", AgentUser: "root"}
	for _, a := range PowerActionsFor(f) {
		if a.Destructive && len(a.Loses) == 0 {
			t.Errorf("destructive action %q does not say what it destroys", a.ID)
		}
	}
}

// The report is a stable, complete contract — surfaces index into it by ID.
func TestReportAlwaysCarriesEveryAction(t *testing.T) {
	f := PowerFacts{GOOS: "linux"}
	got := PowerActionsFor(f)
	want := []PowerActionID{ActionHostReboot, ActionAgentRestart, ActionAgentShutdown}
	if len(got) != len(want) {
		t.Fatalf("report has %d actions, want %d", len(got), len(want))
	}
	for i, id := range want {
		if got[i].ID != id {
			t.Errorf("action[%d] = %q, want %q", i, got[i].ID, id)
		}
		if got[i].Label == "" {
			t.Errorf("action %q has no label", id)
		}
	}
}
