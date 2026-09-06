package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func resetBrowserShortcutRegistryForTest() {
	browserShortcutRegistry.Lock()
	browserShortcutRegistry.root = ""
	browserShortcutRegistry.state = browserShortcutRegistryState{}
	browserShortcutRegistry.Unlock()
	browserShortcutEnrollments.Lock()
	browserShortcutEnrollments.items = map[string]*browserShortcutEnrollment{}
	browserShortcutEnrollments.Unlock()
}

func storeBrowserShortcutReleaseForTest(t *testing.T, release *BrowserShortcutRelease) {
	t.Helper()
	browserShortcutRegistry.Lock()
	defer browserShortcutRegistry.Unlock()
	state := loadBrowserShortcutRegistryLocked()
	state.Apps[release.AppID] = release
	if err := saveBrowserShortcutRegistryLocked(state); err != nil {
		t.Fatal(err)
	}
}

func browserShortcutFixture(t *testing.T) (string, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	resetBrowserShortcutRegistryForTest()
	project := filepath.Join(t.TempDir(), "mobile")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	pkg := `{"name":"fixture","dependencies":{"expo":"^54.0.0","react-native":"0.81.0"}}`
	if err := os.WriteFile(filepath.Join(project, "package.json"), []byte(pkg), 0o644); err != nil {
		t.Fatal(err)
	}
	build := filepath.Join(project, ".yaver-build-web")
	if err := os.MkdirAll(filepath.Join(build, "_expo"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(build, "index.html"), []byte(`<!doctype html><html><head></head><body><div id="root"></div><script src="/_expo/app.js"></script></body></html>`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(build, "_expo", "app.js"), []byte(`document.getElementById("root").textContent="ready"`), 0o644); err != nil {
		t.Fatal(err)
	}
	return project, build
}

func TestBrowserShortcutPreflightFailsClosedWithoutDedicatedHTTPSOrigin(t *testing.T) {
	project, _ := browserShortcutFixture(t)
	base := BrowserShortcutRequest{AppID: "com.example.app", ProjectPath: project, Brand: BrowserShortcutBrand{DisplayName: "Example"}}

	for _, origin := range []string{"", "http://app.example.com", "https://192.168.1.10", "https://[2001:db8::1]", "https://public.yaver.io/d/device", "https://app.example.com/shared", "https://device-123.dev.yaver.io"} {
		base.PublicOrigin = origin
		got := browserShortcutPreflight(base)
		if got.OK || !strings.HasPrefix(got.Code, "BROWSER_SHORTCUT_") {
			t.Fatalf("origin %q preflight = %+v, want named origin refusal", origin, got)
		}
	}

	base.PublicOrigin = "https://app.example.com"
	got := browserShortcutPreflight(base)
	if !got.OK || got.BuildTarget != "browser-shortcut-bundle" || got.PublicOrigin != base.PublicOrigin {
		t.Fatalf("dedicated origin preflight = %+v", got)
	}
}

func TestBrowserShortcutAutomaticOriginStopsBeforeBuildWithoutRelay(t *testing.T) {
	project, _ := browserShortcutFixture(t)
	srv := &HTTPServer{port: 18080, deviceID: "device-1"}
	_, got := srv.prepareBrowserShortcutRequest(BrowserShortcutRequest{
		AppID: "com.example.app", ProjectPath: project, Brand: BrowserShortcutBrand{DisplayName: "Example"},
	})
	if got.OK || got.Code != "BROWSER_SHORTCUT_RELAY_REQUIRED" {
		t.Fatalf("automatic origin without relay = %+v", got)
	}
	if sub := defaultBrowserShortcutSubdomain("com.example.app", "device-1"); len(sub) < 3 || len(sub) > 32 {
		t.Fatalf("derived relay subdomain %q is invalid", sub)
	}
}

func TestBrowserShortcutPublishSnapshotsAndServesOnlyClaimedHost(t *testing.T) {
	project, build := browserShortcutFixture(t)
	mgr := &DevServerManager{}
	mgr.SetWebBundleInfo(WebBundleInfo{
		Target: "web-js-bundle", BuildDir: build, WorkDir: project,
		IndexFile: "index.html", BuiltAt: "2026-09-06T09:00:00Z", HeadCommit: "abc123",
	})
	srv := &HTTPServer{devServerMgr: mgr}
	req := BrowserShortcutRequest{
		AppID: "com.example.sfmg", ProjectPath: project, PublicOrigin: "https://sfmg.example.com",
		Brand: BrowserShortcutBrand{DisplayName: "SFMG", ShortName: "SFMG", ThemeColor: "#123456", BackgroundColor: "#FFFFFF"},
	}
	release, err := srv.publishBrowserShortcut(req)
	if err != nil {
		t.Fatal(err)
	}
	if release.InstallURL != "https://sfmg.example.com/" || release.ReleaseID == "" {
		t.Fatalf("release = %+v", release)
	}

	releaseReq := httptest.NewRequest(http.MethodGet, "https://sfmg.example.com/release.json", nil)
	releaseReq.Host = "sfmg.example.com"
	releaseRec := httptest.NewRecorder()
	if !srv.serveBrowserShortcutOrigin(releaseRec, releaseReq) {
		t.Fatal("public release metadata not served")
	}
	if strings.Contains(releaseRec.Body.String(), project) || strings.Contains(releaseRec.Body.String(), `"projectPath"`) {
		t.Fatalf("public release metadata leaked its checkout path: %s", releaseRec.Body.String())
	}

	request := httptest.NewRequest(http.MethodGet, "https://sfmg.example.com/", nil)
	request.Host = "sfmg.example.com"
	request.Header.Set("Accept", "text/html")
	recorder := httptest.NewRecorder()
	if !srv.serveBrowserShortcutOrigin(recorder, request) {
		t.Fatal("claimed host did not serve its release")
	}
	body := recorder.Body.String()
	for _, want := range []string{`href="/manifest.webmanifest`, `navigator.serviceWorker.register('/sw.js'`, `src="_expo/app.js"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("served HTML missing %q:\n%s", want, body)
		}
	}

	wrong := httptest.NewRequest(http.MethodGet, "https://other.example.com/", nil)
	wrong.Host = "other.example.com"
	if srv.serveBrowserShortcutOrigin(httptest.NewRecorder(), wrong) {
		t.Fatal("an unclaimed host received another app's release")
	}

	manifestReq := httptest.NewRequest(http.MethodGet, "https://sfmg.example.com/manifest.webmanifest", nil)
	manifestReq.Host = "sfmg.example.com"
	manifestRec := httptest.NewRecorder()
	if !srv.serveBrowserShortcutOrigin(manifestRec, manifestReq) {
		t.Fatal("manifest not served")
	}
	if !strings.Contains(manifestRec.Body.String(), `"display":"standalone"`) {
		t.Fatalf("manifest is not installable: %s", manifestRec.Body.String())
	}
}

func TestBrowserShortcutOriginCannotBeReusedAcrossApps(t *testing.T) {
	project, _ := browserShortcutFixture(t)
	first := BrowserShortcutRequest{AppID: "com.example.first", ProjectPath: project, PublicOrigin: "https://one.example.com"}
	pre := browserShortcutPreflight(first)
	if !pre.OK {
		t.Fatalf("first preflight failed: %+v", pre)
	}
	browserShortcutRegistry.Lock()
	state := loadBrowserShortcutRegistryLocked()
	state.Apps[first.AppID] = &BrowserShortcutRelease{AppID: first.AppID, PublicOrigin: first.PublicOrigin}
	if err := saveBrowserShortcutRegistryLocked(state); err != nil {
		browserShortcutRegistry.Unlock()
		t.Fatal(err)
	}
	browserShortcutRegistry.Unlock()

	second := first
	second.AppID = "com.example.second"
	got := browserShortcutPreflight(second)
	if got.OK || got.Code != "BROWSER_SHORTCUT_ORIGIN_IN_USE" {
		t.Fatalf("second app origin reuse = %+v", got)
	}
}

func TestBrowserShortcutNativeOriginRoutesEnrollmentPOST(t *testing.T) {
	_, _ = browserShortcutFixture(t)
	release := &BrowserShortcutRelease{
		Version: 1, AppID: "com.example.native", Slug: "com-example-native",
		ReleaseID: "native1", PublicOrigin: "https://native.example.com",
		InstallURL: "https://native.example.com/", Mode: browserShortcutModeRemoteRuntime,
		Framework: "swift", RuntimeTarget: "ios-simulator",
		Brand: BrowserShortcutBrand{DisplayName: "Native"},
	}
	storeBrowserShortcutReleaseForTest(t, release)

	nextCalled := false
	srv := &HTTPServer{}
	handler := srv.browserShortcutOriginRouter(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		http.Error(w, "wrong router", http.StatusTeapot)
	}))
	req := httptest.NewRequest(http.MethodPost, "https://native.example.com/runtime/enroll/start", nil)
	req.Host = "native.example.com"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if nextCalled || rec.Code != http.StatusOK {
		t.Fatalf("native enrollment POST was not handled by shortcut origin: next=%v status=%d body=%s", nextCalled, rec.Code, rec.Body.String())
	}
	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["code"] == "" || body["secret"] == "" {
		t.Fatalf("enrollment response = %s, err=%v", rec.Body.String(), err)
	}
}

func TestBrowserShortcutEnrollmentFloodIsBoundedPerApp(t *testing.T) {
	resetBrowserShortcutRegistryForTest()
	release := &BrowserShortcutRelease{AppID: "com.example.bounded"}
	for i := 0; i < browserShortcutMaxPendingEnrollmentsPerApp+5; i++ {
		req := httptest.NewRequest(http.MethodPost, "/runtime/enroll/start", nil)
		rec := httptest.NewRecorder()
		startBrowserShortcutEnrollment(rec, req, release)
		if rec.Code != http.StatusOK {
			t.Fatalf("enrollment %d status = %d (%s)", i, rec.Code, rec.Body.String())
		}
	}
	browserShortcutEnrollments.Lock()
	defer browserShortcutEnrollments.Unlock()
	count := 0
	for _, enrollment := range browserShortcutEnrollments.items {
		if enrollment.AppID == release.AppID {
			count++
		}
	}
	if count != browserShortcutMaxPendingEnrollmentsPerApp {
		t.Fatalf("pending enrollments = %d, want bounded maximum %d", count, browserShortcutMaxPendingEnrollmentsPerApp)
	}
}

func TestBrowserShortcutTokenCannotCrossAppBoundary(t *testing.T) {
	_, _ = browserShortcutFixture(t)
	storeBrowserShortcutReleaseForTest(t, &BrowserShortcutRelease{AppID: "com.example.one", PublicOrigin: "https://one.example.com"})
	storeBrowserShortcutReleaseForTest(t, &BrowserShortcutRelease{AppID: "com.example.two", PublicOrigin: "https://two.example.com"})
	raw, err := mintBrowserShortcutToken("com.example.one")
	if err != nil {
		t.Fatal(err)
	}
	if !validateBrowserShortcutToken("com.example.one", raw) {
		t.Fatal("minted project token was not accepted for its own app")
	}
	if validateBrowserShortcutToken("com.example.two", raw) {
		t.Fatal("project-scoped shortcut token crossed into another app")
	}
}

func TestBrowserShortcutRuntimeJSONRemovesMachineIdentityRecursively(t *testing.T) {
	payload := map[string]interface{}{
		"session": map[string]interface{}{
			"id": "rr_1", "status": "streaming", "workDir": "/private/checkout",
			"deviceId": "SIMULATOR-UDID", "remoteBuilderId": "private-mac", "startedBy": "owner-device", "runner": "codex",
			"deviceDims": map[string]interface{}{"width": 393.0, "height": 852.0},
		},
	}
	got := sanitizeBrowserShortcutRuntimeJSON(payload).(map[string]interface{})
	session := got["session"].(map[string]interface{})
	for _, key := range []string{"workDir", "deviceId", "remoteBuilderId", "startedBy", "runner"} {
		if _, ok := session[key]; ok {
			t.Fatalf("private runtime field %q reached shortcut response: %#v", key, session)
		}
	}
	if session["id"] != "rr_1" || session["status"] != "streaming" || session["deviceDims"] == nil {
		t.Fatalf("viewer-required runtime fields were removed: %#v", session)
	}
}

func TestBrowserShortcutSDKProjectScopeFailsClosed(t *testing.T) {
	project := filepath.Join(t.TempDir(), "sfmg")
	req := httptest.NewRequest(http.MethodPost, "/browser-shortcuts/preflight", nil)
	req.Header.Set("X-Yaver-SdkAllowedProjects", `["sfmg"]`)
	if !browserShortcutProjectAllowed(req, project) {
		t.Fatal("matching owner-approved project slug was refused")
	}
	if browserShortcutProjectAllowed(req, filepath.Join(t.TempDir(), "another-app")) {
		t.Fatal("browser-shortcut SDK token escaped its project allowlist")
	}
	req.Header.Set("X-Yaver-SdkAllowedProjects", `[]`)
	if browserShortcutProjectAllowed(req, project) {
		t.Fatal("empty SDK project allowlist was interpreted as all projects")
	}
}

func TestBuildNativeShortcutShellIsFullscreenRuntimeViewer(t *testing.T) {
	project, _ := browserShortcutFixture(t)
	buildDir := filepath.Join(t.TempDir(), "native-shell")
	srv := &HTTPServer{devServerMgr: &DevServerManager{}}
	rec := httptest.NewRecorder()
	srv.buildNativeShortcutShell(rec, buildWebRequest{
		Target: "browser-shortcut-bundle", Caller: "test", WorkDir: project, BuildDir: buildDir,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("native shell build status=%d body=%s", rec.Code, rec.Body.String())
	}
	js, err := os.ReadFile(filepath.Join(buildDir, "runtime.js"))
	if err != nil {
		t.Fatal(err)
	}
	css, err := os.ReadFile(filepath.Join(buildDir, "runtime.css"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"RTCPeerConnection", `command:"run-project"`, "/runtime/enroll/start"} {
		if !strings.Contains(string(js), want) {
			t.Fatalf("native runtime client missing %q", want)
		}
	}
	if !strings.Contains(string(css), "width:100%;height:100%;overflow:hidden") {
		t.Fatal("native viewer shell is not a full-screen app surface")
	}
}
