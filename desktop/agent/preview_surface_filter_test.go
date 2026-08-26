package main

import (
	"strings"
	"testing"
)

// preview_surface_filter_test.go — an option the PROJECT supports may still be
// impossible on the SURFACE asking.
//
// The capability layer models framework, not client. For an Expo project it
// returns compile-hermes and open-native, which are correct on a phone and
// impossible on visionOS: that app is SwiftUI and has no React Native
// container to load bytecode into. Offering it a button that cannot work is
// the class the whole capability layer exists to remove, on an axis it did not
// cover.

func expoCaps() ProjectPreviewCapabilities {
	return ProjectPreviewCapabilities{
		Framework: "expo",
		Options: []ProjectPreviewOption{
			{ID: PreviewOptionHermes, Label: "Open in Yaver", Supported: true, Primary: true},
			{ID: PreviewOptionOpenNative, Label: "Open Native", Supported: true},
			{ID: PreviewOptionDevServer, Label: "Browser Reload", Supported: true},
			{ID: PreviewOptionRemoteRuntime, Label: "Stream over WebRTC", Supported: true},
			{ID: PreviewOptionWirePush, Label: "Install over cable", Supported: true},
		},
	}
}

func optionIDs(caps ProjectPreviewCapabilities) map[string]bool {
	out := map[string]bool{}
	for _, o := range caps.Options {
		out[o.ID] = true
	}
	return out
}

// visionOS must not be offered Hermes or a USB cable, and must KEEP the two
// things it can genuinely do.
func TestSurfaceFilter_VisionDropsHermesAndWire(t *testing.T) {
	got := optionIDs(FilterPreviewCapabilitiesForSurface(expoCaps(), PreviewSurfaceVision))

	for _, id := range []string{PreviewOptionHermes, PreviewOptionOpenNative, PreviewOptionWirePush} {
		if got[id] {
			t.Errorf("visionOS was offered %q — a SwiftUI app has no React Native container, and no headset has a USB install path", id)
		}
	}
	// The other half matters as much: a filter that strips too much turns a
	// working surface into an empty sheet.
	for _, id := range []string{PreviewOptionDevServer, PreviewOptionRemoteRuntime} {
		if !got[id] {
			t.Errorf("visionOS LOST %q, which it can actually do (WKWebView / streamed pixels)", id)
		}
	}
}

// The RN surfaces keep everything — the filter must not "tidy" the surface the
// capability layer was written for.
func TestSurfaceFilter_MobileKeepsEverything(t *testing.T) {
	before := len(expoCaps().Options)
	after := len(FilterPreviewCapabilitiesForSurface(expoCaps(), PreviewSurfaceMobile).Options)
	if after != before {
		t.Fatalf("mobile lost options: %d → %d", before, after)
	}
}

func TestSurfaceFilter_TVForcesWebRTC(t *testing.T) {
	got := optionIDs(FilterPreviewCapabilitiesForSurface(expoCaps(), PreviewSurfaceTV))
	if !got[PreviewOptionRemoteRuntime] {
		t.Fatal("tvOS lost its authenticated WebRTC remote-runtime lane")
	}
	for _, id := range []string{PreviewOptionDevServer, PreviewOptionHermes, PreviewOptionOpenNative, PreviewOptionWirePush} {
		if got[id] {
			t.Errorf("tvOS was offered forbidden non-WebRTC lane %q", id)
		}
	}
}

// An UNKNOWN surface must lose nothing. A new client getting a shorter list
// looks like a product with less in it, rather than a table with a missing row.
func TestSurfaceFilter_UnknownSurfaceFiltersNothing(t *testing.T) {
	if ParsePreviewSurface("holodeck") != "" {
		t.Fatal("an unrecognised surface name was mapped to a real surface")
	}
	before := len(expoCaps().Options)
	after := len(FilterPreviewCapabilitiesForSurface(expoCaps(), ParsePreviewSurface("holodeck")).Options)
	if after != before {
		t.Fatalf("an unknown surface silently lost options: %d → %d", before, after)
	}
}

// A surface that can host NOTHING must say why, not return an empty list. An
// empty options array renders as a blank sheet, which reads as a broken screen
// instead of an honest answer.
func TestSurfaceFilter_NothingHostableStillExplains(t *testing.T) {
	hermesOnly := ProjectPreviewCapabilities{
		Framework: "expo",
		Options: []ProjectPreviewOption{
			{ID: PreviewOptionHermes, Label: "Open in Yaver", Supported: true},
		},
	}
	got := FilterPreviewCapabilitiesForSurface(hermesOnly, PreviewSurfaceVision)
	if len(got.Options) != 0 {
		t.Fatalf("expected every option removed, got %d", len(got.Options))
	}
	if !strings.Contains(strings.ToLower(got.Reason), "react native") {
		t.Fatalf("an empty option list carried no explanation: %q", got.Reason)
	}
}

// The filter may only REMOVE. Enabling something the project layer marked
// unsupported would let a surface invent a capability the project lacks.
func TestSurfaceFilter_NeverAddsOrEnables(t *testing.T) {
	in := ProjectPreviewCapabilities{
		Framework: "expo",
		Options: []ProjectPreviewOption{
			{ID: PreviewOptionRemoteRuntime, Label: "Stream", Supported: false, Reason: "no browser on the box"},
			{ID: PreviewOptionDevServer, Label: "Browser Reload", Supported: true},
		},
	}
	got := FilterPreviewCapabilitiesForSurface(in, PreviewSurfaceVision)
	if len(got.Options) != 2 {
		t.Fatalf("filter changed the option count for a surface with nothing to drop: %d", len(got.Options))
	}
	for _, o := range got.Options {
		if o.ID == PreviewOptionRemoteRuntime && o.Supported {
			t.Fatal("the surface filter ENABLED an option the project layer marked unsupported")
		}
	}
}

func TestParsePreviewSurface_Aliases(t *testing.T) {
	cases := map[string]PreviewSurface{
		"visionOS": PreviewSurfaceVision,
		"xrOS":     PreviewSurfaceVision,
		"glass":    PreviewSurfaceVision,
		"tvos":     PreviewSurfaceTV,
		"wearos":   PreviewSurfaceWatch,
		"iPad":     PreviewSurfaceTablet,
		"":         "",
	}
	for in, want := range cases {
		if got := ParsePreviewSurface(in); got != want {
			t.Errorf("ParsePreviewSurface(%q) = %q, want %q", in, got, want)
		}
	}
}
