package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// withoutToolOnPath shadows a binary for the duration of a test by pointing
// HOME and PATH at empty directories. Probing "is flutter installed" goes
// through lookPathWithRuntimes (runtime bin dirs, then exec.LookPath), so both
// have to be emptied — emptying only PATH left the agent-installed SDK root
// visible and the gate never fired.
func withoutToolOnPath(t *testing.T) {
	t.Helper()
	empty := t.TempDir()
	t.Setenv("HOME", empty)
	t.Setenv("PATH", empty)
}

func flutterProjectDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pubspec.yaml"), []byte("name: demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// THE HEADLINE: /dev/start must stop answering 200 OK on a start it already
// knows is doomed. A pubspec-only project never reaches the package.json
// preflight, so before this the ONLY answer was 200 + a spinner.
func TestDevStartRefusesAFlutterStartWhenFlutterIsMissing(t *testing.T) {
	withoutToolOnPath(t)
	if commandExists("flutter") {
		t.Skip("flutter still resolves under the shadowed PATH; the gate cannot be exercised here")
	}

	body, _ := json.Marshal(map[string]interface{}{
		"framework": "flutter",
		"workDir":   flutterProjectDir(t),
		"platform":  "web",
		"caller":    "web-ui",
	})
	req := httptest.NewRequest(http.MethodPost, "/dev/start", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	srv := &HTTPServer{devServerMgr: NewDevServerManager()}
	srv.handleDevServerStart(rec, req)

	if rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("status = %d, want 412 — a 200 here is the doomed start that renders as a spinner (body: %s)",
			rec.Code, rec.Body.String())
	}

	var payload struct {
		Error           string         `json:"error"`
		MissingTools    []string       `json:"missingTools"`
		InstallEndpoint string         `json:"installEndpoint"`
		Installable     bool           `json:"installable"`
		HelpHint        string         `json:"helpHint"`
		CapabilityGap   *CapabilityGap `json:"capabilityGap"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("refusal must be structured JSON: %v (%s)", err, rec.Body.String())
	}

	// Legacy keys — every shipped client already branches on these, and the
	// mobile Install button lights up for Flutter the moment they are present.
	if len(payload.MissingTools) != 1 || payload.MissingTools[0] != "flutter" {
		t.Errorf("missingTools = %v, want [flutter]", payload.MissingTools)
	}
	if payload.InstallEndpoint != "/install/flutter" || !payload.Installable {
		t.Errorf("installEndpoint=%q installable=%v, want /install/flutter true", payload.InstallEndpoint, payload.Installable)
	}
	if !strings.Contains(payload.HelpHint, "/streams/install:flutter") {
		t.Errorf("helpHint must name the real stream path, got %q", payload.HelpHint)
	}

	// The typed route.
	if payload.CapabilityGap == nil {
		t.Fatal("capabilityGap missing — the whole point is a client that need not parse prose")
	}
	if payload.CapabilityGap.Code != ReasonCapabilityToolchainMissing {
		t.Errorf("gap code = %q", payload.CapabilityGap.Code)
	}
	if payload.CapabilityGap.Summary != "Flutter isn't installed on this machine." {
		t.Errorf("gap summary = %q", payload.CapabilityGap.Summary)
	}
	if payload.CapabilityGap.Fix == nil || payload.CapabilityGap.Fix.Path != "/install/flutter" {
		t.Fatalf("gap fix = %+v, want POST /install/flutter", payload.CapabilityGap.Fix)
	}
	if payload.CapabilityGap.Fix.Stream != "install:flutter" {
		t.Errorf("gap fix stream = %q", payload.CapabilityGap.Fix.Stream)
	}
	// The error line the OLD clients render must itself be the named sentence,
	// not "executable file not found in $PATH".
	if payload.Error != payload.CapabilityGap.Summary {
		t.Errorf("error line %q should be the named sentence %q", payload.Error, payload.CapabilityGap.Summary)
	}
}

// PROOF BY BREAKING, mechanised: with the toolchain PRESENT the gate must not
// fire, or every Flutter start on a healthy box would be refused. Wrong in
// this direction is just as much a defect as the spinner.
func TestDevStartDoesNotRefuseWhenTheToolchainIsPresent(t *testing.T) {
	dir := flutterProjectDir(t)
	// Put a fake `flutter` on PATH so commandExists resolves.
	binDir := t.TempDir()
	fake := filepath.Join(binDir, "flutter")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", binDir)
	if !commandExists("flutter") {
		t.Skip("could not stage a fake flutter on PATH")
	}

	body, _ := json.Marshal(map[string]interface{}{"framework": "flutter", "workDir": dir, "platform": "web", "caller": "web-ui"})
	req := httptest.NewRequest(http.MethodPost, "/dev/start", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	srv := &HTTPServer{devServerMgr: NewDevServerManager()}
	srv.handleDevServerStart(rec, req)

	if rec.Code == http.StatusPreconditionFailed {
		t.Fatalf("a box WITH flutter must not be refused: %s", rec.Body.String())
	}
	srv.devServerMgr.Stop()
}

// The gap must ride the SSE channel too — that is the carrier for the failure
// no 412 can catch, because mgr.Start returns before the process is spawned.
func TestDevServerEventCarriesTheGapOnTheWire(t *testing.T) {
	gap := DetectCapabilityGap(CapabilityGapContext{Framework: "flutter", MissingTools: []string{"flutter"}})
	raw, err := json.Marshal(DevServerEvent{Type: "error", Framework: "flutter", Message: "boom", Gap: gap})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	g, ok := decoded["gap"].(map[string]interface{})
	if !ok {
		t.Fatalf("DevServerEvent must serialize `gap`: %s", raw)
	}
	if g["code"] != ReasonCapabilityToolchainMissing {
		t.Errorf("gap.code = %v", g["code"])
	}
	// And absent (not null) on every non-gap event, so existing consumers see
	// exactly the bytes they saw before.
	plain, _ := json.Marshal(DevServerEvent{Type: "log", LogLine: "hello"})
	if strings.Contains(string(plain), "\"gap\"") {
		t.Errorf("non-gap events must not carry the key: %s", plain)
	}
}

// /dev/status carries the same object, for the surface whose SSE is closed at
// exactly the moment the gap is produced (DevPreview gates on running||building).
func TestDevServerStatusCarriesTheGap(t *testing.T) {
	raw, _ := json.Marshal(DevServerStatus{
		Framework:     "flutter",
		Error:         "boom",
		CapabilityGap: DetectCapabilityGap(CapabilityGapContext{MissingTools: []string{"flutter"}}),
	})
	if !strings.Contains(string(raw), `"capabilityGap"`) {
		t.Fatalf("status must carry capabilityGap: %s", raw)
	}
	plain, _ := json.Marshal(DevServerStatus{Framework: "expo", Running: true})
	if strings.Contains(string(plain), "capabilityGap") {
		t.Errorf("healthy status must not carry the key: %s", plain)
	}
}

// THE ASYNCHRONOUS CASE — the one no 412 can catch. mgr.Start returns before
// the process is spawned, so this failure arrives on /dev/events only. Drive
// the real manager against a real (missing) toolchain and assert the error
// frame carries the route, not just prose.
func TestAsyncStartFailureEmitsTheGapOnTheEventStream(t *testing.T) {
	withoutToolOnPath(t)
	if commandExists("flutter") {
		t.Skip("flutter still resolves under the shadowed PATH")
	}
	mgr := NewDevServerManager()
	defer mgr.Stop()
	ch := mgr.SubscribeFresh()
	defer mgr.Unsubscribe(ch)

	if err := mgr.Start("flutter", flutterProjectDir(t), "web", 0, DevServerTarget{}); err != nil {
		t.Fatalf("Start must return nil — it returns BEFORE the spawn: %v", err)
	}

	deadline := time.After(30 * time.Second)
	for {
		select {
		case ev := <-ch:
			if ev.Type != "error" {
				continue
			}
			if ev.Gap == nil {
				t.Fatalf("the error frame dropped the route again: %q", ev.Message)
			}
			if ev.Gap.Code != ReasonCapabilityToolchainMissing || ev.Gap.Fix == nil ||
				ev.Gap.Fix.Path != "/install/flutter" || ev.Gap.Fix.Stream != "install:flutter" {
				t.Fatalf("gap = %+v fix = %+v", ev.Gap, ev.Gap.Fix)
			}
			// And the status poll agrees, for the surface whose stream is closed.
			st := mgr.Status()
			if st == nil || st.CapabilityGap == nil {
				t.Fatalf("/dev/status must carry the same gap, got %+v", st)
			}
			return
		case <-deadline:
			t.Fatal("no error event within 30s")
		}
	}
}
