package main

import (
	"strings"
	"testing"
)

// The verbatim line from the owner's failed Vibing run (2026-08-02). The clone
// still pointed at the pre-migration org URL, so this could never succeed —
// and the runner edited a stale tree on every task while saying only
// "exit status 128".
const liveStaleRemoteOutput = "From https://github.com/old-org/yaver.io\nremote: Repository not found.\nfatal: repository 'https://github.com/old-org/yaver.io/' not found"

func TestClassifyGitPullFailure_StaleRemoteIsPermanent(t *testing.T) {
	f := classifyGitPullFailure("exit status 128", liveStaleRemoteOutput)
	if f.Kind != gitPullPermanent {
		t.Fatalf("a missing remote can never self-heal; got kind %q", f.Kind)
	}
	if f.Remedy == "" {
		t.Fatal("a permanent fault with no remedy is the vague error this file exists to kill")
	}
	if !strings.Contains(f.Remedy, "remote set-url") {
		t.Fatalf("the remedy must name the actual command, got %q", f.Remedy)
	}
}

func TestDescribeGitPullFailure_SaysStaleAndPermanent(t *testing.T) {
	line := describeGitPullFailure("exit status 128", liveStaleRemoteOutput)
	// The single most important word: the task may be editing STALE code.
	if !strings.Contains(line, "STALE") {
		t.Fatalf("the line must warn that the task may edit stale code, got %q", line)
	}
	if !strings.Contains(line, "will not fix itself") {
		t.Fatalf("a permanent fault must say so, or the reader assumes it retries clean; got %q", line)
	}
	if !strings.Contains(line, "continuing on the local tree") {
		t.Fatalf("it must still say the task proceeds — this is advisory, not fatal; got %q", line)
	}
}

func TestClassifyGitPullFailure_AuthIsPermanent(t *testing.T) {
	for _, out := range []string{
		"fatal: could not read Username for 'https://github.com': terminal prompts disabled",
		"remote: Authentication failed for 'https://github.com/x/y.git'",
		"git@github.com: Permission denied (publickey).",
	} {
		if got := classifyGitPullFailure("exit status 128", out); got.Kind != gitPullPermanent {
			t.Fatalf("missing credentials never self-heal: %q -> %q", out, got.Kind)
		}
	}
}

func TestClassifyGitPullFailure_DivergenceIsLocal(t *testing.T) {
	f := classifyGitPullFailure("exit status 128", "fatal: Not possible to fast-forward, aborting.")
	if f.Kind != gitPullLocal {
		t.Fatalf("a diverged clone is a LOCAL decision, not a broken remote; got %q", f.Kind)
	}
}

// NO FALSE REDS. A genuine network blip must not be reported as a
// configuration fault, or the user changes a setting that was never wrong.
func TestClassifyGitPullFailure_OfflineIsTransient(t *testing.T) {
	for _, out := range []string{
		"fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
		"ssh: connect to host github.com port 22: Operation timed out",
	} {
		got := classifyGitPullFailure("exit status 128", out)
		if got.Kind != gitPullTransient {
			t.Fatalf("an offline remote is transient: %q -> %q", out, got.Kind)
		}
		if got.Remedy != "" {
			t.Fatalf("a blip must not hand the user a chore, got remedy %q", got.Remedy)
		}
	}
}

// An output we cannot attribute must stay quiet and prescriptive-free —
// inventing a remedy for an unidentified fault is the more expensive false red,
// because it costs the user an action.
func TestClassifyGitPullFailure_UnknownStaysQuiet(t *testing.T) {
	f := classifyGitPullFailure("exit status 1", "something nobody has seen before")
	if f.Kind != gitPullTransient || f.Reason != "" || f.Remedy != "" {
		t.Fatalf("unattributed output must not be given a cause or a remedy, got %+v", f)
	}
	line := describeGitPullFailure("exit status 1", "something nobody has seen before")
	if !strings.Contains(line, "continuing on the local tree") {
		t.Fatalf("the fallback line must keep the original wording, got %q", line)
	}
	if strings.Contains(line, "will not fix itself") {
		t.Fatalf("an unknown fault must never be declared permanent, got %q", line)
	}
}
