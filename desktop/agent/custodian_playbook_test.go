package main

import (
	"strings"
	"testing"
)

// TestPlaybookRecognisesRealFailureText feeds VERBATIM output from the tools
// this stack actually uses. A table matched against paraphrased errors is a
// table that will miss in production.
func TestPlaybookRecognisesRealFailureText(t *testing.T) {
	cases := []struct{ name, text, wantID string }{
		{"metro port", "error: listen EADDRINUSE: address already in use :::8081", "port-busy-orphan"},
		{"npm peer deps", "npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree", "npm-eresolve-peer-deps"},
		{"missing module", "Error: Cannot find module 'expo-router/entry'", "npm-cannot-find-module"},
		{"metro resolve", "Unable to resolve module ./App from /Users/x/index.js", "metro-unable-to-resolve-module"},
		{"watcher limit", "Error: EMFILE: too many open files, watch", "metro-emfile-watch-limit"},
		{"flutter lock", "Waiting for another flutter command to release the startup lock...", "flutter-startup-lock"},
		{"cocoapods", "[!] CocoaPods could not find compatible versions for pod \"Firebase/Core\"", "cocoapods-incompatible-versions"},
		{"sim booted", "Unable to boot device in current state: Booted", "simctl-already-booted"},
		{"sim renamed", "Invalid device: 323C65E7-0000-0000-0000-000000000000", "simctl-invalid-device"},
		{"adb offline", "error: device offline", "adb-device-offline-or-unauthorized"},
		{"apk signature", "adb: failed to install app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]", "adb-install-signature-mismatch"},
		{"no kvm", "emulator: ERROR: x86 emulation currently requires hardware acceleration!", "emulator-no-hardware-accel"},
		{"redroid", "redroid container exited: binder: not found", "redroid-missing-kernel-modules"},
		{"keychain", "CodeSign failed with errSecInternalComponent", "keychain-cannot-sign"},
		{"hermes", "Bundle format is unsupported: bytecode version 96 expected 94", "hermes-bytecode-version-mismatch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, ok := MatchPlaybook(tc.text)
			if !ok {
				t.Fatalf("playbook did not recognise real output:\n%s", tc.text)
			}
			if e.ID != tc.wantID {
				t.Fatalf("matched %q, want %q — check row ORDER, first match wins", e.ID, tc.wantID)
			}
		})
	}
}

// TestPlaybookAutoApplyIsOnlySafeRemedies — the rule that keeps a self-healer
// from becoming the outage. Anything that destroys data, touches an account, or
// needs root must NOT fire unattended.
func TestPlaybookAutoApplyIsOnlySafeRemedies(t *testing.T) {
	mustAsk := map[string]bool{
		"adb-install-signature-mismatch": true, // uninstall deletes app data
		"emulator-insufficient-storage":  true, // clearing data is data loss
		"redroid-missing-kernel-modules": true, // needs root on the host
		"npm-eacces-permissions":         true, // the wrong fix here is sudo
		"convex-privacy-violation":       true, // never auto-widen an allowlist
		"gradle-build-failed":            true, // too varied — belongs to the runner
		"rn-sdk-version-drift":           true, // needs a native rebuild, not a bundle swap
	}
	for _, e := range playbook {
		if mustAsk[e.ID] && e.AutoApply {
			t.Errorf("%s is marked AutoApply — this remedy is destructive or ambiguous and must ask first", e.ID)
		}
	}
}

// TestPlaybookRowsAreSelfExplaining — every row must carry the WHY and a next
// step, because a remedy without its reason is a magic incantation the next
// person cannot evaluate.
func TestPlaybookRowsAreSelfExplaining(t *testing.T) {
	seen := map[string]bool{}
	for _, e := range playbook {
		if e.ID == "" || seen[e.ID] {
			t.Errorf("row IDs must be unique and non-empty (%q)", e.ID)
		}
		seen[e.ID] = true
		if e.Match == nil {
			t.Errorf("%s has no match pattern", e.ID)
		}
		if len(e.Because) < 40 {
			t.Errorf("%s: Because must explain what we learned, got %q", e.ID, e.Because)
		}
		if !e.AutoApply && e.Verb == "" && e.Remedy == "" && e.ID != "gradle-build-failed" {
			t.Errorf("%s: a non-automatic row must name a remedy or a verb — 'check your configuration' is the failure mode this rule exists to prevent", e.ID)
		}
		if strings.Contains(strings.ToLower(e.Remedy), "check your config") {
			t.Errorf("%s: vague remedy text", e.ID)
		}
	}
}

// TestPlaybookFindingRoutesUnknownFailuresToTheRunner — the lane split itself.
func TestPlaybookFindingRoutesUnknownFailuresToTheRunner(t *testing.T) {
	f, matched := PlaybookFinding("dev-start", "todo-rn", "panic: something nobody has ever seen before")
	if matched {
		t.Fatalf("did not expect a table hit")
	}
	if f.Outcome != OutcomeNeedsRunner {
		t.Fatalf("an unrecognised failure must escalate, got %s", f.Outcome)
	}
	if len(f.Evidence) == 0 {
		t.Fatalf("escalation must carry the evidence — a runner asked to diagnose without output just guesses")
	}

	f2, matched2 := PlaybookFinding("dev-start", "todo-rn", "listen EADDRINUSE: address already in use :::8081")
	if !matched2 || f2.Outcome != OutcomeFixed {
		t.Fatalf("a known failure must be handled without a model, got matched=%v outcome=%s", matched2, f2.Outcome)
	}
	if !strings.Contains(f2.Problem, "previous agent") {
		t.Fatalf("finding should carry the WHY from the table, got %q", f2.Problem)
	}
}

// TestPlaybookCatalogDropsPatterns — the catalog is served to clients; a
// *regexp.Regexp cannot be marshalled and the pattern is an implementation
// detail.
func TestPlaybookCatalogDropsPatterns(t *testing.T) {
	cat := PlaybookCatalog()
	if len(cat) != len(playbook) {
		t.Fatalf("catalog lost rows: %d vs %d", len(cat), len(playbook))
	}
	for _, e := range cat {
		if e.Match != nil {
			t.Fatalf("%s still carries its pattern", e.ID)
		}
	}
}

// TestPlaybookRecognisesDartSdkIncompatibility — the failure that kept the
// e-mobile Flutter preview blank all day, with a green status beside it.
func TestPlaybookRecognisesDartSdkIncompatibility(t *testing.T) {
	real := "../../.pub-cache/hosted/pub.dev/font_awesome_flutter-10.12.0/lib/src/icon_data.dart:116:34: " +
		"Error: The class 'IconData' can't be extended outside of its library because it's a final class."
	e, ok := MatchPlaybook(real)
	if !ok || e.ID != "dart-package-sdk-incompatible" {
		t.Fatalf("verbatim Dart SDK incompatibility not recognised (got %q, ok=%v)", e.ID, ok)
	}
	if e.AutoApply {
		t.Fatal("upgrading a user's package version is not something to do unattended")
	}
	if !strings.Contains(e.Remedy, "pub upgrade") {
		t.Fatalf("remedy must name the command, got %q", e.Remedy)
	}
}
