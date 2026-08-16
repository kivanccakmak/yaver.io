package main

// vibe_preview_http.go — HTTP handlers for /vibing/preview/*.
//
// Mounted under /vibing/* so the owner SDK vibing scope prefix
// (httpserver.go scopePathPrefixes) covers reads automatically. Mutating
// endpoints (start/stop) still gate on full owner auth.
//
// Phase 1: start, stop, status, snapshot. SSE event stream + binary frame
// fetch land in Phase 2.

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// handleVibePreviewStart — POST /vibing/preview/start
//
// Body: {project, targetUrl, mode?, profile?, netMode?}
// On success: 200 + the new session JSON. On already-active project: 409.
// On missing browser/Chromium: 503 with install hint.
func (s *HTTPServer) handleVibePreviewStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.vibePreviewMgr == nil {
		jsonError(w, http.StatusServiceUnavailable, "vibe preview not initialised")
		return
	}

	var opts VibePreviewStartOpts
	if err := json.NewDecoder(r.Body).Decode(&opts); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	// X-Yaver-NetMode header is the cellular-aware hint from the mobile
	// client. Body field wins if both are set so callers can override.
	if opts.NetMode == "" {
		opts.NetMode = strings.TrimSpace(r.Header.Get("X-Yaver-NetMode"))
	}
	// Same precedence for the surface: body wins, header is the free fallback
	// every native surface already sends. Recorded so the NEXT surface's refusal
	// can name who holds the lock.
	if opts.Surface == "" {
		opts.Surface = strings.TrimSpace(r.Header.Get("X-Yaver-Surface"))
	}

	sess, err := s.vibePreviewMgr.Start(opts)
	if err != nil {
		// CLASSIFY BY TYPE, never by prose. This switch used to read
		// `strings.Contains(msg, "already active")` against a string produced two
		// files away — the agent regexing its own sentence to pick a status code,
		// one layer earlier than the client-side matchers this codebase already
		// pays for. A rewording in vibe_preview.go silently turned a 409 into a
		// 400 and no test could see it.
		//
		// Both refusals now carry a NAMED cause and an INVOCABLE route, so no
		// surface has to guess and none of them may offer a dead retry.
		var active *PreviewSessionActiveError
		var noBrowser *PreviewBrowserUnavailableError
		var unreachable *PreviewTargetUnreachableError
		switch {
		case errors.As(err, &active):
			jsonErrorWithGap(w, http.StatusConflict, active.Error(), previewSessionActiveGap(active))
		case errors.As(err, &noBrowser):
			jsonErrorWithGap(w, http.StatusServiceUnavailable, noBrowser.Error(), previewBrowserUnavailableGap())
		case errors.As(err, &unreachable):
			// A dev server that is not serving is a ROUTE, not a wall: POST
			// /dev/start with the project pre-filled, streamed, then the start
			// re-issued. 424 Failed Dependency is the honest status — the
			// preview cannot start until its dependency (the dev server) does.
			jsonErrorWithGap(w, http.StatusFailedDependency, unreachable.Error(), previewTargetUnreachableGap(unreachable))
		default:
			jsonError(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"session": sess,
	})
}

// handleVibePreviewStop — POST /vibing/preview/stop
// Body: {project}
func (s *HTTPServer) handleVibePreviewStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.vibePreviewMgr == nil {
		jsonError(w, http.StatusServiceUnavailable, "vibe preview not initialised")
		return
	}
	var req struct {
		Project string `json:"project"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Project) == "" {
		jsonError(w, http.StatusBadRequest, "project is required")
		return
	}
	if err := s.vibePreviewMgr.Stop(req.Project); err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true})
}

// handleVibePreviewStatus — GET /vibing/preview/status
// Returns every active session (no frame data).
func (s *HTTPServer) handleVibePreviewStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	sessions := []*VibePreviewSession{}
	if s.vibePreviewMgr != nil {
		sessions = s.vibePreviewMgr.Status()
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":       true,
		"sessions": sessions,
	})
}

// handleVibePreviewRelease — GET /vibing/preview/release?project=X
//
// "Could a new preview session for this project be claimed right now?" —
// answered, not waited out. Cheap enough to poll at 200 ms; the all-surfaces
// e2e loop replaced a fixed 4-second sleep with it.
func (s *HTTPServer) handleVibePreviewRelease(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	project := strings.TrimSpace(r.URL.Query().Get("project"))
	if project == "" {
		jsonError(w, http.StatusBadRequest, "project query param required")
		return
	}
	// A manager that does not exist cannot be holding anything. Reporting
	// "released" here is the honest answer, not an optimistic one.
	if s.vibePreviewMgr == nil {
		jsonReply(w, http.StatusOK, map[string]interface{}{
			"ok":      true,
			"release": PreviewRelease{Project: project, Released: true},
		})
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"release": s.vibePreviewMgr.ReleaseState(project),
	})
}

// handleVibePreviewSummaries — GET /vibing/preview/summaries?project=X&limit=N
//
// Returns the most-recent N summaries from the on-disk JSONL log,
// newest first. Default limit 50, max 500.
func (s *HTTPServer) handleVibePreviewSummaries(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.vibePreviewMgr == nil {
		jsonError(w, http.StatusServiceUnavailable, "vibe preview not initialised")
		return
	}
	project := strings.TrimSpace(r.URL.Query().Get("project"))
	if project == "" {
		jsonError(w, http.StatusBadRequest, "project query param required")
		return
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	if limit > 500 {
		limit = 500
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":        true,
		"summaries": s.vibePreviewMgr.ListSummaries(project, limit),
	})
}

// handleVibePreviewSnapshot — POST /vibing/preview/snapshot
// Body: {project}
// Forces one capture and returns the new frame's metadata (no bytes — those
// land via /vibing/preview/frames/:hash in Phase 2).
func (s *HTTPServer) handleVibePreviewSnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.vibePreviewMgr == nil {
		jsonError(w, http.StatusServiceUnavailable, "vibe preview not initialised")
		return
	}
	var req struct {
		Project string `json:"project"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Project) == "" {
		jsonError(w, http.StatusBadRequest, "project is required")
		return
	}
	rec, err := s.vibePreviewMgr.Snapshot(req.Project)
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":         true,
		"seq":        rec.Seq,
		"hash":       rec.Hash,
		"size":       len(rec.Bytes),
		"capturedAt": rec.CapturedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
	})
}

// handleVibePreviewSelect — POST /vibing/preview/select
//
// Body: {project, x, y, workDir?}
//
// The tvOS DOM-selection route (the "kumanda" path): the TV draws a cursor
// over the captured frame and sends a viewport coordinate; the box dispatches
// a REAL click at that point in the headless Chrome that produced the frame,
// captures the clicked element (html/css/rect/screenshot — the same payload
// the in-page DOM probe builds), and registers it in the shared domInspect
// store so the per-turn hook attaches it to the next prompt. See
// VibePreviewManager.SelectElement for the full contract.
//
// Coordinates are viewport-relative to the CAPTURED frame. The TV scales its
// cursor position by frameSize/viewportSize before sending, exactly like the
// web cursor lane does.
//
// Returns the normalized stored element (the chip payload surfaces render:
// selector / summary / capturedAt). 404 when no preview session is active for
// the project; 400 on negative coordinates or an unkeyable (workDir-less)
// selection; 503 when the browser backing this session cannot dispatch input.
func (s *HTTPServer) handleVibePreviewSelect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.vibePreviewMgr == nil {
		jsonError(w, http.StatusServiceUnavailable, "vibe preview not initialised")
		return
	}
	var req struct {
		Project string `json:"project"`
		X       int    `json:"x"`
		Y       int    `json:"y"`
		WorkDir string `json:"workDir,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Project) == "" {
		jsonError(w, http.StatusBadRequest, "project is required")
		return
	}
	el, err := s.vibePreviewMgr.SelectElement(req.Project, req.X, req.Y, req.WorkDir, time.Now())
	if err != nil {
		// The three named failures map to honest statuses so surfaces never
		// regex a sentence: no session → 404, no workDir → 400, browser can't
		// input → 503 (capability gap, not a bad request).
		switch {
		case strings.Contains(err.Error(), "no preview session"):
			jsonError(w, http.StatusNotFound, err.Error())
		case strings.Contains(err.Error(), "workDir"), strings.Contains(err.Error(), "coordinates"):
			jsonError(w, http.StatusBadRequest, err.Error())
		case strings.Contains(err.Error(), "cannot dispatch input"):
			jsonError(w, http.StatusServiceUnavailable, err.Error())
		default:
			jsonError(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":         true,
		"element":    el,
		"summary":    el.Summary(),
		"capturedAt": el.CapturedAt,
		// Surface-side metadata: the captured frame's real pixel size vs the
		// requested viewport, so the client (tvOS cursor / remote runtime)
		// maps display coordinates to viewport coordinates without guessing.
		"meta": s.vibePreviewMgr.SelectMeta(req.Project),
	})
}

// handleVibePreviewDomMode — POST /vibing/preview/dom-mode
//
// Body: {project, enabled, workDir?}
//
// Enables or disables DOM mode IN THE CAPTURED PAGE of an active preview
// session — the tvOS equivalent of the web/mobile Browse|Inspect radio. tvOS
// has no WebKit, so the probe runs in the box's headless Chrome and this route
// is what flips it on/off there: while enabled, the probe's hover overlay
// paints on whatever the box's mouse passes over, so the next captured frame
// shows the highlight tracking the TV cursor. Disabling clears the stored
// element (and the items inventory) for the workDir — "off means the agent
// holds nothing", the contract every surface shares.
//
// Returns {ok, workDir} where workDir is the scope the mode was applied to
// (explicit argument, else the session's own) so the surface can keep its
// local state in sync. 404 when no preview session is active; 400 when the
// mode cannot be keyed.
func (s *HTTPServer) handleVibePreviewDomMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.vibePreviewMgr == nil {
		jsonError(w, http.StatusServiceUnavailable, "vibe preview not initialised")
		return
	}
	var req struct {
		Project string `json:"project"`
		Enabled bool   `json:"enabled"`
		WorkDir string `json:"workDir,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Project) == "" {
		jsonError(w, http.StatusBadRequest, "project is required")
		return
	}
	workDir, err := s.vibePreviewMgr.SetDomMode(req.Project, req.Enabled, req.WorkDir)
	if err != nil {
		switch {
		case strings.Contains(err.Error(), "no preview session"):
			jsonError(w, http.StatusNotFound, err.Error())
		case strings.Contains(err.Error(), "cannot dispatch input"):
			jsonError(w, http.StatusServiceUnavailable, err.Error())
		default:
			jsonError(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"enabled": req.Enabled,
		"workDir": workDir,
	})
}

// handleVibePreviewCursor — POST /vibing/preview/cursor
//
// Body: {project, x, y}
//
// The live hover half of the tvOS "kumanda" cursor: moves the box's mouse to
// a viewport coordinate WITHOUT clicking and WITHOUT storing anything, so the
// probe's highlight tracks the Siri Remote swipe in the captured frames. The
// tap that follows is /vibing/preview/select.
func (s *HTTPServer) handleVibePreviewCursor(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.vibePreviewMgr == nil {
		jsonError(w, http.StatusServiceUnavailable, "vibe preview not initialised")
		return
	}
	var req struct {
		Project string `json:"project"`
		X       int    `json:"x"`
		Y       int    `json:"y"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Project) == "" {
		jsonError(w, http.StatusBadRequest, "project is required")
		return
	}
	if err := s.vibePreviewMgr.MoveCursor(req.Project, req.X, req.Y); err != nil {
		switch {
		case strings.Contains(err.Error(), "no preview session"):
			jsonError(w, http.StatusNotFound, err.Error())
		case strings.Contains(err.Error(), "cannot dispatch input"):
			jsonError(w, http.StatusServiceUnavailable, err.Error())
		default:
			jsonError(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true, "x": req.X, "y": req.Y})
}
