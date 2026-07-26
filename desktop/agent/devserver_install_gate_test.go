package main

// The 412 missing-toolchain preflight's install affordance.
//
// The bug this pins down (2026-07 failure-recovery audit, D1a): the 412
// only fires when a NON-node tool is missing, but installability was only
// ever granted to node/npm/npx — the intersection was empty, so every 412
// that reached a client carried `installable:false`, the mobile one-tap
// install button could never render, and `helpHint` advertised
// "POST /install/node" even when the missing tool was bun or pnpm.
// A remedy that names the wrong fix is the same defect as no remedy.

import (
	"strings"
	"testing"
)

func TestCanInstallMissingToolCoversDevToolVocabulary(t *testing.T) {
	// The full vocabulary detectProjectPreparation can emit. Every one of
	// these must be installable through POST /install/<tool>, otherwise
	// the 412 offers no button and the user hits a dead end.
	for _, tool := range []string{"node", "npm", "npx", "yarn", "pnpm", "bun", "bunx"} {
		if !canInstallMissingTool([]string{tool}) {
			t.Errorf("%s must be installable via the agent", tool)
		}
	}
	if canInstallMissingTool([]string{"not-a-real-tool"}) {
		t.Errorf("unknown tools must not be advertised as installable")
	}
	if canInstallMissingTool(nil) {
		t.Errorf("empty missing list is not installable")
	}
	// Mixed: node + bun — both have recipes, still installable.
	if !canInstallMissingTool([]string{"node", "bun"}) {
		t.Errorf("node+bun must be installable")
	}
}

func TestInstallEndpointForToolNamesARealRoute(t *testing.T) {
	// Node-family missing → the managed mobile runtime install.
	if got := installEndpointForTool([]string{"node", "bun"}); got != "/install/mobile" {
		t.Errorf("node-family: got %q", got)
	}
	// Non-node tool → its own /install/<tool> route (which resolves via
	// the meta plans added alongside this test).
	if got := installEndpointForTool([]string{"bun"}); got != "/install/bun" {
		t.Errorf("bun: got %q, want /install/bun", got)
	}
	if got := installEndpointForTool([]string{"pnpm"}); got != "/install/pnpm" {
		t.Errorf("pnpm: got %q", got)
	}
	// Nothing installable → empty, so the client renders "install manually"
	// instead of a button that would 404.
	if got := installEndpointForTool([]string{"not-a-real-tool"}); got != "" {
		t.Errorf("unknown: got %q, want empty", got)
	}
}

func TestDevInstallHelpHintNamesTheRightFix(t *testing.T) {
	hint := devInstallHelpHint([]string{"bun"}, true, "/install/bun")
	if !strings.Contains(hint, "/install/bun") {
		t.Errorf("installable hint must name its own endpoint, got %q", hint)
	}
	if strings.Contains(hint, "/install/node") {
		t.Errorf("hint for bun must NOT advertise /install/node, got %q", hint)
	}
	hint = devInstallHelpHint([]string{"not-a-real-tool"}, false, "")
	if !strings.Contains(hint, "not-a-real-tool") || strings.Contains(hint, "POST /install") {
		t.Errorf("non-installable hint must name the tool and not promise an endpoint, got %q", hint)
	}
}

func TestMetaInstallPlansForNodeBackedDevTools(t *testing.T) {
	// The endpoints named above must resolve — installEndpointForTool
	// promising /install/bun while metaInstallPlan rejects "bun" is the
	// exact "remedy the product then refuses" lie from 2026-07-26.
	for _, tool := range []string{"yarn", "pnpm", "bun", "bunx"} {
		if _, ok := metaInstallPlan(tool); !ok {
			t.Errorf("metaInstallPlan(%q) missing — the advertised install would 404", tool)
		}
	}
}
