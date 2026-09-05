package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

func expoBrowserRouteTestManager(t *testing.T, upstream *httptest.Server) *DevServerManager {
	t.Helper()
	u, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	expo := &ExpoDevServer{devMode: "dev-client", webPort: port}
	expo.name = "expo"
	expo.port = 8081
	expo.running = true
	expo.workDir = "/workspace/yaver"
	return &DevServerManager{active: &devServerSession{
		server: expo,
		ctx:    context.Background(), cancel: func() {}, releasePort: func() {},
	}}
}

// Regression for the 2026-09-05 Dogfood incident: /dev-web/ and the entry
// bundle returned 200, React mounted, then the router's visible "/" refreshed
// through the agent mux and returned the bare 19-byte Go 404.
func TestBrowserPreviewLogicalRootSurvivesRefresh(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><head></head><body><div id="root"><p>Yaver</p></div></body></html>`))
	}))
	defer upstream.Close()

	s := &HTTPServer{devServerMgr: expoBrowserRouteTestManager(t, upstream)}
	rec := httptest.NewRecorder()
	s.handleBrowserPreviewRoot(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("logical preview root returned %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Yaver-Preview-Route") != "logical-root" {
		t.Fatalf("logical-root diagnostic header missing: %#v", rec.Header())
	}
	if !strings.Contains(rec.Body.String(), "Yaver") {
		t.Fatalf("logical root did not reach the browser preview: %s", rec.Body.String())
	}
}

func TestBrowserPreviewLogicalRootFailsClosedWithoutPreview(t *testing.T) {
	rec := httptest.NewRecorder()
	(&HTTPServer{devServerMgr: NewDevServerManager()}).handleBrowserPreviewRoot(
		rec, httptest.NewRequest(http.MethodGet, "/", nil),
	)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("inactive preview root = %d, want 404", rec.Code)
	}
}

func TestBrowserPreviewLogicalRootRejectsMutations(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("POST must never reach the guest preview root")
	}))
	defer upstream.Close()
	rec := httptest.NewRecorder()
	(&HTTPServer{devServerMgr: expoBrowserRouteTestManager(t, upstream)}).handleBrowserPreviewRoot(
		rec, httptest.NewRequest(http.MethodPost, "/guest-action", nil),
	)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("POST logical root = %d, want 404", rec.Code)
	}
}
