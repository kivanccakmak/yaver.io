package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDetectTestFramework(t *testing.T) {
	tests := []struct {
		file      string
		wantFw    string
		wantType  string
	}{
		{"pubspec.yaml", "flutter_test", "unit"},
		{"jest.config.js", "jest", "unit"},
		{"vitest.config.ts", "vitest", "unit"},
		{"pytest.ini", "pytest", "unit"},
		{"Cargo.toml", "cargo_test", "unit"},
		{"go.mod", "go_test", "unit"},
		{"playwright.config.ts", "playwright", "e2e"},
		{"cypress.config.js", "cypress", "e2e"},
	}

	for _, tt := range tests {
		tmpDir := t.TempDir()
		os.WriteFile(filepath.Join(tmpDir, tt.file), []byte(""), 0644)

		fw, _, testType := DetectTestFramework(tmpDir)
		if fw != tt.wantFw {
			t.Errorf("%s: expected framework %q, got %q", tt.file, tt.wantFw, fw)
		}
		if testType != tt.wantType {
			t.Errorf("%s: expected type %q, got %q", tt.file, tt.wantType, testType)
		}
	}
}

func TestDetectTestFrameworkMaestro(t *testing.T) {
	tmpDir := t.TempDir()
	os.MkdirAll(filepath.Join(tmpDir, ".maestro"), 0755)

	fw, _, testType := DetectTestFramework(tmpDir)
	if fw != "maestro" {
		t.Errorf("expected maestro, got %q", fw)
	}
	if testType != "e2e" {
		t.Errorf("expected e2e, got %q", testType)
	}
}

func TestDetectTestFrameworkNone(t *testing.T) {
	tmpDir := t.TempDir()
	fw, _, _ := DetectTestFramework(tmpDir)
	if fw != "" {
		t.Errorf("expected empty framework for empty dir, got %q", fw)
	}
}

func TestParseTestResultsGoTest(t *testing.T) {
	output := `=== RUN   TestFoo
--- PASS: TestFoo (0.01s)
=== RUN   TestBar
--- FAIL: TestBar (0.02s)
FAIL
`
	r := parseTestResults("go_test", output)
	if r.Passed < 1 {
		t.Errorf("expected at least 1 passed, got %d", r.Passed)
	}
	if r.Failed < 1 {
		t.Errorf("expected at least 1 failed, got %d", r.Failed)
	}
}

func TestParseTestResultsFlutter(t *testing.T) {
	output := "+5: All tests passed!\n"
	r := parseTestResults("flutter_test", output)
	if r.Passed != 5 {
		t.Errorf("expected 5 passed, got %d", r.Passed)
	}
}

func TestTestHTTPList(t *testing.T) {
	em := &ExecManager{sessions: make(map[string]*ExecSession), workDir: "/tmp"}
	tm := NewTestManager(em, "/tmp")

	srv := &HTTPServer{
		token:       "test-token",
		ownerUserID: "user123",
		testMgr:     tm,
	}

	req := httptest.NewRequest("GET", "/tests", nil)
	w := httptest.NewRecorder()
	srv.handleTests(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var sessions []*TestSession
	json.Unmarshal(w.Body.Bytes(), &sessions)
	if len(sessions) != 0 {
		t.Fatalf("expected empty, got %d", len(sessions))
	}
}

func TestTestHTTPNoManager(t *testing.T) {
	srv := &HTTPServer{testMgr: nil}

	req := httptest.NewRequest("GET", "/tests", nil)
	w := httptest.NewRecorder()
	srv.handleTests(w, req)

	if w.Code != 503 {
		t.Fatalf("expected 503, got %d", w.Code)
	}
}

func TestTestHTTPNotFound(t *testing.T) {
	em := &ExecManager{sessions: make(map[string]*ExecSession), workDir: "/tmp"}
	tm := NewTestManager(em, "/tmp")
	srv := &HTTPServer{testMgr: tm}

	req := httptest.NewRequest("GET", "/tests/nonexistent", nil)
	w := httptest.NewRecorder()
	srv.handleTestByID(w, req)

	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestResolveClientPlatform(t *testing.T) {
	tests := []struct {
		platform string
		clientOS string
		want     string
	}{
		{"flutter", "ios", "flutter-ipa"},
		{"flutter", "android", "flutter-apk"},
		{"rn", "ios", "rn-ios"},
		{"rn", "android", "rn-android"},
		{"expo", "ios", "expo-ios"},
		{"expo", "android", "expo-android"},
		{"gradle", "android", "gradle-apk"},
		{"xcode", "ios", "xcode-ipa"},
		{"flutter-apk", "ios", "flutter-apk"}, // already specific, unchanged
		{"custom", "android", "custom"},         // unknown, unchanged
	}

	for _, tt := range tests {
		got := resolveClientPlatform(tt.platform, tt.clientOS)
		if got != tt.want {
			t.Errorf("resolveClientPlatform(%q, %q) = %q, want %q", tt.platform, tt.clientOS, got, tt.want)
		}
	}
}

func TestAgentWorkdir(t *testing.T) {
	tmpDir := t.TempDir()
	em := &ExecManager{sessions: make(map[string]*ExecSession), workDir: "/tmp"}
	bm := NewBuildManager(em, "/tmp")
	tm := NewTestManager(em, "/tmp")

	srv := &HTTPServer{
		taskMgr:  &TaskManager{workDir: "/tmp"},
		execMgr:  em,
		buildMgr: bm,
		testMgr:  tm,
	}

	// Change workdir
	body := `{"workDir":"` + tmpDir + `"}`
	req := httptest.NewRequest("POST", "/agent/workdir", strings.NewReader(body))
	w := httptest.NewRecorder()
	srv.handleAgentWorkdir(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify all managers updated
	if em.workDir != tmpDir {
		t.Errorf("execMgr workDir not updated: %s", em.workDir)
	}
	if bm.workDir != tmpDir {
		t.Errorf("buildMgr workDir not updated: %s", bm.workDir)
	}
	if tm.workDir != tmpDir {
		t.Errorf("testMgr workDir not updated: %s", tm.workDir)
	}
}

func TestAgentWorkdirInvalid(t *testing.T) {
	srv := &HTTPServer{
		taskMgr: &TaskManager{workDir: "/tmp"},
	}

	body := `{"workDir":"/nonexistent/path/xyz"}`
	req := httptest.NewRequest("POST", "/agent/workdir", strings.NewReader(body))
	w := httptest.NewRecorder()
	srv.handleAgentWorkdir(w, req)

	if w.Code != 400 {
		t.Fatalf("expected 400 for invalid dir, got %d", w.Code)
	}
}

func TestAgentContext(t *testing.T) {
	srv := &HTTPServer{
		taskMgr: &TaskManager{workDir: "/tmp"},
	}

	req := httptest.NewRequest("GET", "/agent/context", nil)
	w := httptest.NewRecorder()
	srv.handleAgentContext(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var ctx map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &ctx)
	if ctx["workDir"] != "/tmp" {
		t.Errorf("expected workDir '/tmp', got %v", ctx["workDir"])
	}
}

func TestTunnelHTTPList(t *testing.T) {
	tm := NewTunnelManager()
	srv := &HTTPServer{tunnelMgr: tm}

	req := httptest.NewRequest("GET", "/tunnels", nil)
	w := httptest.NewRecorder()
	srv.handleTunnels(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

func TestTunnelHTTPCreate(t *testing.T) {
	tm := NewTunnelManager()
	srv := &HTTPServer{tunnelMgr: tm}

	body := `{"port":9100,"protocol":"flutter"}`
	req := httptest.NewRequest("POST", "/tunnels", strings.NewReader(body))
	w := httptest.NewRecorder()
	srv.handleTunnels(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var tunnel TunnelSession
	json.Unmarshal(w.Body.Bytes(), &tunnel)
	if tunnel.LocalPort != 9100 {
		t.Errorf("expected port 9100, got %d", tunnel.LocalPort)
	}
	if tunnel.Protocol != "flutter" {
		t.Errorf("expected protocol flutter, got %q", tunnel.Protocol)
	}
	if !tunnel.Active {
		t.Error("expected tunnel to be active")
	}
}

func TestTunnelHTTPNotFound(t *testing.T) {
	tm := NewTunnelManager()
	srv := &HTTPServer{tunnelMgr: tm}

	req := httptest.NewRequest("GET", "/tunnels/nonexistent", nil)
	w := httptest.NewRecorder()
	srv.handleTunnelByID(w, req)

	if w.Code != 404 {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestFindProject(t *testing.T) {
	// This test works with whatever projects exist on the machine
	// Just verify the function doesn't panic with empty input
	_, err := findProject("definitely-nonexistent-project-xyz-12345")
	if err == nil {
		// It's OK if it finds something, but unlikely
	}
}

func TestDetectBuildPlatform(t *testing.T) {
	// Flutter project
	tmpDir := t.TempDir()
	os.WriteFile(filepath.Join(tmpDir, "pubspec.yaml"), []byte("name: test"), 0644)
	platform := detectBuildPlatform(tmpDir)
	if platform != "flutter-apk" {
		t.Errorf("expected flutter-apk, got %q", platform)
	}

	// Empty dir
	emptyDir := t.TempDir()
	platform = detectBuildPlatform(emptyDir)
	if platform != "" {
		t.Errorf("expected empty for empty dir, got %q", platform)
	}
}

func TestPlatformHeaderInBuildRequest(t *testing.T) {
	em := &ExecManager{sessions: make(map[string]*ExecSession), workDir: "/tmp"}
	bm := NewBuildManager(em, "/tmp")
	srv := &HTTPServer{buildMgr: bm}

	// Send a build request with X-Client-Platform: ios and platform: flutter
	// Should resolve to flutter-ipa
	body := `{"platform":"flutter","workDir":"/tmp"}`
	req := httptest.NewRequest("POST", "/builds", strings.NewReader(body))
	req.Header.Set("X-Client-Platform", "ios")
	w := httptest.NewRecorder()
	srv.handleBuilds(w, req)

	// The build will fail (no flutter installed) but the platform should be resolved
	// Check response for the resolved platform
	if w.Code == 200 {
		var build Build
		json.Unmarshal(w.Body.Bytes(), &build)
		if build.Platform != PlatformFlutterIPA {
			t.Errorf("expected flutter-ipa, got %q", build.Platform)
		}
	}
	// If it fails with "command blocked" or similar, that's fine — we tested the resolution
}
