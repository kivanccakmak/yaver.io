package main

// vibe_sessions_http.go — the co-vibe HTTP surface.
//
// ONE report endpoint, four small verbs, and one enforcement guard. Every client
// surface (web dashboard, mobile/tablet/car/glass, tvOS, watch) reads the same
// payload and renders the same roster, because a second shape is a second thing
// to keep in sync and the first place the UI starts lying.
//
//   GET  /vibe/sessions           → MachineResourceReport (who + what + where)
//   POST /vibe/join               {workDir?|sessionId, displayName} → seat + session
//   POST /vibe/heartbeat          {sessionId, participantId}
//   POST /vibe/role               {sessionId, participantId, role}   (OWNER ONLY)
//   POST /vibe/leave              {sessionId, participantId}
//
// Enforcement lives in requireVibeDriver, called by the mutating dev/runtime
// handlers. A role that is only rendered — a greyed-out button in one client — is
// not a permission: another surface, or curl, ignores it.

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"
)

// vibeRegistry lazily builds the machine's session registry, owned by whoever
// owns this agent.
func (s *HTTPServer) vibeRegistry() *VibeSessionRegistry {
	s.vibeOnce.Do(func() {
		s.vibeSessions = NewVibeSessionRegistry(s.ownerUserID)
		// Publish it for components not wired to the HTTP server (the WebRTC
		// manager attributes its device claims through this).
		registerVibeRegistry(s.vibeSessions)
	})
	return s.vibeSessions
}

// callerVibeIdentity extracts who is asking, from headers the auth layer has
// already validated. Never from the body — a client that can name its own userID
// can name someone else's.
func (s *HTTPServer) callerVibeIdentity(r *http.Request) (userID, surface string, isGuest bool) {
	userID = strings.TrimSpace(r.Header.Get("X-Yaver-UserID"))
	if userID == "" {
		// Single-user mode: an authenticated request with no multi-user header is
		// the owner's own.
		userID = s.ownerUserID
	}
	surface = string(normalizeSurface(r.Header.Get("X-Yaver-Surface")))
	isGuest = userID != s.ownerUserID
	return userID, surface, isGuest
}

// handleVibeSessions reports every live session on this machine: participants,
// their surfaces and roles, and the exclusive resources (ports + devices) each
// session holds.
//
// Deliberately readable by any authenticated participant, including viewers —
// seeing that someone else is driving is precisely what stops two people fighting
// over one simulator. Nothing sensitive is in it: project BASENAMES only, never
// absolute paths (which would leak the box's username).
func (s *HTTPServer) handleVibeSessions(w http.ResponseWriter, r *http.Request) {
	reg := s.vibeRegistry()
	reg.PruneEmpty()

	sessions := reg.Sessions()
	claimed := map[string]bool{}
	for _, sess := range sessions {
		for _, res := range sess.Resources {
			claimed[res.Type+":"+res.Value] = true
		}
	}
	// Anything held but not attributed to a live session still gets reported —
	// an unexplained port is exactly what a user needs to see when a start fails,
	// and hiding it is how "no idea why 8081 is busy" happens.
	unattributed := []VibeResourceView{}
	for _, res := range resourcesForOwner("") {
		if !claimed[res.Type+":"+res.Value] {
			unattributed = append(unattributed, res)
		}
	}
	hostname, _ := os.Hostname()
	jsonReply(w, http.StatusOK, MachineResourceReport{
		Hostname:     hostname,
		Sessions:     sessions,
		Unattributed: unattributed,
		GeneratedAt:  time.Now().UTC().Format(time.RFC3339),
	})
}

// handleVibeJoin takes a seat in a session. `workDir` creates-or-joins by project
// (the "joint session" case); `sessionId` joins a known one.
func (s *HTTPServer) handleVibeJoin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID   string `json:"sessionId"`
		WorkDir     string `json:"workDir"`
		Framework   string `json:"framework"`
		DisplayName string `json:"displayName"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	reg := s.vibeRegistry()
	userID, surface, isGuest := s.callerVibeIdentity(r)

	sessionID := strings.TrimSpace(body.SessionID)
	if sessionID == "" {
		workDir := strings.TrimSpace(body.WorkDir)
		if workDir == "" {
			jsonError(w, http.StatusBadRequest, "join needs either sessionId or workDir")
			return
		}
		// The session's owner is the MACHINE owner, not the joiner — a guest
		// opening a project does not become its owner.
		sessionID = reg.EnsureSession(s.ownerUserID, workDir, body.Framework).ID
	}

	seat, view, err := reg.Join(sessionID, userID, body.DisplayName, surface, isGuest)
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	jsonReply(w, http.StatusOK, map[string]any{
		"ok":          true,
		"participant": seat,
		"session":     view,
		// Tell the client how often to prove it is still here, instead of making
		// it guess and drift out of the roster.
		"heartbeatSeconds": int(participantTTL.Seconds()) / 2,
	})
}

func (s *HTTPServer) handleVibeHeartbeat(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID     string `json:"sessionId"`
		ParticipantID string `json:"participantId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	alive := s.vibeRegistry().Heartbeat(body.SessionID, body.ParticipantID)
	// `alive:false` is the client's cue to re-join rather than keep beating into a
	// session that has forgotten it.
	jsonReply(w, http.StatusOK, map[string]any{"ok": true, "alive": alive})
}

// handleVibeRole is the owner's grant/revoke. The granter is taken from the
// authenticated identity; a body-supplied granter would be trivially forgeable.
func (s *HTTPServer) handleVibeRole(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID     string `json:"sessionId"`
		ParticipantID string `json:"participantId"`
		Role          string `json:"role"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	userID, _, _ := s.callerVibeIdentity(r)
	if err := s.vibeRegistry().SetRole(userID, body.SessionID, body.ParticipantID, body.Role); err != nil {
		jsonError(w, http.StatusForbidden, err.Error())
		return
	}
	jsonReply(w, http.StatusOK, map[string]any{"ok": true, "role": strings.ToLower(body.Role)})
}

func (s *HTTPServer) handleVibeLeave(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID     string `json:"sessionId"`
		ParticipantID string `json:"participantId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	s.vibeRegistry().Leave(body.SessionID, body.ParticipantID)
	jsonReply(w, http.StatusOK, map[string]any{"ok": true})
}

// vibeDriverOnly wraps a mutating handler so a viewer cannot invoke it.
//
// Declarative at the route table (see httpserver.go) rather than a line inside
// each handler: enforcement you can SEE in one list is enforcement you can audit,
// and the next mutating route is one wrapper away from being covered instead of
// one forgotten `if` away from being open.
func (s *HTTPServer) vibeDriverOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// GET/HEAD are reads even on a mutating path — never block looking.
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			next(w, r)
			return
		}
		if !s.requireVibeDriver(w, r) {
			return
		}
		next(w, r)
	}
}

// requireVibeDriver is the enforcement point for "can this caller change things?".
//
// Returns true when the request may proceed. On refusal it has already written a
// 403 naming who to ask, because "forbidden" with no path forward is the vague
// error this codebase keeps paying for.
//
// Fail-open is deliberate in exactly one case: when the caller is not part of any
// co-vibe session (no X-Yaver-Participant), the pre-existing auth layer is the
// only gate — this feature must not retroactively lock out every CLI and SDK
// client that never joins a session. Once a client DOES join, its role binds.
func (s *HTTPServer) requireVibeDriver(w http.ResponseWriter, r *http.Request) bool {
	sessionID := strings.TrimSpace(r.Header.Get("X-Yaver-Vibe-Session"))
	if sessionID == "" {
		return true // not a co-vibe request; existing auth applies
	}
	userID, surface, _ := s.callerVibeIdentity(r)
	if s.vibeRegistry().CanDrive(sessionID, userID, surface) {
		return true
	}
	role, present := s.vibeRegistry().RoleOf(sessionID, userID, surface)
	msg := "you are in this session as a viewer — ask the machine owner for drive access"
	if !present {
		msg = "your seat in this session has expired (no heartbeat) — re-join and try again"
	} else if role == "" {
		msg = "you are not a participant in this session"
	}
	jsonError(w, http.StatusForbidden, msg)
	return false
}
