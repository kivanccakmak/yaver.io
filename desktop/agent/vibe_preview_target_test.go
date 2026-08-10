package main

// vibe_preview_target_test.go — the connect-green-but-vibe-dead class.
//
// THE INCIDENT (2026-08-10, ubuntu-4gb-hel1-1): the device card said
// "Connected · Public endpoint" while /dev/status answered serving:false, and
// a vibe start navigated Chrome to a port with no listener. The refusal was
// the bare chromedp sentence
//   navigate to http://127.0.0.1:3000: ... net::ERR_CONNECTION_REFUSED
// with NO code and NO route — no button existed to start the dev server that
// /dev/start already knows how to launch.
//
// These tests pin the fix: a targetUrl that refuses connections is refused in
// milliseconds with a TYPED PreviewTargetUnreachableError, the browser is never
// opened (the probe is the gate), and the HTTP layer turns it into a
// CapabilityGap whose /dev/start route is pre-filled and invocable.
//
// Prove-by-breaking: comment out the probeTargetURL call in
// VibePreviewManager.Start and TestStart_refusedTarget_neverOpensBrowser fails
// (the fake browser records an open that the probe was supposed to prevent).

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestProbeTargetURL_refusedVsOpen proves the probe distinguishes a port with
// a listener from a port with none — the operation, not the inventory.
func TestProbeTargetURL_refusedVsOpen(t *testing.T) {
	mgr := NewVibePreviewManager(newFakeBrowser())
	if mgr == nil {
		t.Fatal("nil manager")
	}

	// Open a listener on an ephemeral port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	openAddr := ln.Addr().String()
	// Close it so the port is refused.
	refusedAddr := openAddr
	_ = ln.Close()

	// Give the OS a moment to release the port; use a fresh listener instead
	// for the "open" case to avoid a TIME_WAIT race.
	ln2, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen2: %v", err)
	}
	defer ln2.Close()
	openAddr = ln2.Addr().String()

	if err := mgr.probeTargetURL("http://" + openAddr); err != nil {
		t.Fatalf("open port %s should probe OK, got %v", openAddr, err)
	}
	if err := mgr.probeTargetURL("http://" + refusedAddr); err == nil {
		t.Fatalf("refused port %s should fail the probe", refusedAddr)
	}
}

// TestStart_refusedTarget_neverOpensBrowser: the pre-probe is the gate — a
// refused target must produce the typed error WITHOUT opening a browser
// session (Chrome would otherwise hang ~30s and fail with a bare sentence).
func TestStart_refusedTarget_neverOpensBrowser(t *testing.T) {
	// Reserve a port then close it → guaranteed refused.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	fb := newFakeBrowser(genFrames(2)...)
	mgr := NewVibePreviewManager(fb)
	_, err = mgr.Start(VibePreviewStartOpts{
		Project:   "refused-proj",
		TargetURL: "http://" + addr,
		WorkDir:   "/tmp/proj",
		Framework: "nextjs",
	})
	if err == nil {
		t.Fatal("expected error for refused target")
	}
	var unreachable *PreviewTargetUnreachableError
	if !errors.As(err, &unreachable) {
		t.Fatalf("expected PreviewTargetUnreachableError, got %T: %v", err, err)
	}
	if unreachable.TargetURL != "http://"+addr {
		t.Errorf("error must carry the refused URL, got %q", unreachable.TargetURL)
	}
	if unreachable.WorkDir != "/tmp/proj" || unreachable.Framework != "nextjs" {
		t.Errorf("error must carry workDir/framework for the gap body, got %+v", unreachable)
	}
	fb.mu.Lock()
	opens := fb.opens
	fb.mu.Unlock()
	if opens != 0 {
		t.Fatalf("browser must NOT be opened for a refused target (opens=%d); the probe is the gate", opens)
	}
}

// TestStart_navigateRefused_alsoTyped: if the probe passes (dev server was up)
// but the navigate still hits a refused connection (server died between probe
// and navigate), the failure is classified as the same typed error, never the
// raw chromedp sentence.
func TestStart_navigateRefused_alsoTyped(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	defer ln.Close()

	fb := newFakeBrowser(genFrames(2)...)
	fb.navErr = errors.New("navigate to x: net::ERR_CONNECTION_REFUSED")
	mgr := NewVibePreviewManager(fb)
	_, err = mgr.Start(VibePreviewStartOpts{
		Project:   "nav-refused",
		TargetURL: "http://" + addr,
	})
	if err == nil {
		t.Fatal("expected error")
	}
	var unreachable *PreviewTargetUnreachableError
	if !errors.As(err, &unreachable) {
		t.Fatalf("navigate refusal must classify as PreviewTargetUnreachableError, got %T: %v", err, err)
	}
}

// TestPreviewTargetUnreachableGap_routeIsInvocable: the HTTP refusal carries a
// pre-filled /dev/start route, a stream, and Retry — a button, not a sentence.
func TestPreviewTargetUnreachableGap_routeIsInvocable(t *testing.T) {
	unreachable := &PreviewTargetUnreachableError{
		TargetURL: "http://127.0.0.1:3000",
		Project:   "medici-landing",
		WorkDir:   "/root/Workspace/medici-landing",
		Framework: "nextjs",
	}
	gap := previewTargetUnreachableGap(unreachable)
	if gap == nil {
		t.Fatal("nil gap")
	}
	if gap.Code != ReasonPreviewTargetUnreachable {
		t.Fatalf("code: want %s got %s", ReasonPreviewTargetUnreachable, gap.Code)
	}
	if gap.Fix == nil {
		t.Fatal("target-unreachable must ALWAYS have a fix (dev server start)")
	}
	if gap.Fix.Method != "POST" || gap.Fix.Path != "/dev/start" {
		t.Fatalf("fix route: want POST /dev/start got %s %s", gap.Fix.Method, gap.Fix.Path)
	}
	if gap.Fix.Stream == "" {
		t.Error("dev-server start must stream (the user should watch it boot)")
	}
	if !gap.Fix.Retry {
		t.Error("retry must be set so the preview start re-issues after the dev server boots")
	}
	body, _ := gap.Fix.Body["workDir"].(string)
	if body != "/root/Workspace/medici-landing" {
		t.Errorf("body must pre-fill workDir, got %q", body)
	}
	if b, _ := gap.Fix.Body["framework"].(string); b != "nextjs" {
		t.Errorf("body must pre-fill framework, got %q", b)
	}
	if b, _ := gap.Fix.Body["projectName"].(string); b != "medici-landing" {
		t.Errorf("body must pre-fill projectName, got %q", b)
	}
}

// TestVibePreviewStartHTTP_refusedTarget_424WithGap: the HTTP layer returns
// 424 Failed Dependency + the typed gap (code + fix), not a bare 400 prose.
func TestVibePreviewStartHTTP_refusedTarget_424WithGap(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	fb := newFakeBrowser(genFrames(2)...)
	mgr := NewVibePreviewManager(fb)
	srv := &HTTPServer{vibePreviewMgr: mgr}

	body := strings.NewReader(`{"project":"medici-landing","targetUrl":"http://` + addr + `","workDir":"/root/Workspace/medici-landing","framework":"nextjs"}`)
	req := httptest.NewRequest(http.MethodPost, "/vibing/preview/start", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.handleVibePreviewStart(rec, req)

	if rec.Code != http.StatusFailedDependency {
		t.Fatalf("status: want 424 got %d (body %s)", rec.Code, rec.Body.String())
	}
	var resp struct {
		OK           bool           `json:"ok"`
		Code         string         `json:"code"`
		Error        string         `json:"error"`
		CapabilityGap *CapabilityGap `json:"capabilityGap"`
	}
	if err := jsonUnmarshalStrict(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, rec.Body.String())
	}
	if resp.Code != ReasonPreviewTargetUnreachable {
		t.Fatalf("code: want %s got %q", ReasonPreviewTargetUnreachable, resp.Code)
	}
	if resp.CapabilityGap == nil || resp.CapabilityGap.Fix == nil || resp.CapabilityGap.Fix.Path != "/dev/start" {
		t.Fatalf("response must carry the /dev/start gap, got %+v", resp.CapabilityGap)
	}
}

// jsonUnmarshalStrict is a tiny helper so the test file needs no extra import
// ceremony; json.Unmarshal with error surfaced.
func jsonUnmarshalStrict(b []byte, v interface{}) error {
	dec := json.NewDecoder(strings.NewReader(string(b)))
	return dec.Decode(v)
}
