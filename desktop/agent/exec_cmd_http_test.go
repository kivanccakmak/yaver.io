package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Regression: a stale CLI polled an expired exec ID three times per second for
// more than six hours because execHTTP discarded HTTP 404 and runExec treated
// the missing `exec` object as a reason to retry forever.
func TestExecHTTPReturnsStatusErrorForExpiredSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"ok":false,"error":"exec session not found"}`))
	}))
	defer server.Close()

	_, err := execHTTP(http.MethodGet, server.URL+"/exec/expired", "token", nil)
	var statusErr *execHTTPStatusError
	if !errors.As(err, &statusErr) {
		t.Fatalf("execHTTP error = %v, want *execHTTPStatusError", err)
	}
	if statusErr.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", statusErr.StatusCode, http.StatusNotFound)
	}
	if statusErr.Message != "exec session not found" {
		t.Fatalf("message = %q", statusErr.Message)
	}
}
