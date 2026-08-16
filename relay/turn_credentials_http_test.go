package main

import (
	"crypto/hmac"
	"crypto/sha1" // TURN REST deliberately specifies HMAC-SHA1.
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestICECredentialsRequiresRelayAuthAndMintsShortLivedMultiTransportCredentials(t *testing.T) {
	t.Setenv("TURN_PUBLIC_HOST", "relay.example.test")
	t.Setenv("TURN_PORT", "3478")
	t.Setenv("TURN_TLS_PORT", "5349")
	s := NewRelayServer(0, 0, "account-password", "", "")
	s.turnAuthSecret = "long-lived-turn-secret"

	missing := httptest.NewRecorder()
	s.handleICECredentials(missing, httptest.NewRequest(http.MethodGet, "https://relay.example.test/ice", nil))
	if missing.Code != http.StatusUnauthorized || !strings.Contains(missing.Body.String(), string(RelayCodePasswordMissing)) {
		t.Fatalf("missing auth = %d %s", missing.Code, missing.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "https://relay.example.test/ice", nil)
	req.Header.Set("X-Relay-Password", "account-password")
	rec := httptest.NewRecorder()
	s.handleICECredentials(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	var body relayICECredentialResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.TTLSeconds < 59 || body.TTLSeconds > 120 || len(body.IceServers) != 2 {
		t.Fatalf("unexpected response: %+v", body)
	}
	turn := body.IceServers[1]
	if len(turn.URLs) != 3 || !strings.HasPrefix(turn.URLs[0], "turn:") || !strings.HasPrefix(turn.URLs[2], "turns:") {
		t.Fatalf("TURN transports = %v", turn.URLs)
	}
	mac := hmac.New(sha1.New, []byte("long-lived-turn-secret"))
	_, _ = mac.Write([]byte(turn.Username))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(turn.Credential), []byte(want)) {
		t.Fatal("credential does not match TURN REST HMAC")
	}
}

func TestICECredentialsUsesStableAccountBucketAndEnforcesMintLimit(t *testing.T) {
	t.Setenv("TURN_PUBLIC_HOST", "relay.example.test")
	s := NewRelayServer(0, 0, "account-password", "", "")
	s.turnAuthSecret = "long-lived-turn-secret"
	s.abuseGuard.cfg.TURNCredPerUserPerMin = 1
	s.abuseGuard.cfg.TURNCredBurstPerUser = 1

	mint := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "https://relay.example.test/ice", nil)
		req.Header.Set("X-Relay-Password", "account-password")
		rec := httptest.NewRecorder()
		s.handleICECredentials(rec, req)
		return rec
	}
	first := mint()
	if first.Code != http.StatusOK {
		t.Fatalf("first mint = %d %s", first.Code, first.Body.String())
	}
	var firstBody relayICECredentialResponse
	if err := json.Unmarshal(first.Body.Bytes(), &firstBody); err != nil {
		t.Fatal(err)
	}
	second := mint()
	if second.Code != http.StatusTooManyRequests || !strings.Contains(second.Body.String(), "webrtc.turn_rate_limited") {
		t.Fatalf("second mint = %d %s", second.Code, second.Body.String())
	}
	if got := relayTURNAccountBucket("long-lived-turn-secret", "", "account-password"); !strings.Contains(firstBody.IceServers[1].Username, got) {
		t.Fatalf("TURN username does not contain stable opaque account bucket")
	}
}

func TestICECredentialsFailsClosedWithoutTURNSecret(t *testing.T) {
	t.Setenv("TURN_PUBLIC_HOST", "relay.example.test")
	s := NewRelayServer(0, 0, "account-password", "", "")
	req := httptest.NewRequest(http.MethodGet, "https://relay.example.test/ice", nil)
	req.Header.Set("X-Relay-Password", "account-password")
	rec := httptest.NewRecorder()
	s.handleICECredentials(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "webrtc.turn_not_configured") {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
}
