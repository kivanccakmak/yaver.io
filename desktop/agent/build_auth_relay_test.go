package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Guards the 2026-07-28 audit finding: /builds was reachable UNAUTHENTICATED by
// an anonymous caller on the internet.
//
// The chain: the relay auto-publishes <deviceId>.<EXPOSE_DOMAIN> for every
// registered device pointing at the agent's control port, and its expose lane
// authenticates nobody. The relay bridge then re-issues the request against
// 127.0.0.1 stamping only X-Yaver-Via-Relay — never X-Forwarded-For. Since
// isLocalLoopbackRequest tested ONLY for X-Forwarded-For, relay traffic read as
// "genuinely local", and authBuildLocal admits local callers with no auth at
// all. handleBuilds then takes an attacker-chosen workDir and args and runs
// them through `sh -c`.
//
// To see these fail, delete the isRelayBridged check at the top of
// isLocalLoopbackRequest (httpserver.go). TestBuildAuth_RelayBridged_* both go
// red; the local-CLI case stays green, which is the point — the fix must not
// cost `yaver build` its auth-free local path.

// relayBridgedRequest mirrors exactly what main.go's relay bridge constructs:
// a request aimed at loopback, carrying the relay marker, with NO
// X-Forwarded-For and NO Authorization.
func relayBridgedRequest(path string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, path, nil)
	r.RemoteAddr = "127.0.0.1:54321"
	r.Header.Set("X-Yaver-Via-Relay", "1")
	return r
}

func TestIsLocalLoopbackRequest_RelayBridgedIsNotLocal(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*http.Request)
		want bool
	}{
		{
			name: "relay-bridged loopback is NOT local",
			mut:  func(r *http.Request) { r.Header.Set("X-Yaver-Via-Relay", "1") },
			want: false,
		},
		{
			name: "genuine local CLI is local",
			mut:  func(*http.Request) {},
			want: true,
		},
		{
			name: "cloudflared hop is NOT local",
			mut:  func(r *http.Request) { r.Header.Set("X-Forwarded-For", "203.0.113.7") },
			want: false,
		},
		{
			name: "relay marker wins even alongside X-Forwarded-For",
			mut: func(r *http.Request) {
				r.Header.Set("X-Yaver-Via-Relay", "1")
				r.Header.Set("X-Forwarded-For", "203.0.113.7")
			},
			want: false,
		},
		{
			name: "non-loopback RemoteAddr is NOT local",
			mut:  func(r *http.Request) { r.RemoteAddr = "203.0.113.7:443" },
			want: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/builds", nil)
			r.RemoteAddr = "127.0.0.1:54321"
			tc.mut(r)
			if got := isLocalLoopbackRequest(r); got != tc.want {
				t.Fatalf("isLocalLoopbackRequest = %v, want %v", got, tc.want)
			}
		})
	}
}

// The predicate is only half the story — this asserts the actual middleware
// that gates /builds refuses to run the handler for relay traffic.
func TestBuildAuth_RelayBridged_RequiresAuth(t *testing.T) {
	srv := &HTTPServer{token: "owner-token"}

	called := false
	h := srv.authBuildLocal(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})

	rec := httptest.NewRecorder()
	h(rec, relayBridgedRequest("/builds"))

	if called {
		t.Fatal("handleBuilds ran for an UNAUTHENTICATED relay-bridged request — " +
			"this is remote code execution: workDir and args reach `sh -c`")
	}
	if rec.Code == http.StatusOK {
		t.Fatalf("relay-bridged /builds returned 200 without auth (code=%d)", rec.Code)
	}
}

// The fix must not break the reason authBuildLocal exists: `yaver build` on the
// box must keep working whether or not the daemon holds a valid auth token.
func TestBuildAuth_GenuineLocalCLI_StillAuthFree(t *testing.T) {
	srv := &HTTPServer{token: "owner-token"}

	called := false
	h := srv.authBuildLocal(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})

	r := httptest.NewRequest(http.MethodPost, "/builds", nil)
	r.RemoteAddr = "127.0.0.1:54321" // straight to the daemon, no proxy, no relay

	rec := httptest.NewRecorder()
	h(rec, r)

	if !called {
		t.Fatalf("local `yaver build` was refused (code=%d) — the guard is too broad", rec.Code)
	}
}

// An authenticated relay caller must still be able to build; the fix demotes
// relay traffic to the normal auth path, it does not block the lane.
func TestBuildAuth_RelayBridged_WithTokenSucceeds(t *testing.T) {
	srv := &HTTPServer{token: "owner-token"}

	called := false
	h := srv.authBuildLocal(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})

	r := relayBridgedRequest("/builds")
	r.Header.Set("Authorization", "Bearer owner-token")

	rec := httptest.NewRecorder()
	h(rec, r)

	if !called {
		t.Fatalf("authenticated relay build was refused (code=%d)", rec.Code)
	}
}
