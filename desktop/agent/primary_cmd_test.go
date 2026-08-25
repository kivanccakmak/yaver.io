package main

import (
	"slices"
	"testing"
)

func TestNormalizePrimaryRunnerQuickArg(t *testing.T) {
	if got := normalizePrimaryRunnerQuickArg("codex"); got != "codex" {
		t.Fatalf("codex => %q, want codex", got)
	}
	if got := normalizePrimaryRunnerQuickArg("claude-code"); got != "claude" {
		t.Fatalf("claude-code => %q, want claude", got)
	}
	if got := normalizePrimaryRunnerQuickArg("opencode"); got != "opencode" {
		t.Fatalf("opencode => %q, want opencode", got)
	}
	if got := normalizePrimaryRunnerQuickArg("set"); got != "" {
		t.Fatalf("set => %q, want empty", got)
	}
}

func TestPrimaryRunnerQuickFlowIsFreshPrimaryTmuxAndDangerousByDefault(t *testing.T) {
	for _, runner := range []string{"claude", "codex", "opencode"} {
		opts := parseRunnerPassthrough(primaryRunnerPassthroughArgs(nil))
		if opts.machine != "primary" || !opts.fresh || !opts.noSync {
			t.Fatalf("%s primary launch options = %+v, want primary + fresh + no-sync", runner, opts)
		}
		got := applyRunnerYoloDefaults(runner, opts.passthrough)
		want := map[string]string{
			"claude":   "--dangerously-skip-permissions",
			"codex":    "--dangerously-bypass-approvals-and-sandbox",
			"opencode": "--auto",
		}[runner]
		if !slices.Contains(got, want) {
			t.Fatalf("%s primary launch args = %v, want %s", runner, got, want)
		}
	}
}

func TestPrimaryRunnerQuickFlowKeepsSafeOptOutButCannotChangeTargetOrFreshness(t *testing.T) {
	opts := parseRunnerPassthrough(primaryRunnerPassthroughArgs([]string{
		"--machine=somewhere-else", "--yaver-safe", "--model", "gpt-test",
	}))
	if opts.machine != "primary" || !opts.fresh || !opts.noSync || !opts.yaverSafe {
		t.Fatalf("primary launch options = %+v", opts)
	}
	if !slices.Equal(opts.passthrough, []string{"--model", "gpt-test"}) {
		t.Fatalf("runner passthrough = %v", opts.passthrough)
	}
}
