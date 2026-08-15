package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDevReadinessDoesNotFollowApplicationRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", "https://127.0.0.1:1/not-a-readiness-target")
		w.WriteHeader(http.StatusPermanentRedirect)
	}))
	defer server.Close()

	resp, err := devReadinessHTTPClient.Get(server.URL)
	if err != nil {
		t.Fatalf("a redirect response still proves the dev port is listening: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPermanentRedirect {
		t.Fatalf("status = %d, want original 308 (redirect must not be followed)", resp.StatusCode)
	}
}
