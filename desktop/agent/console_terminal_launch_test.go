package main

import (
	"strings"
	"testing"
)

// The web dashboard's "click Claude/Codex on a device card" lands on
// WS /ws/terminal?launch=<runner>, which types terminalLaunchCommand into a
// fresh PTY. Measured on a live root-owned Linux box (2026-07-27):
//
//	claude --dangerously-skip-permissions
//	  → "--dangerously-skip-permissions cannot be used with root/sudo privileges"
//	IS_SANDBOX=1 claude --dangerously-skip-permissions
//	  → works
//
// Every default VPS/Hetzner agent runs as root, so without the env the web
// terminal opened and immediately refused — and blamed the user's privileges
// for our missing variable. /ws/runner has carried IS_SANDBOX=1 the whole time
// (runnerPTYPaneEnv); this is the same fix on the surface that lacked it.

func TestTerminalLaunchCommandCarriesYoloFlags(t *testing.T) {
	for _, tc := range []struct{ runner, want string }{
		{"claude", "--dangerously-skip-permissions"},
		{"claude-code", "--dangerously-skip-permissions"},
		{"glm", "--dangerously-skip-permissions"},
		{"codex", "--dangerously-bypass-approvals-and-sandbox"},
		{"opencode", "--auto"},
	} {
		got := terminalLaunchCommandFor(tc.runner, 1000)
		if !strings.Contains(got, tc.want) {
			t.Errorf("%s: launch command lost its yolo flag %q: %s", tc.runner, tc.want, got)
		}
	}
}

func TestTerminalLaunchCommandRootNeedsIsSandbox(t *testing.T) {
	// claude/glm as root: the flag is REJECTED without IS_SANDBOX=1.
	for _, runner := range []string{"claude", "claude-code", "glm"} {
		got := terminalLaunchCommandFor(runner, 0)
		if !strings.Contains(got, "IS_SANDBOX=1 claude --dangerously-skip-permissions") {
			t.Errorf("%s as root must set IS_SANDBOX=1 or claude refuses to start: %s", runner, got)
		}
		// Both branches of the `if command -v tmux` line must carry it — the
		// tmux branch is the one that actually runs on a box with tmux, and it
		// is the easy one to forget.
		if n := strings.Count(got, "IS_SANDBOX=1"); n != 2 {
			t.Errorf("%s as root: expected IS_SANDBOX=1 in BOTH the tmux and no-tmux branches, found %d: %s", runner, n, got)
		}
	}
}

func TestTerminalLaunchCommandNonRootStaysClean(t *testing.T) {
	// On a normal user account claude accepts the flag bare; injecting
	// IS_SANDBOX=1 there would be a lie about the environment.
	for _, runner := range []string{"claude", "glm"} {
		if got := terminalLaunchCommandFor(runner, 501); strings.Contains(got, "IS_SANDBOX") {
			t.Errorf("%s as non-root should not claim to be a sandbox: %s", runner, got)
		}
	}
}

func TestTerminalLaunchCommandCodexNeedsNoSandboxEnv(t *testing.T) {
	// codex has no root restriction — adding the env would be cargo cult.
	if got := terminalLaunchCommandFor("codex", 0); strings.Contains(got, "IS_SANDBOX") {
		t.Errorf("codex must not get IS_SANDBOX: %s", got)
	}
}

func TestTerminalLaunchCommandUnknownRunnerIsEmpty(t *testing.T) {
	for _, runner := range []string{"", "  ", "bash", "sh; rm -rf /"} {
		if got := terminalLaunchCommandFor(runner, 0); got != "" {
			t.Errorf("unknown runner %q must not produce a launch command, got %q", runner, got)
		}
	}
}
