package main

import (
	"os"
	"strings"
	"testing"
)

// A box with a real SDK must never be told the tool is missing.
//
// The Mac mini carried platform-tools/adb, an emulator, a Pixel_4_API_32 AVD and
// an android-32 image — and 18 call sites reported "adb not installed" because
// ANDROID_HOME was unset and platform-tools was not on PATH. A false "missing"
// is worse than a false "present": it sends the user to install what they have.
func TestResolveAndroidToolFindsSDKWithoutPATH(t *testing.T) {
	root := t.TempDir()
	tools := root + "/platform-tools"
	if err := os.MkdirAll(tools, 0o755); err != nil {
		t.Fatal(err)
	}
	adb := tools + "/adb"
	if err := os.WriteFile(adb, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Empty PATH: the ONLY way to find it is the SDK layout.
	t.Setenv("PATH", "")
	t.Setenv("ANDROID_SDK_ROOT", root)

	got, err := resolveAndroidTool("adb")
	if err != nil {
		t.Fatalf("adb present in SDK root but resolve failed: %v", err)
	}
	if got != adb {
		t.Fatalf("resolved %q, want %q", got, adb)
	}
}

// When it genuinely is missing, the error must name WHERE we looked — "not in
// PATH" is what sent people off to reinstall an SDK they already had.
func TestResolveAndroidToolErrorNamesSearchedRoots(t *testing.T) {
	// HOME is redirected too: this machine has a REAL ~/Library/Android/sdk, and
	// the resolver correctly finds it — which made the first version of this test
	// fail for the right reason. Isolate every candidate root before asserting
	// absence.
	tmp := t.TempDir()
	t.Setenv("PATH", "")
	t.Setenv("HOME", tmp)
	t.Setenv("ANDROID_SDK_ROOT", tmp)
	t.Setenv("ANDROID_HOME", tmp)
	if _, err := os.Stat("/opt/android-sdk/platform-tools/adb"); err == nil {
		t.Skip("this host has a system-wide /opt/android-sdk; absence cannot be simulated")
	}
	_, err := resolveAndroidTool("adb")
	if err == nil {
		t.Fatal("expected an error for a genuinely absent tool")
	}
	if !strings.Contains(err.Error(), "ANDROID_HOME") {
		t.Fatalf("error must point at the real fix, got: %v", err)
	}
}
