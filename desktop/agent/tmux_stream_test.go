package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseTmuxStreamTarget(t *testing.T) {
	cases := []struct {
		path string
		want streamTarget
	}{
		{"/tmux/stream", streamTarget{all: true}},
		{"/tmux/stream?all=true", streamTarget{all: true}},
		{"/tmux/stream?session=runner-one", streamTarget{sessionName: "runner-one"}},
		{"/tmux/stream?pane=%2537", streamTarget{paneID: "%37"}},
	}
	for _, tc := range cases {
		got := parseTmuxStreamTarget(httptest.NewRequest(http.MethodGet, tc.path, nil))
		if got != tc.want {
			t.Errorf("%s: got %+v, want %+v", tc.path, got, tc.want)
		}
	}
}

func TestPaneStreamSigCoversEveryPaintedState(t *testing.T) {
	base := VibePane{
		PaneID: "%1", SessionName: "runner-one", Agent: "codex", Model: "m1",
		Status: VibeStatusAwaiting, StatusReason: "waiting", Title: "agent",
		Options: []string{"1. Yes"}, Preview: "prompt",
	}
	baseSig := paneStreamSig(base)
	mutations := []struct {
		name string
		edit func(*VibePane)
	}{
		{"status", func(p *VibePane) { p.Status = VibeStatusWorking }},
		{"reason", func(p *VibePane) { p.StatusReason = "different" }},
		{"agent", func(p *VibePane) { p.Agent = "claude" }},
		{"model", func(p *VibePane) { p.Model = "m2" }},
		{"session", func(p *VibePane) { p.SessionName = "runner-two" }},
		{"pane", func(p *VibePane) { p.PaneID = "%2" }},
		{"title", func(p *VibePane) { p.Title = "different" }},
		{"options", func(p *VibePane) { p.Options = []string{"1. No"} }},
		{"preview", func(p *VibePane) { p.Preview = "changed" }},
	}
	for _, mutation := range mutations {
		p := base
		p.Options = append([]string(nil), base.Options...)
		mutation.edit(&p)
		if got := paneStreamSig(p); got == baseSig {
			t.Errorf("%s changed but stream signature did not", mutation.name)
		}
	}

	// Idle age changes on every poll but is not a meaningful frame by itself.
	idle := base
	idle.IdleMs++
	if got := paneStreamSig(idle); got != baseSig {
		t.Fatal("idle age alone must not turn SSE into polling traffic")
	}
}

func TestTmuxStreamMissingTargetSendsDoneAndCloses(t *testing.T) {
	isolateSessionIntentTmux(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/tmux/stream?session=missing", nil)
	(&HTTPServer{}).handleTmuxStream(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "event: done") || !strings.Contains(body, "target session or pane is not live") {
		t.Fatalf("missing target did not terminate with a named reason: %s", body)
	}
}

func TestTmuxStreamEmptyAllModeSendsInitialSnapshot(t *testing.T) {
	isolateSessionIntentTmux(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/tmux/stream?all=1", nil).WithContext(ctx)
	(&HTTPServer{}).handleTmuxStream(rec, req)
	if body := rec.Body.String(); !strings.Contains(body, "event: pane\ndata: null") {
		t.Fatalf("empty all-mode subscriber received no initial snapshot: %s", body)
	}
}
