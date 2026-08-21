package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRenderMobileWorkspaceStatusCarriesNamedFixRoute(t *testing.T) {
	status := mobileWorkspaceStatus{
		Device: mobileWorkspaceGate{Ready: true},
		OpenCode: mobileWorkspaceGate{
			Code:   "mobile_workspace.opencode.provider_required",
			Detail: "Connect a provider on this remote box",
			Action: &mobileWorkspaceAction{Label: "Configure OpenCode", Method: "PATCH", Path: "/runner/opencode/config"},
		},
	}
	var out bytes.Buffer
	renderMobileWorkspaceStatusBlock(&out, status, "  ")
	for _, want := range []string{"mobile_workspace.opencode.provider_required", "PATCH /runner/opencode/config"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("CLI Mobile Workspace output missing %q: %s", want, out.String())
		}
	}
}

func TestParseRunnerStatusFlowAcceptsAliasStatus(t *testing.T) {
	target, sub, extra, ok := parseRunnerStatusFlow([]string{"test", "status"})
	if !ok {
		t.Fatalf("expected ok=true for [test status], got false")
	}
	if target != "test" {
		t.Fatalf("target=%q want test", target)
	}
	if sub != "status" {
		t.Fatalf("sub=%q want status", sub)
	}
	if len(extra) != 0 {
		t.Fatalf("extra=%v want empty", extra)
	}
}

func TestParseRunnerStatusFlowAcceptsAtAliasStatus(t *testing.T) {
	target, sub, _, ok := parseRunnerStatusFlow([]string{"@test", "status", "--json"})
	if !ok {
		t.Fatalf("expected ok=true, got false")
	}
	if target != "@test" {
		t.Fatalf("target=%q want @test", target)
	}
	if sub != "status" {
		t.Fatalf("sub=%q want status", sub)
	}
}

func TestParseRunnerStatusFlowDoesNotShadowSubcommands(t *testing.T) {
	cases := []string{"list", "ls", "set", "setup", "add", "remove", "trigger", "pause", "logs", "sandbox", "agent", "help"}
	for _, head := range cases {
		_, _, _, ok := parseRunnerStatusFlow([]string{head, "status"})
		if ok {
			t.Fatalf("parseRunnerStatusFlow accepted reserved subcommand %q — would shadow `yaver runner %s`", head, head)
		}
	}
}

func TestParseRunnerStatusFlowRequiresStatusSecondArg(t *testing.T) {
	_, _, _, ok := parseRunnerStatusFlow([]string{"test", "claude"})
	if ok {
		t.Fatalf("parseRunnerStatusFlow should not match runner-auth quick flow (test claude)")
	}
	_, _, _, ok = parseRunnerStatusFlow([]string{"test", "codex"})
	if ok {
		t.Fatalf("parseRunnerStatusFlow should not match runner-auth quick flow (test codex)")
	}
}

func TestParseRunnerAuthQuickFlowStillBeatsStatusForRunnerArgs(t *testing.T) {
	_, runner, _, ok := parseRunnerAuthQuickFlow([]string{"test", "claude-code"})
	if !ok {
		t.Fatalf("runner-auth quick flow regression — [test claude-code] no longer parses")
	}
	if runner != "claude" {
		t.Fatalf("normalised runner=%q want claude", runner)
	}
}

func TestNormalizePrimaryRunnerQuickArgIgnoresStatusAndAuth(t *testing.T) {
	if got := normalizePrimaryRunnerQuickArg("status"); got != "" {
		t.Fatalf("normalizePrimaryRunnerQuickArg(status)=%q want empty", got)
	}
	if got := normalizePrimaryRunnerQuickArg("auth"); got != "" {
		t.Fatalf("normalizePrimaryRunnerQuickArg(auth)=%q want empty", got)
	}
	if got := normalizePrimaryRunnerQuickArg("claude-code"); got != "claude" {
		t.Fatalf("normalizePrimaryRunnerQuickArg(claude-code)=%q want claude", got)
	}
}
