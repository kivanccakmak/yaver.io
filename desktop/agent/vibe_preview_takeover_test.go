package main

// vibe_preview_takeover_test.go — the preview lock must refuse with a ROUTE.
//
// Each test here pins one layer of the failure that shipped on 2026-08-03,
// where tvOS and visionOS both rendered "Preview unavailable · … already
// active; stop it first" over a **Try again** button that could not succeed
// while the lock was held:
//
//	B SIGNAL — the refusal is a TYPED error carrying the holder, and the status
//	           code is chosen by errors.As, never by matching the agent's own
//	           sentence.
//	C UI     — the 409 body carries `code` and a `capabilityGap` whose summary
//	           names the surface holding the preview.
//	D ROUTE  — the gap's fix is POST /vibing/preview/stop, WITH the body the
//	           endpoint requires, marked instant + retry so every surface
//	           renders one tap and suppresses the dead retry.
//
// The negative controls matter as much as the positives: a gap that sets
// Constraint, or a fix with no Body, would each look structured in review and
// still leave the user pressing something that cannot work.

import (
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// testListenerURL returns a live 127.0.0.1 listener URL for tests that must
// START a preview. Since vibe_preview.go's probeTargetURL gate, "the device is
// connected" is no longer enough — something must actually be LISTENING at the
// targetUrl, or Start refuses with PreviewTargetUnreachableError before the
// behaviour under test runs. The listener accepts-and-closes so a probe's TCP
// handshake succeeds.
func testListenerURL(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, aerr := ln.Accept()
			if aerr != nil {
				return
			}
			_ = c.Close()
		}
	}()
	return "http://" + ln.Addr().String()
}

func startTakeoverTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	hs := NewHTTPServer(0, "test-token", "test-user", "test-device", "", "test-host", tm)
	hs.browserMgr = NewBrowserManager()
	hs.vibePreviewMgr = NewVibePreviewManager(hs.browserMgr)
	hs.vibePreviewMgr.SetDiskRoot(t.TempDir())

	mux := http.NewServeMux()
	mux.HandleFunc("/vibing/preview/start", hs.auth(hs.handleVibePreviewStart))
	mux.HandleFunc("/vibing/preview/stop", hs.auth(hs.handleVibePreviewStop))

	srv := httptest.NewServer(mux)
	t.Cleanup(func() {
		hs.vibePreviewMgr.StopAll()
		hs.browserMgr.Stop()
		srv.Close()
	})
	return srv
}

// TestPreviewLock_IsTypedNotProse — layer B. The manager must hand back a typed
// error carrying the session that holds the lock, not a sentence a caller has
// to parse.
func TestPreviewLock_IsTypedNotProse(t *testing.T) {
	mgr := NewVibePreviewManager(newFakeBrowser(genFrames(4)...))
	mgr.SetDiskRoot(t.TempDir())
	defer mgr.StopAll()

	url := testListenerURL(t)
	if _, err := mgr.Start(VibePreviewStartOpts{
		Project: "sfmg", TargetURL: url,
		Mode: VibePreviewModeSummaryOnly, Surface: "tv",
	}); err != nil {
		t.Fatalf("first start: %v", err)
	}

	_, err := mgr.Start(VibePreviewStartOpts{
		Project: "sfmg", TargetURL: url,
		Mode: VibePreviewModeSummaryOnly, Surface: "vision",
	})
	var active *PreviewSessionActiveError
	if !errors.As(err, &active) {
		t.Fatalf("second start must return *PreviewSessionActiveError so the HTTP layer can classify without regexing prose; got %T: %v", err, err)
	}
	if active.Project != "sfmg" {
		t.Errorf("Project = %q, want sfmg", active.Project)
	}
	if active.Active == nil {
		t.Fatal("Active session is nil — the refusal cannot say what would be interrupted")
	}
	if active.Active.Surface != "tv" {
		t.Errorf("Active.Surface = %q, want tv — cloneSession must carry Surface or the holder reads as 'another surface' forever", active.Active.Surface)
	}
	// The sentence must survive intact: a shipped view that renders only the
	// message must not lose a word when typed fields arrive beside it.
	if !strings.Contains(err.Error(), "already active") {
		t.Errorf("Error() = %q, want the shipped sentence preserved", err.Error())
	}
}

// TestPreviewLock_GapIsARouteNotADeadEnd — layers C and D, on the wire.
func TestPreviewLock_GapIsARouteNotADeadEnd(t *testing.T) {
	srv := startTakeoverTestServer(t)

	// A real page to capture. Pointing at a dead port makes Chrome fail the
	// navigation, which is a DIFFERENT (and correct) 400 — the first run of this
	// test hit exactly that and would have been "fixed" by loosening the
	// assertion instead of giving the browser something to load.
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html><body style='background:#123'>sfmg</body></html>"))
	}))
	defer target.Close()

	start := func(surface string) (*http.Response, map[string]interface{}) {
		t.Helper()
		body, _ := json.Marshal(map[string]interface{}{
			"project": "sfmg", "targetUrl": target.URL, "mode": "summary-only",
		})
		req, _ := http.NewRequest("POST", srv.URL+"/vibing/preview/start", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer test-token")
		req.Header.Set("Content-Type", "application/json")
		if surface != "" {
			req.Header.Set("X-Yaver-Surface", surface)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		var parsed map[string]interface{}
		_ = json.NewDecoder(res.Body).Decode(&parsed)
		res.Body.Close()
		return res, parsed
	}

	// The TV opens it. Chrome may genuinely be absent on this machine — that is
	// the OTHER named refusal, and it is not what this test is about.
	res, first := start("tv")
	if res.StatusCode == http.StatusServiceUnavailable {
		t.Skipf("no browser on this machine — the 503 lane is covered by TestPreviewNoBrowser_OffersAnInstallRoute: %v", first["error"])
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("first start = %d, want 200: %v", res.StatusCode, first)
	}

	// The headset asks for the same project.
	res, second := start("vision")
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("second start = %d, want 409", res.StatusCode)
	}
	if got := second["code"]; got != ReasonPreviewSessionActive {
		t.Errorf("code = %v, want %q — without a top-level code every surface goes back to regexing the sentence", got, ReasonPreviewSessionActive)
	}

	rawGap, ok := second["capabilityGap"].(map[string]interface{})
	if !ok {
		t.Fatalf("409 body carries no capabilityGap — this is the dead-end-with-a-sentence the change exists to remove. body=%v", second)
	}
	summary, _ := rawGap["summary"].(string)
	if !strings.Contains(summary, "sfmg") {
		t.Errorf("summary = %q, want the project named", summary)
	}
	// The holder announced itself via X-Yaver-Surface, which tvOS already sends
	// on every request — so the refusal must name the TV, not "another surface".
	if !strings.Contains(strings.ToLower(summary), "tv") {
		t.Errorf("summary = %q, want the holding surface named (X-Yaver-Surface was 'tv')", summary)
	}
	if c, _ := rawGap["constraint"].(string); c != "" {
		t.Errorf("constraint = %q — a lock that CAN be taken over must never render as a constraint; a constrained gap is what suppresses the button", c)
	}

	fix, ok := rawGap["fix"].(map[string]interface{})
	if !ok {
		t.Fatal("gap has no fix — the refusal is a wall again")
	}
	if got, _ := fix["path"].(string); got != "/vibing/preview/stop" {
		t.Errorf("fix.path = %q, want /vibing/preview/stop (it existed the whole time)", got)
	}
	if got, _ := fix["method"].(string); got != "POST" {
		t.Errorf("fix.method = %q, want POST", got)
	}
	if fix["instant"] != true {
		t.Error("fix.instant must be true — otherwise the renderers' no-stream guard DROPS the button and the correct signal reaches no consumer")
	}
	if fix["retry"] != true {
		t.Error("fix.retry must be true — the retried start is what makes an instant fix visible")
	}
	fixBody, ok := fix["body"].(map[string]interface{})
	if !ok || fixBody["project"] != "sfmg" {
		t.Fatalf("fix.body must carry {project}: POST /vibing/preview/stop without it answers 400 'project is required', i.e. one more action that cannot succeed. got %v", fix["body"])
	}

	// PROVE THE ROUTE: invoke exactly what the gap said, with exactly the body
	// it supplied, then re-issue the original start. Asserting the fields is not
	// enough — the whole class of bug here is a remedy that names something that
	// does not work.
	stopBody, _ := json.Marshal(fixBody)
	stopReq, _ := http.NewRequest(fix["method"].(string), srv.URL+fix["path"].(string), bytes.NewReader(stopBody))
	stopReq.Header.Set("Authorization", "Bearer test-token")
	stopReq.Header.Set("Content-Type", "application/json")
	stopRes, err := http.DefaultClient.Do(stopReq)
	if err != nil {
		t.Fatalf("invoking the advertised route: %v", err)
	}
	stopRes.Body.Close()
	if stopRes.StatusCode != http.StatusOK {
		t.Fatalf("the advertised route answered %d — a gap must never advertise a remedy the product refuses", stopRes.StatusCode)
	}

	res, third := start("vision")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("after the takeover the headset's start = %d, want 200: %v", res.StatusCode, third)
	}
}

// TestPreviewNoBrowser_OffersAnInstallRoute — the sibling refusal. It used to be
// selected by matching "browser automation unavailable" against the agent's own
// string; now it is typed, and it routes through the SAME producer every other
// missing tool uses, so "no browser" gets a streamed Install button instead of a
// sentence.
func TestPreviewNoBrowser_OffersAnInstallRoute(t *testing.T) {
	mgr := NewVibePreviewManager(nil)
	_, err := mgr.Start(VibePreviewStartOpts{Project: "p", TargetURL: stubTarget(t)})

	var noBrowser *PreviewBrowserUnavailableError
	if !errors.As(err, &noBrowser) {
		t.Fatalf("want *PreviewBrowserUnavailableError, got %T: %v", err, err)
	}

	gap := previewBrowserUnavailableGap()
	if gap == nil {
		t.Fatal("no gap for a missing browser — the 503 is a dead end with a sentence")
	}
	// Exactly one of Fix / Constraint, on every platform. Which one depends on
	// whether chromium has a working recipe HERE, and both answers are correct —
	// what must never happen is neither.
	if gap.Fix == nil && strings.TrimSpace(gap.Constraint) == "" {
		t.Fatal("gap has neither Fix nor Constraint — the one shape CapabilityGap exists to make impossible")
	}
	if gap.Fix != nil {
		if !strings.HasPrefix(gap.Fix.Path, "/install/") {
			t.Errorf("Fix.Path = %q, want an /install/ route", gap.Fix.Path)
		}
		if gap.Fix.Stream == "" {
			t.Error("an install Fix must name its stream — a multi-hundred-MB download behind a silent spinner is indistinguishable from a hang")
		}
	}
}

// TestPreviewStartHandler_DoesNotProseMatch is the structural guard. errors.As
// can be reverted to strings.Contains in one line and every behavioural test
// above would still pass, because the sentences currently agree — which is
// exactly how the original defect survived.
func TestPreviewStartHandler_DoesNotProseMatch(t *testing.T) {
	src, err := os.ReadFile("vibe_preview_http.go")
	if err != nil {
		t.Fatalf("read handler source: %v", err)
	}
	// Comments are stripped first: the file DELIBERATELY quotes the removed
	// matcher to explain why it went, and a guard that cannot tell code from the
	// commentary describing its own removal fires on the fix instead of the bug.
	code := make([]string, 0, 256)
	for _, line := range strings.Split(string(src), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "//") {
			continue
		}
		code = append(code, line)
	}
	body := strings.Join(code, "\n")
	for _, banned := range []string{
		`strings.Contains(msg, "already active")`,
		`strings.Contains(msg, "browser automation unavailable")`,
	} {
		if strings.Contains(body, banned) {
			t.Errorf("vibe_preview_http.go still contains %s — the agent must not regex its own error sentence to pick a status code", banned)
		}
	}
	if !strings.Contains(body, "errors.As(err, &active)") {
		t.Error("the start handler must classify the lock refusal with errors.As")
	}
	if !strings.Contains(body, "jsonErrorWithGap(") {
		t.Error("the start handler must emit the gap — a refusal with no route is the defect")
	}
}

// TestPreviewSurfaceLabel_NeverGuesses — an unknown or absent surface must read
// "another surface". Naming the wrong device is worse than naming none: it sends
// the user to turn off a screen that is not holding anything.
func TestPreviewSurfaceLabel_NeverGuesses(t *testing.T) {
	cases := map[string]string{
		"tv":       "your TV",
		"vision":   "your headset",
		"watch":    "your watch",
		"mobile":   "your phone",
		"web":      "the web dashboard",
		"":         "another surface",
		"nonsense": "another surface",
	}
	for in, want := range cases {
		if got := previewSurfaceLabel(in); got != want {
			t.Errorf("previewSurfaceLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestShortPreviewAge(t *testing.T) {
	if got := shortPreviewAge(time.Time{}); got != "a while" {
		t.Errorf("zero time = %q, want %q", got, "a while")
	}
	if got := shortPreviewAge(time.Now().Add(-4 * time.Minute)); got != "4m" {
		t.Errorf("4 minutes ago = %q, want 4m", got)
	}
	if got := shortPreviewAge(time.Now().Add(-90 * time.Minute)); got != "1h 30m" {
		t.Errorf("90 minutes ago = %q, want 1h 30m", got)
	}
}

// TestPreviewRelease_AnswersInsteadOfMakingYouWait — the verb that replaced a
// 4-second sleep in e2e/all-surfaces-sfmg-loop.mjs.
//
// The property under test is that it reports the OPERATION (can the next caller
// claim this project?) and not the proxy (did Stop() return?). Stop() empties
// the session map synchronously, so a readiness check built only on `sessions`
// would answer "released" while a capture goroutine still held the browser
// target — the exact race the sleep was hiding.
func TestPreviewRelease_AnswersInsteadOfMakingYouWait(t *testing.T) {
	mgr := NewVibePreviewManager(newFakeBrowser(genFrames(200)...))
	mgr.SetDiskRoot(t.TempDir())
	defer mgr.StopAll()

	// Nothing running: released, with nothing to explain.
	if st := mgr.ReleaseState("sfmg"); !st.Released || len(st.Blockers) != 0 {
		t.Fatalf("idle project should be released with no blockers, got %+v", st)
	}

	// A LIVE session (fps > 0) is the case that actually starts a capture loop.
	if _, err := mgr.Start(VibePreviewStartOpts{
		Project: "sfmg", TargetURL: testListenerURL(t), Mode: VibePreviewModeLive,
		Profile: "live-relay-cell", Surface: "tv",
	}); err != nil {
		t.Fatalf("start: %v", err)
	}

	st := mgr.ReleaseState("sfmg")
	if st.Released {
		t.Fatal("a project with a live session must not report released")
	}
	if st.Holder != "tv" {
		t.Errorf("Holder = %q, want tv — a caller deciding between waiting and taking over needs to know who has it", st.Holder)
	}
	if len(st.Blockers) == 0 {
		t.Error("not-released with no blockers is a bare false; the caller cannot tell which half is holding on")
	}

	// After Stop, it must converge to released — and quickly, since the whole
	// point is to poll rather than sleep.
	if err := mgr.Stop("sfmg"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if mgr.ReleaseState("sfmg").Released {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("still not released 5s after Stop: %+v", mgr.ReleaseState("sfmg"))
}

// TestPreviewRelease_CountsTheCaptureLoopNotJustTheMap is the negative control:
// it pins that the counter is what makes the answer honest. A readiness probe
// that only reads `sessions` passes every other test in this file and still
// reintroduces the race.
func TestPreviewRelease_CountsTheCaptureLoopNotJustTheMap(t *testing.T) {
	mgr := NewVibePreviewManager(newFakeBrowser(genFrames(50)...))
	mgr.SetDiskRoot(t.TempDir())
	defer mgr.StopAll()

	// Simulate the window after Stop(): no session entry, loop still winding down.
	mgr.mu.Lock()
	mgr.liveLoops["ghost"] = 1
	mgr.mu.Unlock()

	st := mgr.ReleaseState("ghost")
	if st.Released {
		t.Fatal("a project with no session but a live capture loop must NOT report released — that is the race the 4s sleep was hiding")
	}
	if len(st.Blockers) != 1 || !strings.Contains(st.Blockers[0], "capture loop") {
		t.Errorf("blocker must name the capture loop, got %v", st.Blockers)
	}

	mgr.mu.Lock()
	delete(mgr.liveLoops, "ghost")
	mgr.mu.Unlock()
	if !mgr.ReleaseState("ghost").Released {
		t.Error("released once the loop is gone")
	}
}
