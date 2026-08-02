package main

// attach_http.go — the HTTP surface for Attach Mode.
//
// Three owner-only verbs (start / refresh / stop) plus the middleware that lets
// the ATTACHED page authenticate with the capability minted in
// attach_session.go instead of the user's session token.
//
// The division of labour matters: s.auth() proves who the caller is with a real
// bearer, and only that path may MINT. The capability path can never widen
// itself — it is checked against attachScopeAllows and nothing else.

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// attachPrincipalIsOwner rejects the principals that must never hold an attach
// capability, even though s.auth() accepted their bearer.
//
// A guest was invited to a project, not handed the ability to render Yaver's
// own source and start coding turns against it. A support session is a
// time-boxed operator channel with a narrow allowlist — widening it via Attach
// Mode would be a privilege escalation wearing a feature's clothes.
func attachPrincipalIsOwner(r *http.Request) bool {
	if r.Header.Get("X-Yaver-Guest") == "true" {
		return false
	}
	if r.Header.Get("X-Yaver-Support") == "true" {
		return false
	}
	return true
}

type attachStartRequest struct {
	WorkDir string `json:"workDir"`
}

type attachStartResponse struct {
	OK        bool   `json:"ok"`
	SessionID string `json:"sessionId,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
	WorkDir   string `json:"workDir,omitempty"`
	// Code is a STABLE identifier surfaces switch on, so no client has to
	// regex the prose. Same reasoning as reason_codes.go.
	Code   string `json:"code,omitempty"`
	Error  string `json:"error,omitempty"`
	Remedy string `json:"remedy,omitempty"`
}

func (s *HTTPServer) handleAttachStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	if !attachPrincipalIsOwner(r) {
		writeJSON(w, http.StatusForbidden, attachStartResponse{
			Code:  "ATTACH_OWNER_ONLY",
			Error: "Attach Mode is owner-only.",
			Remedy: "Sign in as the account that owns this machine. Guest and support sessions " +
				"cannot attach.",
		})
		return
	}

	var req attachStartRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	sess, err := StartAttachSession(strings.TrimSpace(req.WorkDir), s.ownerUserID, time.Now())
	if err != nil {
		// The overwhelmingly common cause is "that path is not the Yaver
		// checkout", and saying so beats a generic 400 — the user typed or
		// picked a path and needs to know which one we wanted.
		writeJSON(w, http.StatusBadRequest, attachStartResponse{
			Code:  "ATTACH_NOT_YAVER_CHECKOUT",
			Error: err.Error(),
			Remedy: "Point Attach Mode at the yaver.io checkout on this box — the directory whose " +
				"mobile/package.json is named \"yaver-mobile\".",
		})
		return
	}

	token, expiry := MintAttachCapability(sess.ID, time.Now())
	if token == "" {
		writeJSON(w, http.StatusInternalServerError, attachStartResponse{
			Code:   "ATTACH_SIGNING_UNAVAILABLE",
			Error:  "This box could not generate a signing secret, so no capability was issued.",
			Remedy: "Restart the agent; if it recurs the system entropy source is failing.",
		})
		RevokeAttachSession(sess.ID)
		return
	}

	setAttachCookie(w, r, token, expiry)
	writeJSON(w, http.StatusOK, attachStartResponse{
		OK:        true,
		SessionID: sess.ID,
		ExpiresAt: expiry.UTC().Format(time.RFC3339),
		WorkDir:   sess.WorkDir,
	})
}

// handleAttachRefresh extends a live session. Reachable BOTH with the owner's
// bearer (the host phone refreshing while the surface is open) and with the
// capability itself, so the attached page can keep itself alive without the
// host having to poll.
func (s *HTTPServer) handleAttachRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	sessionID := attachSessionIDFromRequest(r)
	if sessionID == "" {
		writeJSON(w, http.StatusUnauthorized, attachStartResponse{
			Code:  "ATTACH_NO_SESSION",
			Error: "No live attach session for this request.",
			Remedy: "Turn Attach Mode off and on again — the session expired or the agent " +
				"restarted, and capabilities deliberately do not survive a restart.",
		})
		return
	}
	now := time.Now()
	if !TouchAttachSession(sessionID, now) {
		writeJSON(w, http.StatusUnauthorized, attachStartResponse{
			Code:   "ATTACH_SESSION_REVOKED",
			Error:  "That attach session is no longer live.",
			Remedy: "Turn Attach Mode on again to start a new session.",
		})
		return
	}
	token, expiry := MintAttachCapability(sessionID, now)
	if token == "" {
		jsonError(w, http.StatusInternalServerError, "could not re-sign the attach capability")
		return
	}
	setAttachCookie(w, r, token, expiry)
	writeJSON(w, http.StatusOK, attachStartResponse{
		OK:        true,
		SessionID: sessionID,
		ExpiresAt: expiry.UTC().Format(time.RFC3339),
	})
}

// handleAttachStop is detach. It revokes SERVER-SIDE and clears the cookie.
//
// Both, always: clearing the cookie alone would leave a live capability that
// anything holding a copy could keep using — a false green of exactly the kind
// this repo keeps finding.
func (s *HTTPServer) handleAttachStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	sessionID := attachSessionIDFromRequest(r)
	revoked := false
	if sessionID != "" {
		revoked = RevokeAttachSession(sessionID)
	}
	clearAttachCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"revoked": revoked,
	})
}

// attachSessionIDFromRequest resolves the session from the capability cookie,
// falling back to an explicit body/query id for the owner-bearer path.
func attachSessionIDFromRequest(r *http.Request) string {
	if c, err := r.Cookie(attachCookieName); err == nil && c.Value != "" {
		if sess, ok := VerifyAttachCapability(c.Value, time.Now()); ok {
			return sess.ID
		}
	}
	if id := strings.TrimSpace(r.URL.Query().Get("sessionId")); id != "" {
		return id
	}
	return ""
}

// attachOrAuth accepts EITHER a normal bearer (the host app) OR a valid attach
// capability limited to the allow-list (the attached page).
//
// Order matters: the capability is checked first and, when present and valid,
// terminates the decision. A capability must never be able to fall through to
// the bearer path and inherit owner scope.
func (s *HTTPServer) attachOrAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if c, err := r.Cookie(attachCookieName); err == nil && c.Value != "" {
			sess, ok := VerifyAttachCapability(c.Value, time.Now())
			if !ok {
				writeJSON(w, http.StatusUnauthorized, attachStartResponse{
					Code:   "ATTACH_CAPABILITY_INVALID",
					Error:  "This attach capability is expired, revoked or not valid on this box.",
					Remedy: "Turn Attach Mode off and on again to mint a new one.",
				})
				return
			}
			if !attachScopeAllows(r.Method, r.URL.Path) {
				// Naming the scope rather than a bare 403 — an attached page
				// hitting a denied route is usually a bug in the surface, and
				// the developer reading this is the one who can fix it.
				writeJSON(w, http.StatusForbidden, attachStartResponse{
					Code: "ATTACH_OUT_OF_SCOPE",
					Error: "Attach Mode's capability does not cover " +
						strings.ToUpper(r.Method) + " " + r.URL.Path + ".",
					Remedy: "Do this from the host Yaver app instead. The attached surface is " +
						"deliberately limited to reading status, running coding turns and " +
						"reloading its own preview.",
				})
				return
			}
			r.Header.Set("X-Yaver-Attach", "true")
			r.Header.Set("X-Yaver-AttachSession", sess.ID)
			next(w, r)
			return
		}
		s.auth(next)(w, r)
	}
}
