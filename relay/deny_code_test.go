package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Every refusal on the /d/ proxy path must carry BOTH:
//   - a STABLE machine code, so no client has to regex English; and
//   - its HISTORICAL prose, so every already-shipped client still works.
//
// Incident (measured live 2026-07-28): `GET /d/<deviceId>/health` with a valid
// bearer but no X-Relay-Password answered
//
//	401 {"code":"Unauthorized","error":"relay password missing — sign in again to fetch it"}
//
// `code` was http.StatusText(401) — a value every 401 carries — and the web
// dashboard rendered that literal string as the DEVICE's verdict:
// "Alive · can't reach (Unauthorized)", on a box that returns 200 the instant
// the relay password is attached. With no stable signal, four surfaces invented
// four regexes over the prose and they drifted apart.
//
// The prose half of each assertion is not decoration. The relay is redeployed
// to public.yaver.io by hand, so for as long as that lag lasts EVERY consumer
// must keep its prose fallback — and this test is what stops a future edit from
// "cleaning up" the wording out from under the shipped clients.
//
// PROVEN BY BREAKING: swapping any writeRelayErrorCode call back to
// writeRelayError makes exactly the subtest for that path fail, naming the
// path that lost its code (verified 2026-07-28 for all four).
func TestProxyAuthRefusals_CarryStableCodeAndHistoricProse(t *testing.T) {
	for _, tc := range []struct {
		name      string
		password  string // shared password the relay is configured with
		send      string // X-Relay-Password the client presents ("" = omit)
		wantCode  int
		wantBody  string
		wantProse string
	}{
		{
			name:      "missing relay password",
			password:  "shared-pw",
			send:      "",
			wantCode:  http.StatusUnauthorized,
			wantBody:  RelayCodePasswordMissing,
			wantProse: "relay password missing — sign in again to fetch it",
		},
		{
			name:      "invalid relay password",
			password:  "shared-pw",
			send:      "not-the-password",
			wantCode:  http.StatusUnauthorized,
			wantBody:  RelayCodePasswordInvalid,
			wantProse: "invalid relay password",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := NewRelayServer(0, 0, tc.password, "", "")
			req := httptest.NewRequest(http.MethodGet, "/d/device-abc/health", nil)
			if tc.send != "" {
				req.Header.Set("X-Relay-Password", tc.send)
			}
			rr := httptest.NewRecorder()
			srv.handleProxy(rr, req)

			if rr.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d (body=%s)", rr.Code, tc.wantCode, rr.Body.String())
			}
			body := decodeRelayBody(t, rr)
			if body["code"] != tc.wantBody {
				t.Fatalf("code = %v, want %q — a client cannot tell a RELAY credential deny from an AGENT token deny without it", body["code"], tc.wantBody)
			}
			if body["error"] != tc.wantProse {
				t.Fatalf("error = %v, want the HISTORIC prose %q — shipped clients still match on it while public.yaver.io runs the old relay", body["error"], tc.wantProse)
			}
			if body["message"] != tc.wantProse {
				t.Fatalf("message = %v, want %q", body["message"], tc.wantProse)
			}
			if body["ok"] != false {
				t.Fatalf("ok = %v, want false", body["ok"])
			}
		})
	}
}

// The auth backend being DOWN is a THIRD thing — not "your password is wrong"
// and not "the device is gone". It already had the right status (503) and the
// right prose; now it has a code too, so a client can back off instead of
// "self-healing" a credential that was never broken.
func TestProxyAuthBackendUnavailable_CarriesStableCode(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer backend.Close()

	srv := NewRelayServer(0, 0, "", backend.URL, "")
	req := httptest.NewRequest(http.MethodGet, "/d/device-abc/health", nil)
	req.Header.Set("X-Relay-Password", "some-password")
	rr := httptest.NewRecorder()
	srv.handleProxy(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body=%s)", rr.Code, rr.Body.String())
	}
	body := decodeRelayBody(t, rr)
	if body["code"] != RelayCodeAuthBackendUnavailable {
		t.Fatalf("code = %v, want %q", body["code"], RelayCodeAuthBackendUnavailable)
	}
	if body["error"] != "relay auth backend unavailable — retry" {
		t.Fatalf("error = %v, want the historic prose", body["error"])
	}
}

// The rate-limit refusal is the one an over-eager retry loop actually hits, so
// it is the one most in need of being machine-distinguishable from a genuine
// bad password — a client that reads them the same way retries forever.
func TestProxyInvalidAuthRateLimited_CarriesStableCode(t *testing.T) {
	srv := NewRelayServer(0, 0, "shared-pw", "", "")
	cfg := defaultAbuseGuardConfig()
	cfg.InvalidAuthPerIPPerMin = 1
	cfg.InvalidAuthBurstPerIP = 1
	srv.abuseGuard = newAbuseGuard(cfg)

	var last *httptest.ResponseRecorder
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/d/device-abc/health", nil)
		req.Header.Set("X-Relay-Password", "wrong")
		last = httptest.NewRecorder()
		srv.handleProxy(last, req)
		if last.Code == http.StatusTooManyRequests {
			break
		}
	}
	if last.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 after draining the burst (body=%s)", last.Code, last.Body.String())
	}
	body := decodeRelayBody(t, last)
	if body["code"] != RelayCodePasswordRateLimited {
		t.Fatalf("code = %v, want %q", body["code"], RelayCodePasswordRateLimited)
	}
	if body["error"] != "too many invalid relay password attempts" {
		t.Fatalf("error = %v, want the historic prose", body["error"])
	}
}

// The two 502s were indistinguishable on the wire: the same-owner backstop
// (82d8bb805) emitted NO code at all, while genuine absence carried
// relay.device_not_connected. "Your box isn't connected" and "that tunnel
// belongs to a different account" are opposite diagnoses with opposite
// remedies, and a support engineer reading a body could not tell which.
//
// The user-visible PROSE stays identical on purpose — leaking "that deviceId
// exists but is someone else's" would hand a stranger an ownership oracle.
// Only the code differs.
func TestProxyOwnerMismatch_HasItsOwnCode(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":true,"userId":"user-A"}`)
	}))
	defer backend.Close()

	srv := NewRelayServer(0, 0, "", backend.URL, "")
	// A tunnel for this deviceId exists — owned by a DIFFERENT account.
	srv.mu.Lock()
	srv.tunnels["device-abc"] = &agentTunnel{deviceID: "device-abc", userID: "user-B", connAt: time.Now()}
	srv.mu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/d/device-abc/health", nil)
	req.Header.Set("X-Relay-Password", "user-a-password")
	rr := httptest.NewRecorder()
	srv.handleProxy(rr, req)

	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 (body=%s)", rr.Code, rr.Body.String())
	}
	body := decodeRelayBody(t, rr)
	if body["code"] != RelayCodeDeviceOwnerMismatch {
		t.Fatalf("code = %v, want %q — without it this is byte-identical to genuine absence", body["code"], RelayCodeDeviceOwnerMismatch)
	}
	if body["code"] == RelayCodeDeviceNotConnected {
		t.Fatal("owner mismatch must NOT reuse the genuine-absence code")
	}
	if body["error"] != "device not connected to relay" {
		t.Fatalf("error = %v — the prose must stay identical to genuine absence so a stranger gets no ownership oracle", body["error"])
	}
}

// A DEAD SESSION TOKEN is not a brute-force attempt — it must not earn an
// invalid-auth strike, or an owner's own box locks itself out: every retry
// drains the IP bucket, the 429s never reach Convex again, so
// clearInvalidAuth can never fire (2026-08-10, ubuntu-4gb-hel1-1).
//
// Convex returns reason=dead_token when the PASSWORD matched the
// userSettings row but the session token is expired/foreign (userSettings.ts
// validateRelayPassword). The register paths clear the IP's strikes in that
// case; the proxy path must at minimum NOT consume the bucket, so a client
// that keeps retrying after its session lapsed does not trip the limiter.
//
// PROVEN BY BREAKING: reverting the proxy path to the pre-fix shape — always
// calling allowInvalidAuth regardless of denyReason — drains the burst in the
// loop below and this test fails with a 429 where a 401 (invalid password)
// is expected.
func TestProxyDeadToken_DoesNotConsumeInvalidAuthBucket(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":false,"userId":"","isPaid":false,"plan":"","reason":"dead_token"}`)
	}))
	defer backend.Close()

	srv := NewRelayServer(0, 0, "", backend.URL, "")
	cfg := defaultAbuseGuardConfig()
	cfg.InvalidAuthPerIPPerMin = 2
	cfg.InvalidAuthBurstPerIP = 2
	srv.abuseGuard = newAbuseGuard(cfg)

	// Every attempt presents a password that Convex validates as CORRECT but
	// with a dead session token. The first three must all answer 401 (invalid
	// password — the client's remedy is re-auth, not backoff), NOT 429.
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/d/device-abc/health", nil)
		req.Header.Set("X-Relay-Password", "correct-password-dead-session")
		rr := httptest.NewRecorder()
		srv.handleProxy(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want 401 (dead token is a valid password, not a brute-force source); body=%s",
				i+1, rr.Code, rr.Body.String())
		}
		body := decodeRelayBody(t, rr)
		if body["code"] != RelayCodePasswordInvalid {
			t.Fatalf("attempt %d: code = %v, want %q", i+1, body["code"], RelayCodePasswordInvalid)
		}
	}

	// And the bucket must still be full enough for a real bad-password attempt
	// to be counted — the dead-token attempts above must NOT have consumed it.
	// With burst=2, a genuinely wrong password from this IP trips the limiter
	// on its third strike, proving dead-token attempts did not burn the burst.
	req := httptest.NewRequest(http.MethodGet, "/d/device-abc/health", nil)
	req.Header.Set("X-Relay-Password", "actually-wrong")
	rr := httptest.NewRecorder()
	srv.handleProxy(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("first real bad-password after dead-token attempts: status = %d, want 401 (bucket must not be pre-drained by dead-token retries)", rr.Code)
	}
}

// A dead session token on the REGISTER paths must clear the IP's invalid-auth
// strikes (the password validated), not merely skip counting. This is the
// owner-self-lockout regression from 2026-08-10: a stale cached password
// burned the bucket while the session was expired, and nothing cleared it.
// The register path is exercised through the shared validate→strike decision
// logic: the abuse-guard contract is that dead_token never consumes the
// bucket (asserted above via the proxy path) — this test pins the wire shape
// Convex answers with so the relay keeps distinguishing the three reasons.
func TestConvexDeadTokenReason_SurvivesOnTheWire(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":false,"userId":"","isPaid":false,"plan":"","reason":"dead_token"}`)
	}))
	defer backend.Close()

	srv := NewRelayServer(0, 0, "", backend.URL, "")
	_, ok, reason, err := srv.validateRelayAccessWithReason("any-password", "register", "device-abc", "expired-token")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if ok {
		t.Fatal("dead token must not authorize")
	}
	if reason != RelayDenyDeadToken {
		t.Fatalf("reason = %q, want %q — the relay must see dead_token distinctly so it can exempt it from the invalid-auth limiter", reason, RelayDenyDeadToken)
	}
}

// writeRelayError's DEFAULT behaviour is unchanged: every other caller in the
// relay still emits http.StatusText(status). Only callers that opt in via
// writeRelayErrorCode get a stable code, so this change cannot have altered a
// body anywhere it was not applied.
func TestWriteRelayError_DefaultCodeUnchanged(t *testing.T) {
	rr := httptest.NewRecorder()
	writeRelayError(rr, http.StatusTooManyRequests, "too many concurrent requests for device")
	body := decodeRelayBody(t, rr)
	if body["code"] != http.StatusText(http.StatusTooManyRequests) {
		t.Fatalf("code = %v, want %q (untouched default)", body["code"], http.StatusText(http.StatusTooManyRequests))
	}
	if body["error"] != "too many concurrent requests for device" {
		t.Fatalf("error = %v", body["error"])
	}
}

func decodeRelayBody(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(strings.NewReader(rr.Body.String())).Decode(&body); err != nil {
		t.Fatalf("decode body %q: %v", rr.Body.String(), err)
	}
	return body
}
