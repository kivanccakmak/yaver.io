package main

// vibe_preview_select_test.go — the tvOS "kumanda" DOM selection + DOM-mode
// toggle, proven against a fake browser that speaks Evaluate/DispatchMouse.
//
// These tests are the parity guard for the tvOS surface contract: the TV sends
// {project, x, y, workDir} and the agent must (a) dispatch a REAL click at
// that viewport coordinate, (b) capture the element at the point, (c) store it
// under the project's workDir so the per-turn hook attaches it to the next
// prompt, and (d) on dom-mode off, hold NOTHING (the Browse|Inspect contract).

import (
	"encoding/json"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// inputFakeBrowser is fakeBrowser plus the vibePreviewInputBrowser half: it
// records dispatched mouse actions and answers Evaluate from a programmable
// JS-substring → result map (the select script interpolates coordinates and
// the shot script contains "Promise", so the test can distinguish calls).
type inputFakeBrowser struct {
	*fakeBrowser
	mu        sync.Mutex
	moves     []string // "x,y" of every DispatchMouse
	clicks    int      // count of click=true dispatches
	evalCalls int
	evalMap   map[string]interface{} // js substring → result (first match wins)
	shotOut   interface{}            // returned for any script containing "Promise"
}

func newInputFakeBrowser() *inputFakeBrowser {
	return &inputFakeBrowser{
		fakeBrowser: newFakeBrowser(),
		evalMap:     map[string]interface{}{},
	}
}

func (f *inputFakeBrowser) DispatchMouse(id string, x, y int, click bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.moves = append(f.moves, strconv.Itoa(x)+","+strconv.Itoa(y))
	if click {
		f.clicks++
	}
	return nil
}

func (f *inputFakeBrowser) Evaluate(id, js string) (interface{}, error) {
	f.mu.Lock()
	f.evalCalls++
	f.mu.Unlock()
	if strings.Contains(js, "Promise") {
		return f.shotOut, nil
	}
	for sub, res := range f.evalMap {
		if strings.Contains(js, sub) {
			return res, nil
		}
	}
	return `{"ok":false,"error":"no script matched"}`, nil
}

// stubTarget serves a TCP listener that accepts+closes, so the manager's
// pre-probe (probeTargetURL — "a port must be LISTENING, not just a device
// online") passes while the fake browser does the rest.
func stubTarget(t *testing.T) string {
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

// captureJSON builds the JSON string a real page would return for an element.
func captureJSON(selector, tag, html string) string {
	el := map[string]interface{}{
		"selector": selector,
		"tag":      tag,
		"id":       "",
		"classes":  "",
		"text":     "Save",
		"html":     html,
		"css":      "display: block",
		"rect":     "x:10 y:20 w:100 h:30",
	}
	payload := map[string]interface{}{"ok": true, "el": el}
	b, _ := json.Marshal(payload)
	return string(b)
}

func TestVibePreviewSelectElement(t *testing.T) {
	mgr := NewVibePreviewManager(newInputFakeBrowser())
	now := time.Date(2026, 8, 12, 12, 0, 0, 0, time.UTC)

	if _, err := mgr.Start(VibePreviewStartOpts{
		Project:   "todo-web",
		TargetURL: stubTarget(t),
		WorkDir:   "/home/u/todo-web",
	}); err != nil {
		t.Fatalf("Start: %v", err)
	}

	fb := mgr.browser.(*inputFakeBrowser)
	fb.evalMap["elementFromPoint"] = captureJSON("button#save.btn", "button", `<button id="save" class="btn">Save</button>`)
	fb.shotOut = "data:image/jpeg;base64,xx"

	d, err := mgr.SelectElement("todo-web", 50, 40, "", now)
	if err != nil {
		t.Fatalf("SelectElement: %v", err)
	}
	if d.Selector != "button#save.btn" {
		t.Errorf("selector = %q, want button#save.btn", d.Selector)
	}
	if d.WorkDir != "/home/u/todo-web" {
		t.Errorf("workDir = %q, want session workDir fallback", d.WorkDir)
	}
	if d.Lane != "browser" {
		t.Errorf("lane = %q, want browser", d.Lane)
	}
	if len(fb.moves) != 1 || fb.moves[0] != "50,40" {
		t.Errorf("dispatched mouse = %v, want [50,40]", fb.moves)
	}
	if fb.clicks != 1 {
		t.Errorf("clicks = %d, want 1", fb.clicks)
	}
	// The selection must be readable back through the SHARED store, keyed by
	// the same workDir the task turns use — that is what makes "deep audit
	// this element" from the couch actually deliver the element.
	got, ok := globalDomElements.Get("/home/u/todo-web", now.Add(1*time.Minute))
	if !ok || got.Selector != "button#save.btn" {
		t.Errorf("store read-back: ok=%v selector=%q", ok, got.Selector)
	}
	globalDomElements.Clear("/home/u/todo-web")
}

func TestVibePreviewSelect_EmptyWorkDirRefused(t *testing.T) {
	mgr := NewVibePreviewManager(newInputFakeBrowser())
	if _, err := mgr.Start(VibePreviewStartOpts{Project: "p", TargetURL: stubTarget(t)}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := mgr.SelectElement("p", 10, 10, "", time.Now()); err == nil {
		t.Fatal("SelectElement with no workDir anywhere: want error, got nil")
	}
}

func TestVibePreviewSelect_NoSession(t *testing.T) {
	mgr := NewVibePreviewManager(newInputFakeBrowser())
	if _, err := mgr.SelectElement("nope", 1, 1, "/tmp/x", time.Now()); err == nil || !strings.Contains(err.Error(), "no preview session") {
		t.Fatalf("want 'no preview session' error, got %v", err)
	}
}

func TestVibePreviewSelect_BrowserCannotInput(t *testing.T) {
	// A plain fakeBrowser implements only the capture getter — no Evaluate /
	// DispatchMouse — so the manager must name the capability gap by type.
	mgr := NewVibePreviewManager(newFakeBrowser())
	if _, err := mgr.Start(VibePreviewStartOpts{Project: "p", TargetURL: stubTarget(t), WorkDir: "/w"}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := mgr.SelectElement("p", 5, 5, "/w", time.Now()); err == nil || !strings.Contains(err.Error(), "cannot dispatch input") {
		t.Fatalf("want 'cannot dispatch input', got %v", err)
	}
}

func TestVibePreviewMoveCursor(t *testing.T) {
	mgr := NewVibePreviewManager(newInputFakeBrowser())
	if _, err := mgr.Start(VibePreviewStartOpts{Project: "p", TargetURL: stubTarget(t), WorkDir: "/w"}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	fb := mgr.browser.(*inputFakeBrowser)
	if err := mgr.MoveCursor("p", 30, 45); err != nil {
		t.Fatalf("MoveCursor: %v", err)
	}
	if len(fb.moves) != 1 || fb.moves[0] != "30,45" {
		t.Fatalf("moves = %v, want [30,45]", fb.moves)
	}
	if fb.clicks != 0 {
		t.Fatal("MoveCursor must not click")
	}
	// A hover is NOT a selection: the shared store must hold nothing.
	if _, ok := globalDomElements.Get("/w", time.Now()); ok {
		t.Fatal("MoveCursor stored an element — a hover must never ride a prompt")
	}
}

func TestVibePreviewSetDomMode(t *testing.T) {
	mgr := NewVibePreviewManager(newInputFakeBrowser())
	now := time.Now()
	if _, err := mgr.Start(VibePreviewStartOpts{Project: "p", TargetURL: stubTarget(t), WorkDir: "/w"}); err != nil {
		t.Fatalf("Start: %v", err)
	}
	fb := mgr.browser.(*inputFakeBrowser)
	fb.evalMap["yaver-dom-mode"] = true

	// Put an element in the store first; disabling DOM mode must clear it (the
	// "off means the agent holds nothing" contract).
	globalDomElements.Put(DomElement{WorkDir: "/w", Selector: "button#save", Tag: "button"}, now)
	wd, err := mgr.SetDomMode("p", true, "")
	if err != nil {
		t.Fatalf("SetDomMode(true): %v", err)
	}
	if wd != "/w" {
		t.Errorf("workDir = %q, want session fallback /w", wd)
	}
	if fb.evalCalls == 0 {
		t.Fatal("dom-mode enable did not reach the page")
	}
	if _, ok := globalDomElements.Get("/w", now.Add(30*time.Second)); !ok {
		t.Fatal("element should still be held while DOM mode is ON")
	}
	if _, err := mgr.SetDomMode("p", false, ""); err != nil {
		t.Fatalf("SetDomMode(false): %v", err)
	}
	if _, ok := globalDomElements.Get("/w", now.Add(30*time.Second)); ok {
		t.Fatal("element must be cleared when DOM mode is turned OFF")
	}
	globalDomElements.Clear("/w")
}
