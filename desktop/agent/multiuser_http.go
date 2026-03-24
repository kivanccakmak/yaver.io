package main

import (
	"log"
	"net/http"
	"strings"
)

// handleMultiUserList handles GET /users — list all user sessions.
// Only accessible by the machine admin (owner token).
func (s *HTTPServer) handleMultiUserList(w http.ResponseWriter, r *http.Request) {
	if s.multiUserMgr == nil {
		jsonReply(w, http.StatusServiceUnavailable, map[string]string{"error": "multi-user mode not enabled"})
		return
	}
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	users := s.multiUserMgr.ListUsers()
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"users":    users,
		"teamId":   s.multiUserMgr.teamID,
		"maxUsers": s.multiUserMgr.maxUsers,
	})
}

// handleMultiUserMe handles GET /users/me — return the current user's session info.
func (s *HTTPServer) handleMultiUserMe(w http.ResponseWriter, r *http.Request) {
	if s.multiUserMgr == nil {
		jsonReply(w, http.StatusServiceUnavailable, map[string]string{"error": "multi-user mode not enabled"})
		return
	}

	uid := r.Header.Get("X-Yaver-UserID")
	if uid == "" {
		jsonReply(w, http.StatusUnauthorized, map[string]string{"error": "no user context"})
		return
	}

	session := s.multiUserMgr.GetSession(uid)
	if session == nil {
		jsonReply(w, http.StatusNotFound, map[string]string{"error": "no session for user"})
		return
	}

	jsonReply(w, http.StatusOK, map[string]interface{}{
		"userId":       session.UserID,
		"email":        session.Email,
		"fullName":     session.FullName,
		"workspaceDir": session.WorkspaceDir,
		"createdAt":    session.CreatedAt,
		"lastActiveAt": session.LastActiveAt,
	})
}

// handleMultiUserRemove handles DELETE /users/{userId} — remove a user session.
// Only accessible by the machine admin.
func (s *HTTPServer) handleMultiUserRemove(w http.ResponseWriter, r *http.Request) {
	if s.multiUserMgr == nil {
		jsonReply(w, http.StatusServiceUnavailable, map[string]string{"error": "multi-user mode not enabled"})
		return
	}
	if r.Method != http.MethodDelete {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/users/")
	userID := strings.TrimSuffix(path, "/")
	if userID == "" {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "missing user ID"})
		return
	}

	deleteData := r.URL.Query().Get("delete_data") == "true"
	if err := s.multiUserMgr.RemoveUser(userID, deleteData); err != nil {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	jsonReply(w, http.StatusOK, map[string]string{"ok": "true"})
}

// handleMultiUserSessions handles GET /sessions — list all active yaver sessions
// across all users on this machine. Shows who's running what agent.
func (s *HTTPServer) handleMultiUserSessions(w http.ResponseWriter, r *http.Request) {
	if s.multiUserMgr == nil {
		jsonReply(w, http.StatusServiceUnavailable, map[string]string{"error": "multi-user mode not enabled"})
		return
	}

	type sessionInfo struct {
		UserID    string `json:"userId"`
		Email     string `json:"email"`
		TaskCount int    `json:"taskCount"`
		WorkDir   string `json:"workDir"`
	}

	var sessions []sessionInfo
	for _, u := range s.multiUserMgr.ListUsers() {
		uid := u["userId"].(string)
		userSession := s.multiUserMgr.GetSession(uid)
		taskCount := 0
		if userSession != nil && userSession.taskMgr != nil {
			taskCount = userSession.taskMgr.GetRunningTaskCount()
		}
		sessions = append(sessions, sessionInfo{
			UserID:    uid,
			Email:     u["email"].(string),
			TaskCount: taskCount,
			WorkDir:   u["workspaceDir"].(string),
		})
	}

	jsonReply(w, http.StatusOK, map[string]interface{}{
		"sessions": sessions,
	})
}

// multiUserAuth is the auth middleware for multi-user mode.
// Instead of rejecting non-owner tokens, it:
//  1. Validates the token against Convex → gets userId
//  2. Checks team membership (if teamId is configured)
//  3. Creates/gets the user's isolated session
//  4. Sets X-Yaver-UserID header for downstream handlers
//  5. Routes to the correct per-user managers
func (s *HTTPServer) multiUserAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			jsonError(w, http.StatusUnauthorized, "missing or invalid Authorization header")
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")

		// Resolve userId from token
		var uid string
		var email, fullName, provider string

		// Fast path: exact match with admin token
		if token == s.token {
			uid = s.ownerUserID
		} else if cachedUID, ok := s.tokenCache.Load(token); ok {
			uid = cachedUID.(string)
		} else {
			// Validate against Convex
			info, err := ValidateTokenInfo(s.convexURL, token)
			if err != nil {
				log.Printf("[AUTH-MULTI] token validation failed: %v", err)
				jsonError(w, http.StatusForbidden, "invalid token")
				return
			}
			uid = info.UserID
			email = info.Email
			fullName = info.FullName
			provider = info.Provider
			s.tokenCache.Store(token, uid)
		}

		// Create or get user session
		session, err := s.multiUserMgr.GetOrCreateSession(uid, email, fullName, provider)
		if err != nil {
			log.Printf("[AUTH-MULTI] session creation failed for %s: %v", uid, err)
			jsonError(w, http.StatusForbidden, err.Error())
			return
		}
		_ = session // session is available for downstream use via userID lookup

		// Set user context for downstream handlers
		r.Header.Set("X-Yaver-UserID", uid)

		next(w, r)
	}
}
