package main

// Detection-driven option lists. The rule under test everywhere in this file:
// Hermes is React Native / Expo ONLY, and for other stacks it must be ABSENT —
// not present-and-disabled. A greyed-out button still tells the user the option
// exists for their Flutter app, and it does not.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func capsFor(t *testing.T, files map[string]string, paired bool) ProjectPreviewCapabilities {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	return DetectProjectPreviewCapabilities(dir, "", paired)
}

func hasOption(caps ProjectPreviewCapabilities, id string) bool {
	for _, o := range caps.Options {
		if o.ID == id {
			return true
		}
	}
	return false
}

// ── Hermes appears ONLY for RN/Expo ────────────────────────────────────────

func TestHermesOfferedOnlyForReactNativeAndExpo(t *testing.T) {
	cases := []struct {
		name       string
		files      map[string]string
		wantFw     string
		wantHermes bool
	}{
		{
			name:       "expo",
			files:      map[string]string{"package.json": `{"name":"todo","dependencies":{"expo":"~52.0.0"}}`},
			wantFw:     "expo",
			wantHermes: true,
		},
		{
			name:       "react-native",
			files:      map[string]string{"package.json": `{"name":"todo","dependencies":{"react-native":"0.76.0"}}`},
			wantFw:     "react-native",
			wantHermes: true,
		},
		{
			name:       "flutter",
			files:      map[string]string{"pubspec.yaml": "name: todo_flutter\nflutter:\n  uses-material-design: true\n"},
			wantFw:     "flutter",
			wantHermes: false,
		},
		{
			name: "kotlin-android",
			files: map[string]string{
				"build.gradle.kts":                 `plugins { id("com.android.application") }`,
				"settings.gradle.kts":              `rootProject.name = "todo"`,
				"app/src/main/AndroidManifest.xml": `<manifest/>`,
				"app/build.gradle.kts":             `plugins { id("com.android.application") }`,
			},
			wantFw:     "kotlin",
			wantHermes: false,
		},
		{
			name:       "swift",
			files:      map[string]string{"Package.swift": `// swift-tools-version:5.9`},
			wantFw:     "swift",
			wantHermes: false,
		},
		{
			name:       "nextjs",
			files:      map[string]string{"next.config.js": `module.exports = {}`},
			wantFw:     "nextjs",
			wantHermes: false,
		},
		{
			name:       "vite",
			files:      map[string]string{"vite.config.js": `export default {}`},
			wantFw:     "vite",
			wantHermes: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			caps := capsFor(t, tc.files, true)
			if caps.Framework != tc.wantFw {
				t.Fatalf("framework = %q, want %q", caps.Framework, tc.wantFw)
			}
			if got := HermesOfferedFor(caps); got != tc.wantHermes {
				t.Fatalf("hermes offered = %v, want %v (framework %q)", got, tc.wantHermes, caps.Framework)
			}
			if !tc.wantHermes {
				// Absent, not merely disabled.
				for _, o := range caps.Options {
					if o.ID == PreviewOptionHermes || o.ID == PreviewOptionOpenNative {
						t.Fatalf("%s: option %q present (supported=%v) — it must not be listed at all",
							tc.name, o.ID, o.Supported)
					}
				}
			}
			if len(caps.Options) == 0 {
				t.Fatalf("%s: no options at all — a surface would render an empty sheet", tc.name)
			}
			if caps.Reason == "" {
				t.Fatalf("%s: no reason given", tc.name)
			}
		})
	}
}

// Native stacks get a runtime option, and it explains what they need.
func TestNativeStacksGetARuntimeOptionWithAnExplanation(t *testing.T) {
	swift := capsFor(t, map[string]string{"Package.swift": "// swift-tools-version:5.9"}, false)
	if !hasOption(swift, PreviewOptionRemoteRuntime) {
		t.Fatalf("swift has no remote-runtime option: %+v", swift.Options)
	}
	kotlin := capsFor(t, map[string]string{
		"build.gradle.kts":                 `plugins { id("com.android.application") }`,
		"settings.gradle.kts":              `rootProject.name = "t"`,
		"app/src/main/AndroidManifest.xml": `<manifest/>`,
		"app/build.gradle.kts":             `plugins { id("com.android.application") }`,
	}, false)
	if !hasOption(kotlin, PreviewOptionRemoteRuntime) {
		t.Fatalf("kotlin has no remote-runtime option: %+v", kotlin.Options)
	}
	for _, o := range kotlin.Options {
		if o.ID == PreviewOptionRemoteRuntime && o.Reason == "" {
			t.Fatalf("kotlin remote-runtime option has no explanation")
		}
	}
}

// Flutter renders in a browser: dev server leads, Hermes never appears.
func TestFlutterLeadsWithTheDevServer(t *testing.T) {
	caps := capsFor(t, map[string]string{"pubspec.yaml": "name: todo\nflutter:\n  uses-material-design: true\n"}, true)
	var primary string
	for _, o := range caps.Options {
		if o.Primary {
			primary = o.ID
		}
	}
	if primary != PreviewOptionDevServer {
		t.Fatalf("flutter primary = %q, want dev-server", primary)
	}
	if HermesOfferedFor(caps) {
		t.Fatalf("flutter offered Hermes")
	}
}

// ── Pairing changes support, not the option set ────────────────────────────

func TestPairedDeviceDrivesOpenInYaverSupport(t *testing.T) {
	files := map[string]string{"package.json": `{"dependencies":{"expo":"*"}}`}

	unpaired := capsFor(t, files, false)
	for _, o := range unpaired.Options {
		if o.ID == PreviewOptionOpenNative {
			if o.Supported {
				t.Fatalf("open-native supported with no paired device")
			}
			if o.Reason == "" {
				t.Fatalf("open-native disabled with no explanation — the user cannot tell what to fix")
			}
		}
	}
	paired := capsFor(t, files, true)
	for _, o := range paired.Options {
		if o.ID == PreviewOptionOpenNative && !o.Supported {
			t.Fatalf("open-native unsupported despite a paired device: %q", o.Reason)
		}
	}
}

// Browser Reload is the primary RN/Expo preview lane, even when Hermes is
// available. It is the same direct browser/WebView path used by the web UI.
func TestRNLeadsWithBrowserReload(t *testing.T) {
	caps := capsFor(t, map[string]string{"package.json": `{"dependencies":{"expo":"*"}}`}, false)
	for _, o := range caps.Options {
		if o.Primary && o.ID != PreviewOptionDevServer {
			t.Fatalf("primary = %q, want dev-server", o.ID)
		}
	}
	if caps.Options[0].ID != PreviewOptionDevServer {
		t.Fatalf("first option = %q, want dev-server", caps.Options[0].ID)
	}
}

// ── Yaver self-development ─────────────────────────────────────────────────

func TestSelfDevelopmentReplacesHermesWithStreaming(t *testing.T) {
	caps := capsFor(t, map[string]string{
		"package.json": `{"name":"yaver-mobile","dependencies":{"expo":"*"}}`,
	}, true)

	if !caps.SelfDevelopment {
		t.Fatalf("yaver-mobile not detected as self-development")
	}
	if HermesOfferedFor(caps) {
		t.Fatalf("Hermes offered for Yaver self-development — that is the recursion trap")
	}
	if !hasOption(caps, PreviewOptionRemoteRuntime) {
		t.Fatalf("no streaming option offered as the replacement: %+v", caps.Options)
	}
	if caps.Reason == "" {
		t.Fatalf("self-development gave no reason")
	}
}

// THE PAIRING TEST. Two policies decide what Yaver-on-Yaver may do, and until
// 2026-08-02 nothing bound them together — so they disagreed:
//
//   - ShouldRefuseYaverSelfDevelopmentHermes refuses ONLY "mobile-hermes", and
//     its comment says web targets must stay open because refusing them "would
//     block the very route this guard steers people toward";
//   - this file's self-dev arm offered ONE option, Stream over WebRTC.
//
// Since a surface treats an unoffered lane as ABSENT (mobileProjectActions.ts),
// the refusal pointed at a door the advertiser never drew. Browser Reload did
// not exist for Yaver's own repo, which made Attach Mode unreachable.
//
// This asserts the invariant directly: whatever the refusal leaves LEGAL, the
// advertiser must OFFER. Break it by deleting the dev-server option from the
// self-dev arm and this fails.
func TestSelfDevOffersTheLaneTheRefusalNames(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"),
		[]byte(`{"name":"yaver-mobile","dependencies":{"expo":"*"}}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	caps := DetectProjectPreviewCapabilities(dir, "", true)
	if !caps.SelfDevelopment {
		t.Fatalf("yaver-mobile not detected as self-development")
	}

	// The refusal's own verdict, asked directly rather than restated.
	if ShouldRefuseYaverSelfDevelopmentHermes("mobile-hermes", dir, "", "") != true {
		t.Fatalf("refusal no longer refuses mobile-hermes for self-dev")
	}
	if ShouldRefuseYaverSelfDevelopmentHermes("web", dir, "", "") != false {
		t.Fatalf("refusal now refuses the web target — the advertiser assumption below is void")
	}

	// Therefore the web lane must be offered, and must lead.
	if !hasOption(caps, PreviewOptionDevServer) {
		t.Fatalf("web target is legal per the refusal but Browser Reload is not offered: %+v", caps.Options)
	}
	if caps.Options[0].ID != PreviewOptionDevServer || !caps.Options[0].Primary {
		t.Fatalf("Browser Reload must be the primary self-dev lane, got %+v", caps.Options[0])
	}
	// And Hermes must still be gone — this test must not become a way to
	// re-open the recursion trap.
	if HermesOfferedFor(caps) {
		t.Fatalf("Hermes offered for Yaver self-development — that is the recursion trap")
	}
}

// A third-party RN app inside a yaver.io checkout keeps Hermes.
func TestThirdPartyRNInsideRepoKeepsHermes(t *testing.T) {
	root := filepath.Join(t.TempDir(), "yaver.io")
	dir := filepath.Join(root, "demo", "mobile", "todo-rn")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"),
		[]byte(`{"name":"todo-rn","dependencies":{"expo":"*"}}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	caps := DetectProjectPreviewCapabilities(dir, "", true)
	if caps.SelfDevelopment {
		t.Fatalf("third-party fixture inside the repo marked as self-development")
	}
	if !HermesOfferedFor(caps) {
		t.Fatalf("third-party RN app lost Hermes: %+v", caps.Options)
	}
}

// ── Detection beats the caller's hint ──────────────────────────────────────

// A surface that guesses wrong must not be able to conjure Hermes for a Flutter
// project. Disk wins.
func TestDetectionOverridesAWrongFrameworkHint(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pubspec.yaml"), []byte("name: todo\nflutter:\n  uses-material-design: true\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	caps := DetectProjectPreviewCapabilities(dir, "react-native", true)
	if caps.Framework != "flutter" {
		t.Fatalf("framework = %q, want flutter — the caller's hint overrode disk", caps.Framework)
	}
	if HermesOfferedFor(caps) {
		t.Fatalf("a wrong hint conjured Hermes for a Flutter project")
	}
}

// The hint is still used when the agent genuinely cannot see the project.
func TestFrameworkHintUsedOnlyWhenNothingIsDetectable(t *testing.T) {
	caps := DetectProjectPreviewCapabilities("", "expo", true)
	if caps.Framework != "expo" {
		t.Fatalf("framework = %q, want the hint to apply when no dir is readable", caps.Framework)
	}
	if !HermesOfferedFor(caps) {
		t.Fatalf("hinted RN project lost Hermes")
	}
}

// ── The ops verb every surface calls ───────────────────────────────────────

func TestOpsProjectPreviewOptionsReturnsDetectedOptions(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pubspec.yaml"), []byte("name: todo\nflutter:\n  uses-material-design: true\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	body, _ := json.Marshal(map[string]interface{}{"workDir": dir, "hasPairedDevice": true})
	res := opsProjectPreviewOptionsHandler(OpsContext{}, body)
	if !res.OK {
		t.Fatalf("verb failed: %+v", res)
	}
	caps, ok := res.Initial.(ProjectPreviewCapabilities)
	if !ok {
		t.Fatalf("unexpected result type %T", res.Initial)
	}
	if caps.Framework != "flutter" {
		t.Fatalf("framework = %q", caps.Framework)
	}
	if HermesOfferedFor(caps) {
		t.Fatalf("verb offered Hermes for Flutter")
	}
}

// Every option a surface renders must carry a label — an unlabelled row is an
// unpressable button.
func TestEveryOptionHasAnIDAndLabel(t *testing.T) {
	fixtures := []map[string]string{
		{"package.json": `{"dependencies":{"expo":"*"}}`},
		{"pubspec.yaml": "name: t\n"},
		{"Package.swift": "// x"},
		{"next.config.js": "module.exports={}"},
	}
	for i, f := range fixtures {
		caps := capsFor(t, f, i%2 == 0)
		for _, o := range caps.Options {
			if o.ID == "" || o.Label == "" {
				t.Fatalf("fixture %d: option with empty id/label: %+v", i, o)
			}
			if !o.Supported && o.Reason == "" {
				t.Fatalf("fixture %d: option %q disabled with no reason", i, o.ID)
			}
		}
	}
}

// ── Lane order + probe-backed support ──────────────────────────────────────

// The browser lane is the DEFAULT: surfaces treat the first supported option as
// what a plain "render it" means. Nothing may quietly reorder it away.
func TestBrowserLaneLeadsAfterRefinement(t *testing.T) {
	caps := ProjectPreviewCapabilities{Options: []ProjectPreviewOption{
		{ID: PreviewOptionHermes, Label: "Compile Hermes bundle", Supported: true, Primary: true},
		{ID: PreviewOptionDevServer, Label: "Browser Reload", Supported: true},
		{ID: PreviewOptionRemoteRuntime, Label: "Stream over WebRTC", Supported: true},
	}}
	out := ensureBrowserLaneLeads(caps)
	if out.Options[0].ID != PreviewOptionDevServer {
		t.Fatalf("browser lane must lead, got %q", out.Options[0].ID)
	}
	if !out.Options[0].Primary {
		t.Fatal("the leading browser lane must be primary")
	}
	primaries := 0
	for _, o := range out.Options {
		if o.Primary {
			primaries++
		}
	}
	if primaries != 1 {
		t.Fatalf("exactly one primary expected, got %d", primaries)
	}
	// Nothing may be LOST by reordering — an option that vanishes is a lane
	// the box silently stops offering.
	if len(out.Options) != 3 {
		t.Fatalf("reordering dropped options: %+v", out.Options)
	}
}

// When the browser lane is not runnable, the default must move to something
// that IS — never stay pointed at a dead lane.
func TestDefaultMovesOffAnUnrunnableBrowserLane(t *testing.T) {
	caps := ProjectPreviewCapabilities{Options: []ProjectPreviewOption{
		{ID: PreviewOptionDevServer, Label: "Browser Reload", Supported: false, Primary: true},
		{ID: PreviewOptionRemoteRuntime, Label: "Stream over WebRTC", Supported: true},
	}}
	out := ensureBrowserLaneLeads(caps)
	for _, o := range out.Options {
		if o.Primary && !o.Supported {
			t.Fatalf("primary points at an unsupported lane: %+v", o)
		}
	}
	if !out.Options[1].Primary {
		t.Fatalf("expected the runnable lane to become primary: %+v", out.Options)
	}
}

// A lane the box cannot actually run is DISABLED WITH A REASON, never dropped.
// Dropping it makes the box lie by omission about a lane the stack supports.
func TestUnrunnableLaneIsDisabledWithAReasonNotRemoved(t *testing.T) {
	caps := ProjectPreviewCapabilities{Options: []ProjectPreviewOption{
		{ID: PreviewOptionDevServer, Label: "Browser Reload", Supported: true, Primary: true},
		// iOS-simulator strategy is the one ProbePreviewCapability refuses
		// outright on a non-Mac workspace, so this exercises the real probe.
		{ID: PreviewOptionRemoteRuntime, Label: "Stream over WebRTC", Supported: true},
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out := RefineProjectPreviewCapabilitiesWithProbes(ctx, caps, "")

	if len(out.Options) != 2 {
		t.Fatalf("refinement dropped an option instead of disabling it: %+v", out.Options)
	}
	// Whatever the probe decided, the browser lane keeps leading and every
	// unsupported option carries a reason.
	if out.Options[0].ID != PreviewOptionDevServer || !out.Options[0].Supported {
		t.Fatalf("browser lane must never be demoted by a probe: %+v", out.Options[0])
	}
	for _, o := range out.Options {
		if !o.Supported && strings.TrimSpace(o.Reason) == "" {
			t.Fatalf("unsupported option %q carries no reason", o.ID)
		}
		if !o.Supported && o.Primary {
			t.Fatalf("unsupported option %q left primary", o.ID)
		}
	}
}

// An expired context must keep the STATIC verdict. "I ran out of time" must
// never be reported as "your box cannot do this".
func TestProbeTimeoutKeepsTheStaticVerdict(t *testing.T) {
	caps := ProjectPreviewCapabilities{Options: []ProjectPreviewOption{
		{ID: PreviewOptionDevServer, Label: "Browser Reload", Supported: true, Primary: true},
		{ID: PreviewOptionHermes, Label: "Compile Hermes bundle", Supported: true},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already dead
	out := RefineProjectPreviewCapabilitiesWithProbes(ctx, caps, "")
	for _, o := range out.Options {
		if !o.Supported {
			t.Fatalf("a timeout turned into a false 'unavailable' for %q: %+v", o.ID, o)
		}
	}
}
