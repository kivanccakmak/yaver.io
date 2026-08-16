package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A relay-credential refusal must NEVER be reported as a reached agent.
//
// Incident (RCA 2026-07-28, defect D3): doRemoteAgentRequest returned
// (candidate, 401, body, nil) — a SUCCESS — for a relay that refused this
// client's own relay password. ping_cmd.go then set Reachable = true for any
// HTTPStatusInfo > 0, so `yaver ping` printed a green "reachable · via relay"
// for a box the relay had just declined to bridge, and remote_status_cmd.go
// said "agent rejected our auth token" about an agent that never saw the
// request. The relay stopped the request at its own door; nothing downstream
// of it was ever contacted.
//
// The distinction that must survive: a genuine AGENT 401 DID reach the agent
// and must still come back as a real answer, or callers lose the ability to
// say "your token was refused by the box".
func TestRelayCredentialDenyIsNotAReachedAgent(t *testing.T) {
	cases := []struct {
		name        string
		status      int
		body        string
		wantReached bool
	}{
		{
			name:        "relay password missing (the live incident body)",
			status:      http.StatusUnauthorized,
			body:        `{"code":"relay_password_missing","error":"relay password missing — sign in again to fetch it","ok":false}`,
			wantReached: false,
		},
		{
			name:        "relay password missing, prose only (relay not yet redeployed)",
			status:      http.StatusUnauthorized,
			body:        `{"code":"Unauthorized","error":"relay password missing — sign in again to fetch it","ok":false}`,
			wantReached: false,
		},
		{
			name:        "invalid relay password",
			status:      http.StatusUnauthorized,
			body:        `{"code":"relay_password_invalid","error":"invalid relay password","ok":false}`,
			wantReached: false,
		},
		{
			// The agent itself refusing the bearer IS a reached agent.
			name:        "agent refused the bearer token",
			status:      http.StatusUnauthorized,
			body:        `{"error":"invalid token","ok":false}`,
			wantReached: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer srv.Close()

			candidates := []RemoteAgentCandidate{{DeviceID: "dev-under-test", BaseURL: srv.URL}}
			_, status, raw, err := doRemoteAgentRequest(context.Background(), candidates, "test-token", http.MethodGet, "/info", nil, 10*time.Second)

			if tc.wantReached {
				if err != nil {
					t.Fatalf("an agent-issued 401 must be returned as a real answer, got err=%v", err)
				}
				if status != tc.status {
					t.Fatalf("status = %d, want %d (the agent's own verdict must reach the caller)", status, tc.status)
				}
				if !strings.Contains(string(raw), "invalid token") {
					t.Fatalf("the agent's body must reach the caller, got %q", string(raw))
				}
				return
			}

			if err == nil {
				t.Fatalf("a relay-credential refusal was reported as a REACHED agent (status=%d) — "+
					"this is the bug that made `yaver ping` print a green reachable for a box "+
					"the relay refused to bridge", status)
			}
			if !strings.Contains(err.Error(), "never reached the agent") {
				t.Fatalf("the error must say the request never reached the agent, got: %v", err)
			}
			if !strings.Contains(err.Error(), "yaver auth") {
				t.Fatalf("the error must name the remedy (refresh this client's relay password), got: %v", err)
			}
		})
	}
}
