package main

import (
	"strings"
	"testing"
)

// capability_gap_task_test.go — the Tasks lane's first CapabilityGap.
//
// THE MEASUREMENT (2026-07-27). POST /tasks on a box where the runner is not
// installed dies at CheckRunnerBinary (tasks.go), which returns
// `claude not found in PATH or common locations`. CreateTaskWithOptions wraps
// it as `runner not ready: …` and the handler answers
//
//	500 {"ok":false,"error":"failed to create task: runner not ready: claude
//	     not found in PATH or common locations"}
//
// — a prose string, on the one surface (a phone) that cannot type
// `yaver install claude`. Meanwhile `POST /install/claude` has worked the whole
// time (install_cmd.go integrations table), and streams to
// /streams/install:claude.
//
// This is the Flutter incident again, one lane over: a truthful agent, a real
// fixer, and no route between them. The dev-server lane got CapabilityGap on
// 2026-07-26; Tasks had none, because DetectCapabilityGap was only ever called
// from three dev-server call sites.
func TestTaskRunnerMissingProducesAnInstallRoute(t *testing.T) {
	for _, tc := range []struct {
		runner   string
		errText  string
		endpoint string
		stream   string
	}{
		{"claude", "runner not ready: claude not found in PATH or common locations", "/install/claude", "install:claude"},
		{"codex", "runner not ready: codex not found in PATH or common locations", "/install/codex", "install:codex"},
		{"opencode", "runner not ready: opencode not found in PATH or common locations", "/install/opencode", "install:opencode"},
	} {
		t.Run(tc.runner, func(t *testing.T) {
			gap := DetectTaskCapabilityGap(tc.runner, tc.errText)
			if gap == nil {
				t.Fatal("a missing runner binary must produce a gap; nil is the 500-with-prose this test exists to remove")
			}
			if gap.Code != ReasonCapabilityToolchainMissing {
				t.Errorf("Code = %q, want %q — clients look up the code, they never regex prose", gap.Code, ReasonCapabilityToolchainMissing)
			}
			if gap.Capability != tc.runner {
				t.Errorf("Capability = %q, want %q", gap.Capability, tc.runner)
			}
			if gap.Fix == nil {
				t.Fatalf("POST %s works — a nil Fix is the dead end", tc.endpoint)
			}
			if gap.Fix.Method != "POST" || gap.Fix.Path != tc.endpoint {
				t.Errorf("Fix route = %s %s, want POST %s", gap.Fix.Method, gap.Fix.Path, tc.endpoint)
			}
			if gap.Fix.Stream != tc.stream {
				t.Errorf("Fix.Stream = %q, want %q (handleInstall's own name)", gap.Fix.Stream, tc.stream)
			}
			if !gap.Fix.Retry {
				t.Error("Retry must be true — the fix has to return the user to the prompt they typed")
			}
			// The sentence a human reads. "claude isn't installed" is a fact
			// the user can act on; "runner not ready: claude not found in PATH
			// or common locations" is a fact only a developer can.
			if !strings.Contains(gap.Summary, "isn't installed on this machine") {
				t.Errorf("Summary = %q — it must be about the MACHINE, not about exec", gap.Summary)
			}
			if !strings.Contains(gap.Summary, runnerCapabilityName(tc.runner)) {
				t.Errorf("Summary = %q must name the runner the way the rest of the product does (%q)", gap.Summary, runnerCapabilityName(tc.runner))
			}
		})
	}
}

// The fallback: the text says a binary was missing but the sentence did not
// name it. The Task knows which binary it was about to spawn — that is a
// resolution, not a guess.
func TestTaskCapabilityGapFallsBackToTheRunnerCommand(t *testing.T) {
	gap := DetectTaskCapabilityGap("codex", "runner not ready: executable file not found")
	if gap == nil {
		t.Fatal("the Task knows the binary it was about to spawn; that must be enough")
	}
	if gap.Capability != "codex" {
		t.Errorf("Capability = %q, want codex", gap.Capability)
	}
}

// The inverse obligation. Every string below is a REAL Tasks-lane failure with
// a different remedy. Claiming a toolchain gap for any of them offers an
// install that cannot help, and the user installs, retries, and fails again —
// having been taught that Yaver lies.
func TestTaskCapabilityGapRefusesNonToolchainFailures(t *testing.T) {
	for _, tc := range []struct {
		name    string
		runner  string
		errText string
	}{
		// runner_auth.go DetectRunnerRuntimeStatus — signed out, not absent.
		{"not signed in", "claude", "runner not ready: claude is not signed in — run `yaver runner-auth setup claude`"},
		// tasks.go model compatibility reject.
		{"bad model", "opencode", `model "glm-4.7" is not compatible with runner "opencode"`},
		// runner_auth.go checkRunnerWorkDirWritable.
		{"workdir not writable", "codex", "runner not ready: work dir /srv/app is not writable by this user; run: sudo chown -R me /srv/app"},
		// tasks.go startProcess.
		{"spawn errno", "claude", "start process: fork/exec /usr/bin/claude: permission denied"},
		{"empty", "claude", ""},
		{"no runner, no text", "", "runner not ready"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if gap := DetectTaskCapabilityGap(tc.runner, tc.errText); gap != nil {
				t.Errorf("produced a %q install route for %q — this failure's remedy is not an install", gap.Capability, tc.errText)
			}
		})
	}
}
