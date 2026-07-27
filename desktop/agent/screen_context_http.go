// screen_context_http.go — the authenticated door for screen observations.
//
// # WHY THE SURFACE FORWARDS INSTEAD OF THE PAGE POSTING DIRECTLY
//
// The obvious design is for the injected probe to POST straight to the agent:
// it is same-origin with the `/dev/` proxy, so it would just work. It is also
// wrong. `/dev/` is deliberately unauthenticated (httpserver.go: "No auth —
// serves proxied dev content for browser/webview preview surfaces"), so a
// direct write would mean anyone who can reach :18080 can dictate arbitrary
// text into a block that is prepended to somebody's AI prompt. That is a
// prompt-injection channel with no key on it.
//
// So the probe posts to its HOST SURFACE (window.parent / ReactNativeWebView),
// and the surface — which already holds the user's bearer token — forwards it
// here. Same boundary as every other authenticated route, no relaxation, and
// the semantics are honest: this is the screen THE AUTHENTICATED USER is
// looking at, not whatever a stranger on the LAN claims is on it.
package main

import (
	"encoding/json"
	"net/http"
	"time"
)

// handleScreenContext serves POST (report) and GET (read back) on
// /screen-context. Both are owner-authenticated by the route registration.
func (s *HTTPServer) handleScreenContext(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.postScreenContext(w, r)
	case http.MethodGet:
		s.getScreenContext(w, r)
	case http.MethodDelete:
		globalScreenContexts.Clear(r.URL.Query().Get("workDir"))
		jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "use GET, POST or DELETE")
	}
}

func (s *HTTPServer) postScreenContext(w http.ResponseWriter, r *http.Request) {
	// Bounded read. The probe caps itself, but a cap enforced only by the party
	// sending the data is not a cap.
	var in ScreenContext
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if in.WorkDir == "" {
		// Named explicitly rather than silently ignored: a surface that forgets
		// the workDir would otherwise "succeed" forever while every prompt kept
		// arriving context-free — the unfalsifiable-success shape.
		jsonError(w, http.StatusBadRequest, "workDir is required — screen context is stored per project")
		return
	}
	stored := globalScreenContexts.Put(in, time.Now())
	if stored.IsEmpty() {
		jsonReply(w, http.StatusOK, map[string]interface{}{
			"ok":     true,
			"stored": false,
			"reason": "no usable screen facts in the report",
		})
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":         true,
		"stored":     true,
		"summary":    stored.Summary(),
		"capturedAt": stored.CapturedAt,
	})
}

func (s *HTTPServer) getScreenContext(w http.ResponseWriter, r *http.Request) {
	workDir := r.URL.Query().Get("workDir")
	sc, ok := globalScreenContexts.Get(workDir, time.Now())
	if !ok {
		jsonReply(w, http.StatusOK, map[string]interface{}{
			"ok":      true,
			"present": false,
			// The remedy names the specific reason, not "check your configuration".
			"reason": "no fresh screen context for this project — open a preview, or the last observation aged out",
		})
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"present": true,
		"context": sc,
		"summary": sc.Summary(),
		"block":   FormatScreenContextBlock(sc),
	})
}
