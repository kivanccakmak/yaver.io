package main

// remote_runtime_apple_targets_test.go — P0 fan-out. Guarantees:
//   1. ParseInstalledRuntimeFamilies handles a real simctl fixture (iOS +
//      visionOS installed; watchOS/tvOS absent).
//   2. runtimeTargetFor maps every new id to iosSimulatorTarget with the
//      right pickSimulator substring.
//   3. Capabilities enumeration surfaces all five Apple sim targets, badges
//      them with a Surface, and disables the ones whose runtime is missing.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/yaver-io/agent/testkit"
)

func appleSpecialSurfaceProject(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	proj := filepath.Join(dir, "App.xcodeproj")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatalf("mkdir xcodeproj: %v", err)
	}
	body := strings.Join([]string{
		"SDKROOT = watchos;",
		"SDKROOT = appletvos;",
		"SDKROOT = xros;",
	}, "\n")
	if err := os.WriteFile(filepath.Join(proj, "project.pbxproj"), []byte(body), 0o600); err != nil {
		t.Fatalf("write pbxproj: %v", err)
	}
	return dir
}

func appleSiblingSurfaceProject(t *testing.T) (root, mobile string) {
	t.Helper()
	root = t.TempDir()
	mobile = filepath.Join(root, "mobile")
	for _, dir := range []string{mobile, filepath.Join(root, "tvos"), filepath.Join(root, "visionos")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	if err := os.WriteFile(filepath.Join(mobile, "package.json"), []byte(`{"scripts":{"ios":"expo run:ios"}}`), 0o600); err != nil {
		t.Fatalf("write package.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "tvos", "project.yml"), []byte("targets:\n  YaverTV:\n    platform: tvOS\n"), 0o600); err != nil {
		t.Fatalf("write tvos project.yml: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "visionos", "project.yml"), []byte("targets:\n  YaverVision:\n    platform: visionOS\n"), 0o600); err != nil {
		t.Fatalf("write visionos project.yml: %v", err)
	}
	return root, mobile
}

func TestParseInstalledRuntimeFamilies_SimctlFixture(t *testing.T) {
	// Captured from `xcrun simctl list runtimes` on a mac that has iOS 26.4
	// + visionOS 2.1 installed but no watchOS/tvOS runtimes. The visionOS
	// runtime is marked as `xrOS` on older Xcodes and as `visionOS` on
	// newer ones — the parser accepts both.
	fixture := `== Runtimes ==
iOS 26.4 (26.4 - 24E246) - com.apple.CoreSimulator.SimRuntime.iOS-26-4
iOS 17.0 (17.0 - 21A342) - com.apple.CoreSimulator.SimRuntime.iOS-17-0 (unavailable, runtime path is missing)
watchOS 11.0 (11.0 - 22R379) - com.apple.CoreSimulator.SimRuntime.watchOS-11-0 (unavailable, runtime path is missing)
tvOS 18.0 (18.0 - 22J377) - com.apple.CoreSimulator.SimRuntime.tvOS-18-0 (unavailable, runtime path is missing)
visionOS 2.1 (2.1 - 22N320) - com.apple.CoreSimulator.SimRuntime.xrOS-2-1
`
	got := testkit.ParseInstalledRuntimeFamilies(fixture)
	if !got["iOS"] {
		t.Fatalf("iOS should be installed: %v", got)
	}
	if !got["visionOS"] {
		t.Fatalf("visionOS should be installed: %v", got)
	}
	if got["watchOS"] {
		t.Fatalf("watchOS is (unavailable) — should not be reported installed: %v", got)
	}
	if got["tvOS"] {
		t.Fatalf("tvOS is (unavailable) — should not be reported installed: %v", got)
	}
}

func TestParseInstalledRuntimeFamilies_XrOSAliasStillCountsAsVisionOS(t *testing.T) {
	// Older Xcodes labelled the runtime `xrOS` rather than `visionOS`. The
	// parser must map both to the visionOS family.
	fixture := "xrOS 1.0 (1.0 - 21N301) - com.apple.CoreSimulator.SimRuntime.xrOS-1-0\n"
	if !testkit.ParseInstalledRuntimeFamilies(fixture)["visionOS"] {
		t.Fatal("xrOS runtime should register as visionOS family")
	}
}

func TestRuntimeTargetFor_AllAppleSimIDs(t *testing.T) {
	cases := map[string]string{
		"ios-simulator":      "iPhone",
		"ipados-simulator":   "iPad",
		"watchos-simulator":  "Apple Watch",
		"tvos-simulator":     "Apple TV",
		"visionos-simulator": "Apple Vision",
	}
	for id, wantType := range cases {
		tg, err := runtimeTargetFor(id)
		if err != nil {
			t.Fatalf("runtimeTargetFor(%q) errored: %v", id, err)
		}
		iosTg, ok := tg.(iosSimulatorTarget)
		if !ok {
			t.Fatalf("runtimeTargetFor(%q) = %T, want iosSimulatorTarget", id, tg)
		}
		if iosTg.deviceType != wantType {
			t.Fatalf("runtimeTargetFor(%q).deviceType = %q, want %q", id, iosTg.deviceType, wantType)
		}
	}
	if _, err := runtimeTargetFor("watchos-simulator-blah"); err == nil {
		t.Fatal("unknown target id must still error")
	}
}

func TestCapabilitiesEnumeratesAllAppleSurfacesAndBadgesSurface(t *testing.T) {
	// Force the runtime-families probe to a known set so this test works
	// on any host (linux CI or a Mac missing some runtimes). Only iOS +
	// visionOS installed here; watchOS + tvOS absent.
	cleanup := setAppleRuntimeFamiliesForTest(map[string]bool{
		"iOS": true, "visionOS": true,
	})
	defer cleanup()
	cleanupDevices := setAppleSimulatorDevicesForTest(map[string]bool{
		"iPhone": true, "iPad": true, "Apple Vision": true,
	})
	defer cleanupDevices()

	caps := remoteRuntimeCapabilitiesForProject(appleSpecialSurfaceProject(t), "swift")
	if !caps.RemoteRuntimeEligible {
		t.Fatal("swift caps should be remote-runtime eligible")
	}
	wantSurface := map[string]string{
		"ios-simulator":      "phone",
		"ipados-simulator":   "tablet",
		"watchos-simulator":  "watch",
		"tvos-simulator":     "tv",
		"visionos-simulator": "vision",
	}
	seen := map[string]RemoteRuntimeTarget{}
	for _, tg := range caps.Targets {
		if _, want := wantSurface[tg.ID]; want {
			seen[tg.ID] = tg
			if tg.Surface != wantSurface[tg.ID] {
				t.Fatalf("target %q surface = %q, want %q", tg.ID, tg.Surface, wantSurface[tg.ID])
			}
		}
	}
	if len(seen) != len(wantSurface) {
		t.Fatalf("expected all five Apple sim targets, got %d (%v)", len(seen), seen)
	}
	// The runtime-gate assertions only mean anything on a Mac — on Linux
	// every Apple target is disabled by the host gate first, so the
	// runtime message never gets a chance to fire.
	if runtime.GOOS == "darwin" {
		if !seen["ios-simulator"].Enabled {
			t.Fatalf("iOS runtime installed but target disabled: %+v", seen["ios-simulator"])
		}
		if !seen["visionos-simulator"].Enabled {
			t.Fatalf("visionOS runtime installed but target disabled: %+v", seen["visionos-simulator"])
		}
		if seen["watchos-simulator"].Enabled {
			t.Fatalf("watchOS runtime missing but target enabled: %+v", seen["watchos-simulator"])
		}
		if !strings.Contains(seen["watchos-simulator"].Reason, "watchOS runtime not installed") {
			t.Fatalf("watchos-simulator reason should point at the missing runtime, got %q", seen["watchos-simulator"].Reason)
		}
		if !strings.Contains(seen["tvos-simulator"].Reason, "tvOS runtime not installed") {
			t.Fatalf("tvos-simulator reason should point at the missing runtime, got %q", seen["tvos-simulator"].Reason)
		}
	}
}

func TestCapabilitiesFromMobileDirIncludeSiblingAppleSurfaceProjects(t *testing.T) {
	// Yaver's dogfood app is scoped to mobile/, while the TV and Vision app
	// packages live beside it as tvos/ and visionos/. A capability probe from
	// mobile/ must not silently omit those streamable simulator lanes.
	cleanup := setAppleRuntimeFamiliesForTest(map[string]bool{
		"iOS": true, "tvOS": true, "visionOS": true,
	})
	defer cleanup()
	cleanupDevices := setAppleSimulatorDevicesForTest(map[string]bool{
		"iPhone": true, "iPad": true, "Apple TV": true, "Apple Vision": true,
	})
	defer cleanupDevices()
	_, mobile := appleSiblingSurfaceProject(t)

	surfaces := runtimeProjectSurfaces(mobile, "react-native")
	if !surfaces[SurfaceTVOS] {
		t.Fatalf("mobile-scoped surface detection missed sibling tvos/project.yml: %v", surfaces)
	}
	if !surfaces[SurfaceVisionOS] {
		t.Fatalf("mobile-scoped surface detection missed sibling visionos/project.yml: %v", surfaces)
	}

	caps := remoteRuntimeCapabilitiesForProject(mobile, "react-native")
	got := map[string]RemoteRuntimeTarget{}
	for _, tg := range caps.Targets {
		got[tg.ID] = tg
	}
	for id, wantSurface := range map[string]string{
		"tvos-simulator":     "tv",
		"visionos-simulator": "vision",
	} {
		tg, ok := got[id]
		if !ok {
			t.Fatalf("capabilities missing %s from mobile-scoped sibling project layout; got %+v", id, caps.Targets)
		}
		if tg.Surface != wantSurface {
			t.Fatalf("%s Surface=%q, want %q", id, tg.Surface, wantSurface)
		}
	}
}

// TestHandleRemoteRuntimeCapabilitiesReturnsAppleFanOut is the P0
// closed-loop check: fire the real HTTP handler with a stubbed
// families map and assert the JSON body carries every Apple sim id
// with the right Surface badge. Mirrors the audit's "GET
// /remote-runtime/capabilities?framework=swift lists ios/ipados/
// watchos/tvos/visionos targets" acceptance criterion.
func TestHandleRemoteRuntimeCapabilitiesReturnsAppleFanOut(t *testing.T) {
	resetRemoteRuntimeCapabilitiesCacheForTest()
	defer resetRemoteRuntimeCapabilitiesCacheForTest()
	cleanup := setAppleRuntimeFamiliesForTest(map[string]bool{
		"iOS": true, "watchOS": true, "tvOS": true, "visionOS": true,
	})
	defer cleanup()
	cleanupDevices := setAppleSimulatorDevicesForTest(map[string]bool{
		"iPhone": true, "iPad": true, "Apple Watch": true, "Apple TV": true, "Apple Vision": true,
	})
	defer cleanupDevices()

	srv := &HTTPServer{}
	workDir := appleSpecialSurfaceProject(t)
	req := httptest.NewRequest(http.MethodGet,
		"/remote-runtime/capabilities?workDir="+workDir+"&framework=swift&refresh=1", nil)
	rec := httptest.NewRecorder()
	srv.handleRemoteRuntimeCapabilities(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body RemoteRuntimeCapabilities
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v raw=%s", err, rec.Body.String())
	}
	wantSurface := map[string]string{
		"ios-simulator":      "phone",
		"ipados-simulator":   "tablet",
		"watchos-simulator":  "watch",
		"tvos-simulator":     "tv",
		"visionos-simulator": "vision",
	}
	got := map[string]RemoteRuntimeTarget{}
	for _, tg := range body.Targets {
		got[tg.ID] = tg
	}
	for id, wantSurf := range wantSurface {
		tg, ok := got[id]
		if !ok {
			t.Fatalf("capabilities missing target %q", id)
		}
		if tg.Surface != wantSurf {
			t.Fatalf("target %q Surface=%q, want %q", id, tg.Surface, wantSurf)
		}
	}
}

func TestHandleRemoteRuntimeCapabilitiesCachesProbeResult(t *testing.T) {
	resetRemoteRuntimeCapabilitiesCacheForTest()
	defer resetRemoteRuntimeCapabilitiesCacheForTest()
	cleanup := setAppleRuntimeFamiliesForTest(map[string]bool{
		"iOS": true,
	})
	defer cleanup()
	cleanupDevices := setAppleSimulatorDevicesForTest(map[string]bool{
		"iPhone": true,
	})
	defer cleanupDevices()

	srv := &HTTPServer{}
	firstReq := httptest.NewRequest(http.MethodGet,
		"/remote-runtime/capabilities?workDir=/tmp/yaver-cache-swift&framework=swift", nil)
	firstRec := httptest.NewRecorder()
	srv.handleRemoteRuntimeCapabilities(firstRec, firstReq)
	if firstRec.Code != http.StatusOK {
		t.Fatalf("first status = %d body=%s", firstRec.Code, firstRec.Body.String())
	}
	var first RemoteRuntimeCapabilities
	if err := json.Unmarshal(firstRec.Body.Bytes(), &first); err != nil {
		t.Fatalf("decode first: %v", err)
	}
	if first.Cached {
		t.Fatal("first capabilities response should be a real probe, not cached")
	}
	if first.CachedAt == "" {
		t.Fatal("first capabilities response should include cachedAt metadata")
	}

	secondReq := httptest.NewRequest(http.MethodGet,
		"/remote-runtime/capabilities?workDir=/tmp/yaver-cache-swift&framework=swift", nil)
	secondRec := httptest.NewRecorder()
	srv.handleRemoteRuntimeCapabilities(secondRec, secondReq)
	if secondRec.Code != http.StatusOK {
		t.Fatalf("second status = %d body=%s", secondRec.Code, secondRec.Body.String())
	}
	var second RemoteRuntimeCapabilities
	if err := json.Unmarshal(secondRec.Body.Bytes(), &second); err != nil {
		t.Fatalf("decode second: %v", err)
	}
	if !second.Cached {
		t.Fatal("second capabilities response should come from the agent cache")
	}
	if second.CachedAt != first.CachedAt {
		t.Fatalf("cachedAt changed on cache hit: first=%q second=%q", first.CachedAt, second.CachedAt)
	}
}

func TestInstalledRuntimeFamilies_NonDarwinReturnsEmpty(t *testing.T) {
	// Guard rail: InstalledRuntimeFamilies must not shell out on Linux
	// (there is no xcrun to shell to). It returns an empty map + nil
	// error so callers treat every Apple target as disabled-by-host.
	if runtime.GOOS == "darwin" {
		t.Skip("darwin has xcrun — the empty-map path is a linux invariant")
	}
	fams, err := testkit.InstalledRuntimeFamilies(context.Background())
	if err != nil {
		t.Fatalf("InstalledRuntimeFamilies on non-darwin errored: %v", err)
	}
	if len(fams) != 0 {
		t.Fatalf("InstalledRuntimeFamilies on non-darwin returned %v, want empty", fams)
	}
}
