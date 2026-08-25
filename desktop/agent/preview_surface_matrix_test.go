package main

// preview_surface_matrix_test.go — the preview loop is the thing Yaver IS, so
// this pins it across every stack and every surface at once.
//
// Two whole classes of bug motivated this file, both found by auditing
// docs/handoff/yaver-self-development-webrtc-preview.md against the code:
//
//  1. A GUARD THAT ONLY EXISTED IN A UI. workspace_preview_strategy.go called
//     the Yaver-in-Yaver recursion block "a REFUSAL, not a preference", but
//     nothing in production ever called IsYaverSelfDevelopment /
//     ResolveSelfDevelopmentPreview. The sole enforcement was the mobile
//     Projects action sheet, which hides buttons — so the web dashboard, MCP
//     verbs, the CLI, tvOS, a second phone, and the feedback→vibe auto-fix path
//     all still reached /dev/build-native and could trap the user. Hiding a
//     button is not a guard.
//
//  2. A SILENT DOWNGRADE FOR WEARABLES AND CAR. watchOS, Wear OS, CarPlay and
//     Android Auto matched no case and fell through to `default:`, which
//     answers "supported — web dev server". A watchOS app rendered as a web
//     page is not the user's app, and the file explicitly forbids exactly this
//     downgrade for Swift.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ── Yaver-in-Yaver recursion, enforced at the EXECUTION layer ───────────────

func writePreviewProject(t *testing.T, dir string, files map[string]string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

func TestIsYaverSelfDevelopmentDir_DetectsYaverMobileByIdentity(t *testing.T) {
	dir := writePreviewProject(t, filepath.Join(t.TempDir(), "anything"), map[string]string{
		"package.json": `{"name":"yaver-mobile","dependencies":{"expo":"*"}}`,
	})
	if !IsYaverSelfDevelopmentDir(dir) {
		t.Fatalf("yaver-mobile package not detected as self-development")
	}
}

func TestIsYaverSelfDevelopmentDir_DetectsByBundleIdentifier(t *testing.T) {
	dir := writePreviewProject(t, filepath.Join(t.TempDir(), "renamed"), map[string]string{
		"package.json": `{"name":"totally-renamed"}`,
		"app.json":     `{"expo":{"slug":"yaver","ios":{"bundleIdentifier":"io.yaver.mobile"}}}`,
	})
	if !IsYaverSelfDevelopmentDir(dir) {
		t.Fatalf("io.yaver.mobile bundle id not detected as self-development")
	}
}

func TestIsYaverSelfDevelopmentDir_DetectsMonorepoRoot(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"desktop/agent", "mobile", "relay"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}
	if !IsYaverSelfDevelopmentDir(root) {
		t.Fatalf("monorepo root not detected as self-development")
	}
}

// THE REGRESSION THAT MATTERS. The repo ships third-party RN fixtures under
// demo/. Detecting self-development from an ancestor path component would
// refuse Hermes for them — breaking the exact validation loop they exist for.
func TestIsYaverSelfDevelopmentDir_ThirdPartyFixtureInsideTheRepoIsNotSelfDev(t *testing.T) {
	// Mirrors the real layout: <checkout>/yaver.io/demo/mobile/todo-rn
	root := filepath.Join(t.TempDir(), "yaver.io")
	dir := writePreviewProject(t, filepath.Join(root, "demo", "mobile", "todo-rn"), map[string]string{
		"package.json": `{"name":"todo-rn","dependencies":{"expo":"*"}}`,
		"app.json":     `{"expo":{"slug":"todo-rn","ios":{"bundleIdentifier":"io.yaver.todorn"}}}`,
	})
	if IsYaverSelfDevelopmentDir(dir) {
		t.Fatalf("third-party fixture under a yaver.io checkout was misdetected as Yaver itself — "+
			"self-development policy would be applied to a legitimate RN app (%s)", dir)
	}
}

func TestIsYaverSelfDevelopmentDir_EmptyAndUnknownAreNotSelfDev(t *testing.T) {
	if IsYaverSelfDevelopmentDir("") {
		t.Fatalf("empty dir reported as self-development")
	}
	dir := writePreviewProject(t, filepath.Join(t.TempDir(), "acme"), map[string]string{
		"package.json": `{"name":"acme-todo","dependencies":{"react-native":"*"}}`,
	})
	if IsYaverSelfDevelopmentDir(dir) {
		t.Fatalf("unrelated project reported as self-development")
	}
}

// Yaver-on-Yaver Hermes is safe only because the way out lives in native host
// code on BOTH mobile platforms. This source-level parity guard is cheap and
// fails if either side loses the operation that a guest JS bridge cannot
// intercept.
func TestSelfDevelopmentHermesHasNativeEscapeOnBothMobilePlatforms(t *testing.T) {
	root := filepath.Join("..", "..")
	ios, err := os.ReadFile(filepath.Join(root, "mobile", "ios", "Yaver", "AppDelegate.swift"))
	if err != nil {
		t.Fatal(err)
	}
	android, err := os.ReadFile(filepath.Join(root, "mobile", "android", "app", "src", "main", "java", "io", "yaver", "mobile", "YaverShakeDetectorModule.kt"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(ios), "CoreMotion shake detector started") || !strings.Contains(string(ios), "Back to Yaver") {
		t.Fatal("iOS no longer proves a native guest escape")
	}
	if !strings.Contains(string(android), "unloadGuestAndRecreate") || !strings.Contains(string(android), "ACTION_RELOAD") {
		t.Fatal("Android no longer proves a native guest escape")
	}
}

// ── The framework matrix: RN / Flutter / Swift / Kotlin ────────────────────

func TestPreviewMatrixPerFramework(t *testing.T) {
	cases := []struct {
		name        string
		stack       string
		paired      bool
		wantPrimary PreviewStrategy
		wantFeed    FeedbackTransport
		// Hermes is RN/Expo ONLY. Anything else offering it is a bug — the
		// mobile Hot Reload tab gates on this and a wrong plan strands a user
		// waiting for a bundle that can never load.
		hermesAllowed bool
	}{
		{"rn-no-device", "react-native", false, PreviewDirectURL, FeedbackInAppSDK, true},
		{"rn-paired-device", "react-native", true, PreviewHermesBundle, FeedbackDeviceSDK, true},
		{"expo-paired", "expo", true, PreviewHermesBundle, FeedbackDeviceSDK, true},
		{"flutter", "flutter", true, PreviewDirectURL, FeedbackInAppSDK, false},
		{"kotlin", "kotlin", false, PreviewRedroidWebRTC, FeedbackViewerTriggered, false},
		{"android-gradle", "gradle", false, PreviewRedroidWebRTC, FeedbackViewerTriggered, false},
		{"swift-native", "swift", false, PreviewIOSSimulator, FeedbackViewerTriggered, false},
		{"swiftwasm", "swiftwasm", false, PreviewDirectURL, FeedbackInAppSDK, false},
		{"web-next", "next", false, PreviewDirectURL, FeedbackInAppSDK, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan := ResolveWorkspacePreview(tc.stack, tc.paired)
			if plan.Primary != tc.wantPrimary {
				t.Fatalf("primary = %q, want %q", plan.Primary, tc.wantPrimary)
			}
			if plan.Feedback != tc.wantFeed {
				t.Fatalf("feedback = %q, want %q", plan.Feedback, tc.wantFeed)
			}
			if !plan.Supported {
				t.Fatalf("stack reported unsupported: %s", plan.Reason)
			}
			if plan.Reason == "" {
				t.Fatalf("no reason given — an unexplained plan is unactionable")
			}
			if !tc.hermesAllowed {
				if plan.Primary == PreviewHermesBundle {
					t.Fatalf("non-RN stack %q got a Hermes primary", tc.stack)
				}
				for _, f := range plan.Fallbacks {
					if f == PreviewHermesBundle {
						t.Fatalf("non-RN stack %q offers Hermes as a fallback — it can never load", tc.stack)
					}
				}
			}
		})
	}
}

// There is NO native Kotlin or Swift feedback SDK. Claiming an in-app SDK for
// them promises a loop that silently does nothing.
func TestNativeStacksNeverClaimAnInAppFeedbackSDK(t *testing.T) {
	for _, stack := range []string{"kotlin", "android", "gradle", "swift", "ios", "xcode", "watchos", "carplay", "wearos"} {
		plan := ResolveWorkspacePreview(stack, false)
		if plan.Feedback == FeedbackInAppSDK {
			t.Fatalf("stack %q claims an in-app feedback SDK; none exists for native", stack)
		}
	}
}

// ── Wearables + car: develop FOR them honestly ─────────────────────────────

func TestWearableAndCarStacksAreNotSilentlyDowngradedToWeb(t *testing.T) {
	cases := []struct {
		stack       string
		wantPrimary PreviewStrategy
	}{
		{"watchos", PreviewIOSSimulator},
		{"watchkit", PreviewIOSSimulator},
		{"carplay", PreviewIOSSimulator},
		{"wearos", PreviewAndroidEmulator},
		{"wear-os", PreviewAndroidEmulator},
		{"android-wear", PreviewAndroidEmulator},
		{"androidauto", PreviewAndroidEmulator},
		{"android auto", PreviewAndroidEmulator},
	}
	for _, tc := range cases {
		t.Run(tc.stack, func(t *testing.T) {
			plan := ResolveWorkspacePreview(tc.stack, false)
			if plan.Primary == PreviewDirectURL || plan.Primary == PreviewChromeWebRTC {
				t.Fatalf("%q previews as a web page (%q) — that is not the user's app",
					tc.stack, plan.Primary)
			}
			if plan.Primary != tc.wantPrimary {
				t.Fatalf("%q primary = %q, want %q", tc.stack, plan.Primary, tc.wantPrimary)
			}
			if strings.Contains(plan.Reason, "unknown stack") {
				t.Fatalf("%q fell through to the default arm: %q", tc.stack, plan.Reason)
			}
		})
	}
}

// Wear OS is Android, so it must not be answered with an Apple simulator, and
// vice versa. Getting this backwards sends the user to buy the wrong machine.
func TestWearableStacksRouteToTheCorrectPlatformRuntime(t *testing.T) {
	if p := ResolveWorkspacePreview("wearos", false).Primary; p == PreviewIOSSimulator {
		t.Fatalf("Wear OS routed to an Apple simulator")
	}
	if p := ResolveWorkspacePreview("watchos", false).Primary; p == PreviewAndroidEmulator || p == PreviewRedroidWebRTC {
		t.Fatalf("watchOS routed to an Android runtime")
	}
}

// ── Surface viewports: every surface Yaver ships must be expressible ───────

func TestEveryShippedSurfaceResolvesAViewport(t *testing.T) {
	// The surfaces named in CLAUDE.md's cross-surface parity rule.
	cases := []struct {
		surface   string
		wantVoice bool
		// A car must never be handed a visual budget that invites reading.
		maxVisual string
	}{
		{"watch", true, "glance"},
		{"car", true, "none"},
		{"glass", true, "panel"},
		{"vr", true, "panel"},
		{"tvos", false, "panel"},
		{"mobile-phone", false, ""},
		{"tablet", false, ""},
		{"web", false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.surface, func(t *testing.T) {
			vp := runtimeViewportFromSurface(RuntimeTurnSurface{Class: tc.surface})
			if vp == nil {
				t.Fatalf("surface %q produced no viewport", tc.surface)
			}
			if vp.Surface == "" {
				t.Fatalf("surface %q lost its identity", tc.surface)
			}
			if tc.wantVoice && !vp.Voice {
				t.Fatalf("surface %q should be voice-led", tc.surface)
			}
			if tc.maxVisual != "" && vp.VisualBudget != tc.maxVisual {
				t.Fatalf("surface %q visual budget = %q, want %q", tc.surface, vp.VisualBudget, tc.maxVisual)
			}
		})
	}
}

// The car is the one surface where getting this wrong is a safety problem.
func TestCarSurfaceStaysAudioOnlyUnderDrivingPolicy(t *testing.T) {
	for _, alias := range []string{"car", "carplay", "androidauto", "car-audio"} {
		vp := runtimeViewportFromSurface(RuntimeTurnSurface{Class: alias})
		if vp.VisualBudget != "none" {
			t.Fatalf("%q visual budget = %q, want none — a driver must not be given something to read",
				alias, vp.VisualBudget)
		}
		if vp.RiskPolicy != "driving" {
			t.Fatalf("%q risk policy = %q, want driving", alias, vp.RiskPolicy)
		}
	}
}

func TestWatchSurfaceKeepsAGlanceBudgetAndShortSpeech(t *testing.T) {
	vp := runtimeViewportFromSurface(RuntimeTurnSurface{Class: "watch"})
	if vp.VisualBudget != "glance" {
		t.Fatalf("watch visual budget = %q", vp.VisualBudget)
	}
	if vp.TTSBudget == 0 || vp.TTSBudget > 200 {
		t.Fatalf("watch TTS budget = %d — a watch reply must stay short", vp.TTSBudget)
	}
}

// A shared TV is in a room with other people.
func TestSharedTVCarriesTheSharedRiskPolicy(t *testing.T) {
	vp := runtimeViewportFromSurface(RuntimeTurnSurface{Class: "tvos"})
	if vp.RiskPolicy != "shared-tv" {
		t.Fatalf("tv risk policy = %q, want shared-tv", vp.RiskPolicy)
	}
}
