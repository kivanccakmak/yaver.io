package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandleTmuxReconcileRequiresPOST(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	s := NewHTTPServer(0, "tok", "owner", "dev", "", "host", tm)

	req := httptest.NewRequest(http.MethodGet, "/tmux/reconcile", nil)
	rec := httptest.NewRecorder()
	s.handleTmuxReconcile(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestHandleTmuxReconcileWithoutTmux(t *testing.T) {
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	tm.TmuxMgr = nil
	s := NewHTTPServer(0, "tok", "owner", "dev", "", "host", tm)

	req := httptest.NewRequest(http.MethodPost, "/tmux/reconcile", strings.NewReader(""))
	rec := httptest.NewRecorder()
	s.handleTmuxReconcile(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
	if !strings.Contains(rec.Body.String(), "tmux not available") {
		t.Fatalf("body = %q, want tmux-not-available error", rec.Body.String())
	}
}
