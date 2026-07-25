package main

// android_toolchain_visibility_test.go — the Android SDK the machine HAS must be
// visible to the agent.
//
// Measured on a real Mac mini (2026-07-25) by asking the agent's own exec
// endpoint to resolve each tool:
//
//   flutter    /opt/homebrew/bin/flutter
//   adb        /opt/homebrew/bin/adb
//   emulator   MISSING          ← ~/Library/Android/sdk/emulator/emulator exists
//   avdmanager MISSING          ← ~/Library/Android/sdk/cmdline-tools/…/bin exists
//
// The agent already knew how to FIND an SDK (androidSDKCandidateRoots powers the
// installer) but never put its tool dirs on the PATH it hands subprocesses, and a
// launchd-started daemon inherits neither the user's PATH nor their ANDROID_HOME.
// So the Kotlin/Android lane failed with "no emulator binary" on a machine with a
// perfectly good emulator — and the failure named the wrong cause.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeAndroidSDK builds the minimum layout looksLikeAndroidSDKRoot accepts.
func fakeAndroidSDK(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, dir := range []string{
		filepath.Join("platform-tools"),
		filepath.Join("platforms"),
		filepath.Join("build-tools"),
		filepath.Join("cmdline-tools", "latest", "bin"),
		filepath.Join("emulator"),
	} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "platform-tools", "adb"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write adb: %v", err)
	}
	return root
}

func TestAndroidSDKToolDirsIncludeEmulatorAndCmdlineTools(t *testing.T) {
	root := fakeAndroidSDK(t)
	t.Setenv("ANDROID_SDK_ROOT", root)
	t.Setenv("ANDROID_HOME", "")

	dirs := androidSDKToolDirs()
	if len(dirs) == 0 {
		t.Fatal("no Android tool dirs discovered for an SDK that exists — the agent would report emulator/avdmanager MISSING on a machine that has them")
	}
	want := []string{
		filepath.Join(root, "platform-tools"),
		filepath.Join(root, "emulator"),
		filepath.Join(root, "cmdline-tools", "latest", "bin"),
	}
	for _, w := range want {
		found := false
		for _, d := range dirs {
			if d == w {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("tool dir %q missing from %v", w, dirs)
		}
	}
}

func TestNoAndroidSDKAddsNothing(t *testing.T) {
	empty := t.TempDir() // exists but is not an SDK
	t.Setenv("ANDROID_SDK_ROOT", empty)
	t.Setenv("ANDROID_HOME", empty)

	for _, d := range androidSDKToolDirs() {
		if strings.HasPrefix(d, empty) {
			t.Errorf("a directory that is not an SDK contributed %q — PATH must not fill with phantoms", d)
		}
	}
}

func TestCommonInstallPrefixesCarryTheAndroidTools(t *testing.T) {
	root := fakeAndroidSDK(t)
	t.Setenv("ANDROID_SDK_ROOT", root)

	prefixes := commonInstallPrefixes()
	wantEmulator := filepath.Join(root, "emulator")
	for _, p := range prefixes {
		if p == wantEmulator {
			return
		}
	}
	t.Errorf("commonInstallPrefixes() does not include %q — the daemon's PATH and DiscoverBinary "+
		"both come from this list, so the emulator stays invisible to every subprocess", wantEmulator)
}

func TestAugmentEnvSuppliesAndroidHomeWhenTheDaemonHasNone(t *testing.T) {
	root := fakeAndroidSDK(t)
	t.Setenv("ANDROID_SDK_ROOT", root)
	t.Setenv("ANDROID_HOME", "")

	// A launchd-style minimal environment: no ANDROID_HOME at all.
	env := augmentEnv([]string{"PATH=/usr/bin:/bin"})

	var gotHome, gotRoot string
	for _, kv := range env {
		if strings.HasPrefix(kv, "ANDROID_HOME=") {
			gotHome = strings.TrimPrefix(kv, "ANDROID_HOME=")
		}
		if strings.HasPrefix(kv, "ANDROID_SDK_ROOT=") {
			gotRoot = strings.TrimPrefix(kv, "ANDROID_SDK_ROOT=")
		}
	}
	if gotHome != root || gotRoot != root {
		t.Errorf("augmentEnv did not point Gradle at the SDK (ANDROID_HOME=%q ANDROID_SDK_ROOT=%q, want %q) — "+
			"Gradle finds the SDK through these vars, not PATH, and a launchd daemon inherits neither",
			gotHome, gotRoot, root)
	}
}

func TestAugmentEnvNeverOverridesAnOperatorsAndroidHome(t *testing.T) {
	root := fakeAndroidSDK(t)
	t.Setenv("ANDROID_SDK_ROOT", root)

	env := augmentEnv([]string{"PATH=/usr/bin:/bin", "ANDROID_HOME=/operator/choice"})

	count := 0
	for _, kv := range env {
		if strings.HasPrefix(kv, "ANDROID_HOME=") {
			count++
			if kv != "ANDROID_HOME=/operator/choice" {
				t.Errorf("overrode the operator's ANDROID_HOME with %q", kv)
			}
		}
	}
	if count != 1 {
		t.Errorf("ANDROID_HOME appears %d times — a duplicated env key is resolved differently by different tools", count)
	}
}
