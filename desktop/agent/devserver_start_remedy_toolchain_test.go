package main

import (
	"strings"
	"testing"
)

// A missing toolchain must NAME the installer that exists on this machine.
// The old text said "Install it on this machine" while `yaver install flutter`
// had existed and been arch-aware the whole time — the product withheld its own
// capability from the only surface the user was looking at.
func TestMissingToolchainNamesRealInstaller(t *testing.T) {
	got := devStartRemedy("flutter", "/srv/app", `exec: "flutter": executable file not found in $PATH`)
	if got == "" {
		t.Fatal("no remedy for a missing flutter toolchain")
	}
	if !strings.Contains(got, "yaver install flutter") {
		t.Fatalf("remedy does not name the installer that exists: %q", got)
	}
	// It must not name an installer that does NOT resolve.
	unknown := missingToolchainRemedy("cobol-fried")
	if strings.Contains(unknown, "yaver install") {
		t.Fatalf("named an installer for a framework with no plan: %q", unknown)
	}
	// Guard the claim in the comment: flutter really is in a plan table.
	if _, ok := metaInstallPlan("flutter"); !ok {
		t.Fatal("metaInstallPlan lost 'flutter' — the remedy would now name a failing command")
	}
}
