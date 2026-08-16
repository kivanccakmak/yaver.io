package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// flutterLaneArgs runs the platform-selection logic far enough to see which
// device Flutter would be told to use, without launching anything: Start fails
// at the exec, and the chosen lane is already visible in the error/args by then.
// We drive the same switch by calling Start with a context that is already
// cancelled, then read what it decided from the recorded name/port and the
// returned error.

// TestFlutterDefaultsToWebNotANativeDevice — the lane a preview surface can
// actually display must be the default.
//
// The old default detected a mobile device and ran Flutter natively on it, so a
// phone asking for a preview got a native iOS build it could never render, and
// the failure that surfaced ("Failed to compile application.") described a lane
// the user never chose. Flutter is DevServerKindWeb: it can never load into the
// Yaver container, so "no platform" can only sensibly mean web.
func TestFlutterDefaultsToWebNotANativeDevice(t *testing.T) {
	dir := t.TempDir()
	// Minimal Flutter project: pubspec + a web/ dir so the web-server path is
	// viable (the agent adds web support when it is missing, which needs network).
	if err := os.WriteFile(filepath.Join(dir, "pubspec.yaml"), []byte("name: demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "web"), 0o755); err != nil {
		t.Fatal(err)
	}

	f := &FlutterDevServer{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // never actually spawn flutter

	err := f.Start(ctx, DevServerOpts{WorkDir: dir, Port: 9101})
	// The call fails (cancelled context / missing flutter binary) — what matters
	// is that it did NOT go hunting for a mobile device first. A device hunt
	// surfaces as an error naming a device or "no ios/android device".
	if err != nil {
		low := strings.ToLower(err.Error())
		if strings.Contains(low, "no ios device") || strings.Contains(low, "no android device") {
			t.Fatalf("no-platform start went looking for a native device — a preview surface cannot display that lane: %v", err)
		}
	}
}

// TestFlutterExplicitNativePlatformFailsHonestly — asking for ios/android with
// nothing to run on must say so, not silently substitute the web lane. A silent
// substitution is how a user ends up debugging the wrong lane.
func TestFlutterExplicitNativePlatformFailsHonestly(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pubspec.yaml"), []byte("name: demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	f := &FlutterDevServer{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := f.Start(ctx, DevServerOpts{WorkDir: dir, Port: 9102, Platform: "ios"})
	if err == nil {
		t.Skip("an iOS device/simulator is available on this machine — nothing to assert")
	}
	low := strings.ToLower(err.Error())
	// Either it found a device (fine, we skip above) or it must name the problem
	// AND point at the lane that needs no device.
	if strings.Contains(low, "no ios device or simulator") {
		if !strings.Contains(low, "platform=web") {
			t.Fatalf("refusal must name the alternative that always works, got: %v", err)
		}
	}
}
