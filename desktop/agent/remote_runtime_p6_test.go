package main

// remote_runtime_p6_test.go — P6 control fidelity + Android surface
// target tests. Pure — no shell-outs, no live simulators.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAndroidKeycode_TVDpadResolves(t *testing.T) {
	cases := map[string]int{
		"up": 19, "down": 20, "left": 21, "right": 22, "select": 23,
		"dpad_up": 19, "dpad_left": 21, "ok": 23,
	}
	for name, want := range cases {
		got, ok := androidKeycodeForName(name)
		if !ok {
			t.Fatalf("androidKeycodeForName(%q) = false", name)
		}
		if got != want {
			t.Fatalf("androidKeycodeForName(%q) = %d, want %d", name, got, want)
		}
	}
}

func TestAndroidKeycode_WearCrownResolves(t *testing.T) {
	if code, ok := androidKeycodeForName("crown_up"); !ok || code != 92 {
		t.Fatalf("crown_up = (%d,%v), want (92,true)", code, ok)
	}
	if code, ok := androidKeycodeForName("crown_down"); !ok || code != 93 {
		t.Fatalf("crown_down = (%d,%v), want (93,true)", code, ok)
	}
}

func TestRuntimeTargetFor_AndroidSurfaceIDs(t *testing.T) {
	cases := map[string]string{
		"android-wear": "wear",
		"android-tv":   "tv",
		"android-xr":   "xr",
		"android-auto": "auto",
	}
	for id, hint := range cases {
		tg, err := runtimeTargetFor(id)
		if err != nil {
			t.Fatalf("runtimeTargetFor(%q) errored: %v", id, err)
		}
		s, ok := tg.(androidSurfaceTarget)
		if !ok {
			t.Fatalf("runtimeTargetFor(%q) = %T, want androidSurfaceTarget", id, tg)
		}
		if s.avdHint != hint {
			t.Fatalf("androidSurfaceTarget(%q).avdHint = %q, want %q", id, s.avdHint, hint)
		}
	}
}

func TestProbeAndroidSurfaceTargets_HaveExpectedSurfaceBadge(t *testing.T) {
	for _, tg := range []RemoteRuntimeTarget{
		probeAndroidWearTarget(),
		probeAndroidTVTarget(),
		probeAndroidXRTarget(),
		probeAndroidAutoTarget(),
	} {
		if tg.Platform != "android" {
			t.Errorf("%s Platform = %q, want android", tg.ID, tg.Platform)
		}
		if tg.Surface == "" {
			t.Errorf("%s missing Surface badge", tg.ID)
		}
		if tg.DisplaySurface == "" {
			t.Errorf("%s missing DisplaySurface", tg.ID)
		}
		if tg.Viewport == nil || tg.Viewport.Width <= 0 || tg.Viewport.Height <= 0 {
			t.Errorf("%s missing usable viewport: %+v", tg.ID, tg.Viewport)
		}
		if len(tg.Checks) == 0 {
			t.Errorf("%s missing probe checks", tg.ID)
		}
	}
}

func TestProbeAndroidEmulatorTargetRequiresBootableAVD(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := filepath.Join(home, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatalf("mkdir bin: %v", err)
	}
	for _, name := range []string{"adb", "emulator"} {
		body := "#!/bin/sh\nexit 0\n"
		if name == "emulator" {
			body = "#!/bin/sh\nif [ \"$1\" = \"-list-avds\" ]; then exit 0; fi\nexit 0\n"
		}
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	t.Setenv("PATH", bin)

	tg := probeAndroidEmulatorTarget()
	if tg.Enabled {
		t.Fatalf("android-emulator enabled without any bootable AVD: %+v", tg)
	}
	if tg.Surface != "phone" || tg.DisplaySurface == "" || tg.Viewport == nil {
		t.Fatalf("android-emulator missing phone presentation metadata: %+v", tg)
	}
	if !strings.Contains(tg.Reason, "No Android AVDs configured") {
		t.Fatalf("android-emulator reason = %q, want missing AVD guidance", tg.Reason)
	}
	if len(tg.Checks) != 3 || tg.Checks[2].OK {
		t.Fatalf("android-emulator checks should name the failed AVD probe: %+v", tg.Checks)
	}
}

func TestWDAButtonName_TVRemoteReturnsActionableError(t *testing.T) {
	// The WDA client's PressButton returns a friendly error for tvOS
	// remote / watchOS crown / visionOS pinch keys — the wire contract
	// is exercised by the reason table so we don't need a live WDA.
	if _, ok := wdaButtonName("up"); ok {
		t.Fatal("wdaButtonName should not resolve tvOS 'up' to a WDA button")
	}
	reason, surface := unsupportedIOSKeyReason("up")
	if reason == "" || !strings.Contains(surface, "tvOS") {
		t.Fatalf("unsupportedIOSKeyReason(up) = (%q,%q), want tvOS remote guidance", reason, surface)
	}
	if _, s := unsupportedIOSKeyReason("crown_up"); !strings.Contains(s, "watchOS") {
		t.Fatalf("crown_up should be flagged as watchOS surface, got %q", s)
	}
	if _, s := unsupportedIOSKeyReason("pinch"); !strings.Contains(s, "visionOS") {
		t.Fatalf("pinch should be flagged as visionOS surface, got %q", s)
	}
}
