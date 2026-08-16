package main

// wire_surfaces_manifest_test.go — the manifest-aware half of surface
// detection (2026-08-13): the runtime-capabilities probe must be able to
// answer "what can be WebRTC-streamed at all" from the project's OWN config
// files (Info.plist, AndroidManifest.xml), not from the framework string a
// client happened to send. These are the regression guards for the parsers in
// wire_surfaces.go.

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSurfacesFromInfoPlistXML(t *testing.T) {
	// A tvOS app's Info.plist: UIDeviceFamily 3 + DTPlatformName appletvos.
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Yaver TV</string>
	<key>DTPlatformName</key>
	<string>appletvos</string>
	<key>UIDeviceFamily</key>
	<array>
		<integer>3</integer>
	</array>
	<key>WKWatchOnly</key>
	<false/>
</dict>
</plist>`
	got := surfacesFromInfoPlist([]byte(plist))
	if !containsSurface(got, SurfaceTVOS) {
		t.Fatalf("tvOS Info.plist: surfaces = %v, missing SurfaceTVOS", got)
	}
	if containsSurface(got, SurfaceWatchOS) || containsSurface(got, SurfaceIOS) {
		t.Fatalf("tvOS Info.plist should not claim watch/ios surfaces: %v", got)
	}
}

func TestSurfacesFromInfoPlistDeviceFamilyOnly(t *testing.T) {
	// Some projects set only UIDeviceFamily. 4 = Watch, 9 = Vision.
	plist := `<plist version="1.0"><dict>
	<key>UIDeviceFamily</key>
	<array><integer>4</integer><integer>9</integer></array>
</dict></plist>`
	got := surfacesFromInfoPlist([]byte(plist))
	if !containsSurface(got, SurfaceWatchOS) {
		t.Fatalf("UIDeviceFamily 4 should claim SurfaceWatchOS: %v", got)
	}
	if !containsSurface(got, SurfaceVisionOS) {
		t.Fatalf("UIDeviceFamily 9 should claim SurfaceVisionOS: %v", got)
	}
	if len(got) != 2 {
		t.Fatalf("expected exactly watch+vision, got %v", got)
	}
}

func TestSurfacesFromInfoPlistJSON(t *testing.T) {
	plist := `{"CFBundleName":"Yaver","DTPlatformName":"watchos","UIDeviceFamily":[4],"WKWatchOnly":true}`
	got := surfacesFromInfoPlist([]byte(plist))
	if !containsSurface(got, SurfaceWatchOS) {
		t.Fatalf("JSON watchOS plist: surfaces = %v, missing SurfaceWatchOS", got)
	}
}

func TestSurfacesFromInfoPlistGarbageIsEmpty(t *testing.T) {
	for _, junk := range []string{"", "not a plist", "\x00\x01\x02binary"} {
		if got := surfacesFromInfoPlist([]byte(junk)); len(got) != 0 {
			t.Fatalf("garbage %q produced surfaces %v — a false positive would advertise a surface the project does not build", junk, got)
		}
	}
}

func TestAndroidManifestMarkers(t *testing.T) {
	root := t.TempDir()
	// Leanback TV manifest — the marker, not the folder name, is the truth.
	// The scanner is deliberately BOUNDED to conventional dirs (an unbounded
	// walk of a monorepo is the exact wall-clock hazard CLAUDE.md forbids), so
	// "tv/" stands in for a TV module wherever a repo keeps it.
	tvDir := filepath.Join(root, "tv", "src", "main")
	if err := os.MkdirAll(tvDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tvDir, "AndroidManifest.xml"), []byte(`<manifest>
	<uses-feature android:name="android.hardware.type.television" />
</manifest>`), 0o600); err != nil {
		t.Fatal(err)
	}
	// Automotive app in an "android" folder.
	carDir := filepath.Join(root, "android", "app", "src", "main")
	if err := os.MkdirAll(carDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(carDir, "AndroidManifest.xml"), []byte(`<manifest>
	<application android:name="com.google.android.gms.car.application" />
</manifest>`), 0o600); err != nil {
		t.Fatal(err)
	}

	markers := androidManifestMarkers(root)
	if !markers["tv"] {
		t.Fatalf("television manifest marker not detected: %v", markers)
	}
	if !markers["auto"] {
		t.Fatalf("car app manifest marker not detected: %v", markers)
	}
	if markers["xr"] || markers["watch"] {
		t.Fatalf("no xr/watch manifests exist — markers must stay empty: %v", markers)
	}

	// No manifests at all → empty map, never nil-crashing callers.
	empty := androidManifestMarkers(t.TempDir())
	for k := range empty {
		t.Fatalf("empty project produced marker %q: %v", k, empty)
	}
}

func TestDetectProjectSurfacesReadsInfoPlistSiblings(t *testing.T) {
	// A repo whose only Apple surface evidence is a tvOS Info.plist beside a
	// web-first root (no .xcodeproj, no XcodeGen spec). DetectProjectSurfaces
	// must still say TV — this is what makes /remote-runtime/capabilities
	// offer tvos-simulator for such a project.
	root := t.TempDir()
	tvDir := filepath.Join(root, "tvos")
	if err := os.MkdirAll(tvDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tvDir, "Info.plist"), []byte(`<plist version="1.0"><dict>
	<key>DTPlatformName</key><string>appletvos</string>
</dict></plist>`), 0o600); err != nil {
		t.Fatal(err)
	}

	got := DetectProjectSurfaces(root, "browser")
	if !containsSurface(got, SurfaceTVOS) {
		t.Fatalf("sibling tvos/Info.plist not detected: %v", got)
	}
}
