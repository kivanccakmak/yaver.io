package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCachedDogfoodTokenRevalidatesRevocation(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sdk/token/validate" {
			t.Fatalf("unexpected backend path %s", r.URL.Path)
		}
		http.Error(w, `{"error":"revoked"}`, http.StatusUnauthorized)
	}))
	defer backend.Close()

	baseURL, cancel, server := startTestServerWithSDK(t, "owner-token", "dogfood-token", []string{"feedback", "blackbox"}, nil)
	defer cancel()
	server.convexURL = backend.URL
	server.tokenCache.Store("dogfood-token", &cachedTokenInfo{
		userID: "test-user-id", isSdk: true, scopes: []string{"feedback", "blackbox"},
		sourceSurface: "dogfood-installation",
	})

	status, body := doRequest(t, http.MethodPost, baseURL+"/feedback", "dogfood-token", `{"metadata":{}}`)
	if status != http.StatusForbidden {
		t.Fatalf("revoked cached Dogfood token must fail immediately, got %d (%v)", status, body)
	}
	if _, cached := server.tokenCache.Load("dogfood-token"); cached {
		t.Fatal("revoked Dogfood token remained cached")
	}
}
