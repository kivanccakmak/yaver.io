// dom_inspect_http.go — the authenticated door for DOM-mode selections.
//
// Same architecture as screen_context_http.go: the injected probe posts to its
// HOST SURFACE (window.parent / ReactNativeWebView), never to the agent
// directly — /dev/ is deliberately unauthenticated, and an unauthenticated
// write would let anyone on the LAN dictate element context into somebody's AI
// prompt. The surface forwards over its own bearer-authenticated channel.
package main

import (
	"encoding/json"
	"net/http"
	"time"
)

// handleDomInspect serves POST (report), GET (read back) and DELETE (clear) on
// /dom-inspect. Owner-authenticated by the route registration.
func (s *HTTPServer) handleDomInspect(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.postDomInspect(w, r)
	case http.MethodGet:
		s.getDomInspect(w, r)
	case http.MethodDelete:
		globalDomElements.Clear(r.URL.Query().Get("workDir"))
		jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "use GET, POST or DELETE")
	}
}

func (s *HTTPServer) postDomInspect(w http.ResponseWriter, r *http.Request) {
	// Bounded read. The probe caps itself, but a cap enforced only by the
	// party sending the data is not a cap.
	var in DomElement
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10)).Decode(&in); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if in.WorkDir == "" {
		jsonError(w, http.StatusBadRequest, "workDir is required — DOM element context is stored per project")
		return
	}
	stored := globalDomElements.Put(in, time.Now())
	if stored.IsEmpty() {
		jsonReply(w, http.StatusOK, map[string]interface{}{
			"ok":     true,
			"stored": false,
			"reason": "no usable element facts in the report",
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

func (s *HTTPServer) getDomInspect(w http.ResponseWriter, r *http.Request) {
	workDir := r.URL.Query().Get("workDir")
	d, ok := globalDomElements.Get(workDir, time.Now())
	if !ok {
		jsonReply(w, http.StatusOK, map[string]interface{}{
			"ok":      true,
			"present": false,
			"reason":  "no fresh DOM element selection for this project — turn on DOM mode in the preview and click an element, or the selection aged out",
		})
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"present": true,
		"element": d,
		"summary": d.Summary(),
		"block":   FormatDomElementBlock(d),
	})
}

// handleDomInspectItems serves POST (report an inventory) and GET (fetch the
// pickable inventory) on /dom-inspect/items. Owner-authenticated by the route
// registration, exactly like /dom-inspect — the probe never talks to the agent
// directly, its host surface forwards over its own authed channel.
func (s *HTTPServer) handleDomInspectItems(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.postDomInspectItems(w, r)
	case http.MethodGet:
		s.getDomInspectItems(w, r)
	default:
		jsonError(w, http.StatusMethodNotAllowed, "use GET or POST")
	}
}

func (s *HTTPServer) postDomInspectItems(w http.ResponseWriter, r *http.Request) {
	// Bounded read. The probe caps itself, but a cap enforced only by the
	// party sending the data is not a cap.
	var in DomItems
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&in); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if in.WorkDir == "" {
		jsonError(w, http.StatusBadRequest, "workDir is required — DOM items are stored per project")
		return
	}
	stored := globalDomItems.Put(in, time.Now())
	if stored.IsEmpty() {
		jsonReply(w, http.StatusOK, map[string]interface{}{
			"ok":     true,
			"stored": false,
			"reason": "no usable items in the inventory",
		})
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":         true,
		"stored":     true,
		"count":      len(stored.Items),
		"capturedAt": stored.CapturedAt,
	})
}

func (s *HTTPServer) getDomInspectItems(w http.ResponseWriter, r *http.Request) {
	workDir := r.URL.Query().Get("workDir")
	items, ok := globalDomItems.Get(workDir, time.Now())
	if !ok {
		jsonReply(w, http.StatusOK, map[string]interface{}{
			"ok":      true,
			"present": false,
			"reason":  "no fresh DOM items for this project — ask the preview for an inventory (yaver-dom-items), or the inventory aged out",
		})
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":         true,
		"present":    true,
		"items":      items.Items,
		"capturedAt": items.CapturedAt,
	})
}
