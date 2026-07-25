package main

// vibe_sessions_http_test.go — the co-vibe surface over real HTTP.
//
// The unit tests prove the registry's rules; these prove the WIRE honours them.
// That distinction matters here more than usual: the whole point of enforcing
// roles in the agent is that a client cannot opt out. A test that only exercises
// the Go API would pass just as happily if the route table forgot the wrapper —
// which is exactly the mistake this guards.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newVibeTestServer(t *testing.T) *HTTPServer {
	t.Helper()
	s := &HTTPServer{ownerUserID: "user_owner", token: "test-token"}
	return s
}

// post drives a handler directly with the headers the auth layer would have set,
// so the test exercises the enforcement wrapper rather than re-testing auth.
func postVibe(t *testing.T, h http.HandlerFunc, path string, body any, userID, surface, vibeSession string) *httptest.ResponseRecorder {
	t.Helper()
	buf, _ := json.Marshal(body)
	r := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(buf))
	if userID != "" {
		r.Header.Set("X-Yaver-UserID", userID)
	}
	if surface != "" {
		r.Header.Set("X-Yaver-Surface", surface)
	}
	if vibeSession != "" {
		r.Header.Set("X-Yaver-Vibe-Session", vibeSession)
	}
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func TestVibeJoinReportAndRoleOverHTTP(t *testing.T) {
	s := newVibeTestServer(t)

	// Owner joins by workDir — the "create or join by project" path.
	res := postVibe(t, s.handleVibeJoin, "/vibe/join",
		map[string]string{"workDir": "/Users/x/Workspace/e-mobile", "framework": "flutter", "displayName": "Kivanc"},
		"user_owner", "web", "")
	if res.Code != http.StatusOK {
		t.Fatalf("owner join: %d %s", res.Code, res.Body.String())
	}
	var joined struct {
		Participant VibeParticipant `json:"participant"`
		Session     VibeSessionView `json:"session"`
		Heartbeat   int             `json:"heartbeatSeconds"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &joined); err != nil {
		t.Fatalf("decode join: %v", err)
	}
	if joined.Participant.Role != VibeRoleOwner {
		t.Errorf("machine owner joined as %q, want %q", joined.Participant.Role, VibeRoleOwner)
	}
	if joined.Heartbeat <= 0 {
		t.Error("join must tell the client how often to heartbeat, or it will drift out of the roster silently")
	}
	if joined.Session.Project != "e-mobile" {
		t.Errorf("session project = %q, want the basename (never the absolute path)", joined.Session.Project)
	}
	sessionID := joined.Session.ID

	// A guest joins the SAME session from a phone — the joint-session case.
	res = postVibe(t, s.handleVibeJoin, "/vibe/join",
		map[string]string{"sessionId": sessionID, "displayName": "Batikan"},
		"user_guest", "ios", "")
	if res.Code != http.StatusOK {
		t.Fatalf("guest join: %d %s", res.Code, res.Body.String())
	}
	var guestJoin struct {
		Participant VibeParticipant `json:"participant"`
	}
	json.Unmarshal(res.Body.Bytes(), &guestJoin)
	if guestJoin.Participant.Role != VibeRoleViewer {
		t.Fatalf("guest joined as %q — a guest must land as a viewer", guestJoin.Participant.Role)
	}
	if guestJoin.Participant.Surface != "mobile" {
		t.Errorf("surface %q should normalise to mobile (shared with surface.go)", guestJoin.Participant.Surface)
	}

	// The report shows both seats to anyone authenticated, including the viewer.
	r := httptest.NewRequest(http.MethodGet, "/vibe/sessions", nil)
	r.Header.Set("X-Yaver-UserID", "user_guest")
	w := httptest.NewRecorder()
	s.handleVibeSessions(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("report: %d", w.Code)
	}
	var report MachineResourceReport
	if err := json.Unmarshal(w.Body.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	if len(report.Sessions) != 1 || len(report.Sessions[0].Participants) != 2 {
		t.Fatalf("report should show 1 session with 2 seats, got %d sessions: %s", len(report.Sessions), w.Body.String())
	}

	// A viewer cannot promote themselves, over HTTP, with a forged body.
	res = postVibe(t, s.handleVibeRole, "/vibe/role",
		map[string]string{"sessionId": sessionID, "participantId": guestJoin.Participant.ID, "role": "driver"},
		"user_guest", "ios", "")
	if res.Code != http.StatusForbidden {
		t.Fatalf("a guest promoted themselves over HTTP (%d) — the granter must come from the authenticated identity, never the body", res.Code)
	}

	// The owner can.
	res = postVibe(t, s.handleVibeRole, "/vibe/role",
		map[string]string{"sessionId": sessionID, "participantId": guestJoin.Participant.ID, "role": "driver"},
		"user_owner", "web", "")
	if res.Code != http.StatusOK {
		t.Fatalf("owner grant over HTTP: %d %s", res.Code, res.Body.String())
	}
}

// The enforcement wrapper is what makes "read-only" real. If the route table ever
// loses it, this fails.
func TestVibeDriverOnlyBlocksAViewerAtTheWire(t *testing.T) {
	s := newVibeTestServer(t)

	res := postVibe(t, s.handleVibeJoin, "/vibe/join",
		map[string]string{"workDir": "/w/app", "framework": "expo"}, "user_owner", "web", "")
	var joined struct {
		Session VibeSessionView `json:"session"`
	}
	json.Unmarshal(res.Body.Bytes(), &joined)
	sessionID := joined.Session.ID

	res = postVibe(t, s.handleVibeJoin, "/vibe/join",
		map[string]string{"sessionId": sessionID}, "user_guest", "web", "")
	if res.Code != http.StatusOK {
		t.Fatalf("guest join: %d", res.Code)
	}

	// A handler that must never run for a viewer.
	ran := false
	guarded := s.vibeDriverOnly(func(w http.ResponseWriter, r *http.Request) {
		ran = true
		w.WriteHeader(http.StatusOK)
	})

	// Viewer → blocked, with a remedy in the message.
	res = postVibe(t, guarded, "/dev/start", map[string]string{}, "user_guest", "web", sessionID)
	if res.Code != http.StatusForbidden {
		t.Fatalf("viewer got %d, want 403", res.Code)
	}
	if ran {
		t.Fatal("the guarded handler RAN for a viewer — read-only would be decoration")
	}
	if body := res.Body.String(); !bytes.Contains([]byte(body), []byte("owner")) {
		t.Errorf("403 does not tell the user who can grant access: %s", body)
	}

	// Owner → allowed.
	ran = false
	res = postVibe(t, guarded, "/dev/start", map[string]string{}, "user_owner", "web", sessionID)
	if res.Code != http.StatusOK || !ran {
		t.Fatalf("owner was blocked from their own machine: %d ran=%v", res.Code, ran)
	}

	// Promoted driver → allowed.
	guestSeat := participantID("user_guest", "web")
	if res := postVibe(t, s.handleVibeRole, "/vibe/role",
		map[string]string{"sessionId": sessionID, "participantId": guestSeat, "role": "driver"},
		"user_owner", "web", ""); res.Code != http.StatusOK {
		t.Fatalf("grant: %d %s", res.Code, res.Body.String())
	}
	ran = false
	res = postVibe(t, guarded, "/dev/start", map[string]string{}, "user_guest", "web", sessionID)
	if res.Code != http.StatusOK || !ran {
		t.Fatalf("promoted driver was still blocked: %d ran=%v", res.Code, ran)
	}

	// A GET on a guarded route is a READ — never blocked. Looking is not driving.
	ran = false
	rr := httptest.NewRequest(http.MethodGet, "/dev/start", nil)
	rr.Header.Set("X-Yaver-UserID", "user_stranger")
	rr.Header.Set("X-Yaver-Vibe-Session", sessionID)
	w := httptest.NewRecorder()
	guarded(w, rr)
	if !ran {
		t.Error("a GET was blocked by the driver guard — viewers must still be able to look")
	}
}

// A client that never joins a co-vibe session must keep working exactly as before.
// This feature must not retroactively lock out every CLI/SDK caller.
func TestNonCoVibeRequestsAreUnaffected(t *testing.T) {
	s := newVibeTestServer(t)
	ran := false
	guarded := s.vibeDriverOnly(func(w http.ResponseWriter, r *http.Request) {
		ran = true
		w.WriteHeader(http.StatusOK)
	})
	// No X-Yaver-Vibe-Session header at all.
	res := postVibe(t, guarded, "/dev/start", map[string]string{}, "user_owner", "cli", "")
	if res.Code != http.StatusOK || !ran {
		t.Fatalf("a plain (non co-vibe) request was blocked: %d ran=%v", res.Code, ran)
	}
}

func TestVibeHeartbeatTellsAReapedClientToRejoin(t *testing.T) {
	s := newVibeTestServer(t)
	res := postVibe(t, s.handleVibeHeartbeat, "/vibe/heartbeat",
		map[string]string{"sessionId": "vs_missing", "participantId": "nobody@web"}, "user_owner", "web", "")
	if res.Code != http.StatusOK {
		t.Fatalf("heartbeat: %d", res.Code)
	}
	var out struct {
		Alive bool `json:"alive"`
	}
	json.Unmarshal(res.Body.Bytes(), &out)
	if out.Alive {
		t.Error("heartbeat for an unknown session reported alive:true — the client would keep beating into a void instead of re-joining")
	}
}
