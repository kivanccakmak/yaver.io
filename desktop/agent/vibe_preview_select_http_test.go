package main

// vibe_preview_select_http_test.go — wire proof for POST /vibing/preview/select
// (the tvOS "kumanda" DOM-selection route).
//
// The backend (VibePreviewManager.SelectElement) has its own unit tests
// against a fake browser (vibe_preview_select_test.go). This file proves the
// OTHER half of the contract: the HTTP route exists, is owner-authenticated,
// turns {project, x, y, workDir} into a stored element in the SHARED
// domInspect store — the store the per-turn hook reads — and names its
// failures with honest statuses (404 no session / 400 no workDir / 503 no
// input browser). A regression that drops the mux route or the handler wiring
// fails here first.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func startVibePreviewSelectTestServer(t *testing.T) (*httptest.Server, *HTTPServer, *VibePreviewManager) {
	t.Helper()
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	hs := NewHTTPServer(0, "test-token", "test-user", "test-device", "", "test-host", tm)
	hs.browserMgr = NewBrowserManager()
	// Input-capable fake: the select route needs Evaluate + DispatchMouse, and
	// the capture script is twinned against the same fake as the unit tests.
	hs.vibePreviewMgr = NewVibePreviewManager(newInputFakeBrowser())
	hs.vibePreviewMgr.SetDiskRoot(t.TempDir())

	mux := http.NewServeMux()
	mux.HandleFunc("/vibing/preview/start", hs.auth(hs.handleVibePreviewStart))
	mux.HandleFunc("/vibing/preview/select", hs.auth(hs.handleVibePreviewSelect))
	mux.HandleFunc("/vibing/preview/dom-mode", hs.auth(hs.handleVibePreviewDomMode))

	srv := httptest.NewServer(mux)
	t.Cleanup(func() {
		hs.vibePreviewMgr.StopAll()
		hs.browserMgr.Stop()
		srv.Close()
	})
	return srv, hs, hs.vibePreviewMgr
}

func authedPost(t *testing.T, url, token, body string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest("POST", url, bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(b)
}

func TestVibePreviewSelectHTTPStoresElement(t *testing.T) {
	srv, _, mgr := startVibePreviewSelectTestServer(t)
	if fb, ok := mgr.browser.(*inputFakeBrowser); ok {
		fb.evalMap["elementFromPoint"] = captureJSON("button#save.btn", "button", `<button id="save" class="btn">Save</button>`)
	}
	// A preview session must exist for the project; register one directly
	// (SelectElement requires it). The URL needs a LIVE listener — the pre-probe
	// refuses ports nothing is serving.
	if _, err := mgr.Start(VibePreviewStartOpts{Project: "audit-app", TargetURL: stubTarget(t), WorkDir: "/tmp/audit-app"}); err != nil {
		t.Fatalf("start preview: %v", err)
	}

	resp, body := authedPost(t, srv.URL+"/vibing/preview/select", "test-token",
		`{"project":"audit-app","x":120,"y":60,"workDir":"/tmp/audit-app"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, body)
	}
	var out struct {
		OK      bool   `json:"ok"`
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.OK {
		t.Fatal("ok=false")
	}
	if !strings.Contains(out.Summary, "save") {
		t.Fatalf("summary = %q, want the captured element named", out.Summary)
	}

	// THE point of the route: the element must land in the SHARED store the
	// per-turn hook reads (dom_inspect_turn.go) — not some private registry.
	if _, ok := globalDomElements.Get("/tmp/audit-app", time.Now()); !ok {
		t.Fatal("element not present in globalDomElements — per-turn hook would attach nothing")
	}
	globalDomElements.Clear("/tmp/audit-app")
}

func TestVibePreviewSelectHTTPRefusesWithoutSession(t *testing.T) {
	srv, _, _ := startVibePreviewSelectTestServer(t)
	resp, body := authedPost(t, srv.URL+"/vibing/preview/select", "test-token",
		`{"project":"no-such-project","x":1,"y":1,"workDir":"/tmp/x"}`)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (no preview session); body: %s", resp.StatusCode, body)
	}
}

func TestVibePreviewSelectHTTPRequiresAuth(t *testing.T) {
	srv, _, _ := startVibePreviewSelectTestServer(t)
	resp, _ := authedPost(t, srv.URL+"/vibing/preview/select", "WRONG-TOKEN",
		`{"project":"p","x":1,"y":1,"workDir":"/tmp/x"}`)
	if resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 401/403 (owner-authenticated route)", resp.StatusCode)
	}
}

func TestVibePreviewDomModeHTTPClearsOnOff(t *testing.T) {
	srv, _, mgr := startVibePreviewSelectTestServer(t)
	if fb, ok := mgr.browser.(*inputFakeBrowser); ok {
		fb.evalMap["yaver-dom-mode"] = true
	}
	if _, err := mgr.Start(VibePreviewStartOpts{Project: "audit-app", TargetURL: stubTarget(t), WorkDir: "/tmp/audit-app"}); err != nil {
		t.Fatalf("start preview: %v", err)
	}
	now := time.Now()
	globalDomElements.Put(DomElement{WorkDir: "/tmp/audit-app", Selector: "button#save", Tag: "button"}, now)

	resp, body := authedPost(t, srv.URL+"/vibing/preview/dom-mode", "test-token",
		`{"project":"audit-app","enabled":false}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("dom-mode off status = %d, want 200 (body: %s)", resp.StatusCode, body)
	}
	if _, ok := globalDomElements.Get("/tmp/audit-app", time.Now()); ok {
		t.Fatal("dom-mode off must clear the stored element")
	}
	globalDomElements.Clear("/tmp/audit-app")
}
