package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// The literal 2026-07-26 defect: the agent produced this exact error for a
// Flutter project on a box without Flutter, and the phone rendered a spinner.
// It must now produce a NAMED gap with an invocable route.
func TestCapabilityGapNamesFlutterAndRoutesToTheInstall(t *testing.T) {
	gap := DetectCapabilityGap(CapabilityGapContext{
		Framework: "flutter",
		WorkDir:   "/root/Workspace/e-mobile",
		Err:       `exec flutter: executable file not found in $PATH`,
	})
	if gap == nil {
		t.Fatal("the headline failure must produce a gap; nil is the spinner this file exists to remove")
	}
	if gap.Code != ReasonCapabilityToolchainMissing {
		t.Errorf("Code = %q, want the wire contract %q", gap.Code, ReasonCapabilityToolchainMissing)
	}
	if gap.Capability != "flutter" {
		t.Errorf("Capability = %q, want flutter", gap.Capability)
	}
	if gap.Summary != "Flutter isn't installed on this machine." {
		t.Errorf("Summary = %q — the user's literal demand is this sentence", gap.Summary)
	}
	if gap.Fix == nil {
		t.Fatal("POST /install/flutter works; a nil Fix is the dead end the incident was about")
	}
	if gap.Fix.Method != "POST" || gap.Fix.Path != "/install/flutter" {
		t.Errorf("Fix route = %s %s, want POST /install/flutter", gap.Fix.Method, gap.Fix.Path)
	}
	if gap.Fix.Stream != "install:flutter" {
		t.Errorf("Fix.Stream = %q, want install:flutter (handleInstall's own name)", gap.Fix.Stream)
	}
	if gap.Fix.Label != "Install Flutter" {
		t.Errorf("Fix.Label = %q, want %q", gap.Fix.Label, "Install Flutter")
	}
	if !gap.Fix.Retry {
		t.Error("Fix.Retry must be true — the fix has to return the user to what they were doing")
	}
	if gap.Fix.Est == "" {
		t.Error("a 1.2 GB SDK behind a spinner with no size is the silent-download defect")
	}
	if gap.Constraint != "" {
		t.Errorf("a gap WITH a fix must not also claim a constraint: %q", gap.Constraint)
	}
}

// The stream a Fix names must be the stream handleInstall actually opens, and
// must be DERIVED from the endpoint rather than typed twice.
func TestCapabilityGapStreamIsDerivedFromTheEndpoint(t *testing.T) {
	gap := DetectCapabilityGap(CapabilityGapContext{Framework: "flutter", MissingTools: []string{"flutter"}})
	if gap == nil || gap.Fix == nil {
		t.Fatal("flutter must resolve a fix")
	}
	if want := installStreamNameForEndpoint(gap.Fix.Path); gap.Fix.Stream != want {
		t.Errorf("Fix.Stream %q != installStreamNameForEndpoint(%q) = %q", gap.Fix.Stream, gap.Fix.Path, want)
	}
	if got := installStreamPathForEndpoint(gap.Fix.Path); got != "/streams/"+gap.Fix.Stream {
		t.Errorf("stream path %q must be /streams/ + %q", got, gap.Fix.Stream)
	}
}

// Never advertise a remedy the product refuses: every Fix.Path this producer
// emits must resolve in the same tables POST /install/<tool> consults.
func TestCapabilityGapNeverAdvertisesAnInstallThatWould404(t *testing.T) {
	for _, tool := range []string{"flutter", "bun", "bunx", "pnpm", "yarn", "node", "npm", "git", "docker"} {
		gap := DetectCapabilityGap(CapabilityGapContext{MissingTools: []string{tool}})
		if gap == nil {
			t.Fatalf("%s: a known-missing tool must produce a gap", tool)
		}
		if gap.Fix == nil {
			continue // legitimately unfixable here — Constraint is checked below
		}
		endpointTool := installToolFromEndpoint(gap.Fix.Path)
		if !installableViaAgent(endpointTool) {
			t.Errorf("%s: Fix names POST %s but installableViaAgent(%q) is false — the 404 lie",
				tool, gap.Fix.Path, endpointTool)
		}
	}
}

// Exactly one of Fix / Constraint. A gap with neither is a dead end with a
// sentence, which is the defect the type exists to make impossible.
func TestCapabilityGapAlwaysCarriesAFixOrANamedConstraint(t *testing.T) {
	for _, tool := range []string{"flutter", "bun", "wda", "some-tool-yaver-never-heard-of"} {
		gap := DetectCapabilityGap(CapabilityGapContext{MissingTools: []string{tool}})
		if gap == nil {
			t.Fatalf("%s: must still be named", tool)
		}
		if gap.Fix == nil && strings.TrimSpace(gap.Constraint) == "" {
			t.Errorf("%s: no fix AND no constraint — a dead end with a sentence", tool)
		}
		if gap.Fix != nil && strings.TrimSpace(gap.Constraint) != "" {
			t.Errorf("%s: both a fix and a constraint — clients cannot branch", tool)
		}
		if strings.TrimSpace(gap.Summary) == "" {
			t.Errorf("%s: empty summary — layer C has nothing to render", tool)
		}
	}
}

// `yaver install wda` is advertised elsewhere in the tree and resolves in
// neither install table (audit C9). This producer must NAME that constraint
// instead of rendering a button that 404s.
func TestCapabilityGapNamesTheConstraintForAnUninstallableTool(t *testing.T) {
	gap := DetectCapabilityGap(CapabilityGapContext{MissingTools: []string{"wda"}})
	if gap == nil {
		t.Fatal("wda must still be named")
	}
	if gap.Fix != nil {
		t.Fatalf("wda has no recipe in either table — a Fix here would 404: %+v", gap.Fix)
	}
	if !strings.Contains(gap.Constraint, "wda") {
		t.Errorf("constraint must name the specific tool, got %q", gap.Constraint)
	}
	if !strings.Contains(gap.Constraint, "/install/list") {
		t.Errorf("constraint must route the user somewhere real, got %q", gap.Constraint)
	}
}

// The detector must not claim a toolchain gap for failures that are not one —
// sending a user to install something they already have is its own lie.
func TestCapabilityGapIsSilentOnNonToolchainFailures(t *testing.T) {
	for _, errText := range []string{
		"",
		"Error detected in pubspec.yaml:\nNo file or variants found for asset: .env.\nFailed to compile application.",
		"SocketException: Failed to create server socket (OS Error: Address already in use, errno = 48)",
		"Error: Cannot find module 'expo-router'",
	} {
		if gap := DetectCapabilityGap(CapabilityGapContext{Framework: "flutter", Err: errText}); gap != nil {
			t.Errorf("err %q produced a bogus toolchain gap: %+v", errText, gap)
		}
	}
}

// The name comes out of the text in every shape the spawn layer produces it.
func TestMissingToolFromErrorCoversEveryObservedShape(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{`exec flutter: executable file not found in $PATH`, "flutter"},
		{`exec: "flutter": executable file not found in $PATH`, "flutter"},
		{`failed to start: exec: "bun": executable file not found in $PATH`, "bun"},
		{`sh: 1: flutter: command not found`, "flutter"},
		{`nothing to see here`, ""},
	} {
		if got := missingToolFromError(tc.in); got != tc.want {
			t.Errorf("missingToolFromError(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// A framework whose spawn binary is known must be refusable even when the
// error text never named it — that is what makes the SYNCHRONOUS refusal
// possible for a pubspec-only project.
func TestDevStartToolchainBinaryResolvesFlutter(t *testing.T) {
	if got := devStartToolchainBinary("flutter"); got != "flutter" {
		t.Errorf("devStartToolchainBinary(flutter) = %q", got)
	}
	// Node-family frameworks are covered by the package.json preflight; a row
	// here would double-refuse them.
	for _, fw := range []string{"expo", "react-native", "vite", "nextjs", ""} {
		if got := devStartToolchainBinary(fw); got != "" {
			t.Errorf("devStartToolchainBinary(%q) = %q, want \"\" (Node preflight owns it)", fw, got)
		}
	}
}

// The wire shape is the contract the two capabilityGap.ts twins parse. Pin the
// JSON keys so a Go rename cannot silently blank both clients.
func TestCapabilityGapWireShape(t *testing.T) {
	gap := DetectCapabilityGap(CapabilityGapContext{Framework: "flutter", MissingTools: []string{"flutter"}})
	raw, err := json.Marshal(gap)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"code", "capability", "summary", "detail", "fix"} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("wire key %q missing from %s", key, raw)
		}
	}
	fix, _ := decoded["fix"].(map[string]interface{})
	for _, key := range []string{"label", "method", "path", "stream", "est", "retry"} {
		if _, ok := fix[key]; !ok {
			t.Errorf("wire key fix.%q missing from %s", key, raw)
		}
	}
}
