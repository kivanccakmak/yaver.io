package main

// task_proof_http.go — serving the Task Proof package.
//
// Two doors to the same proof, because two different token scopes need it:
//   GET /tasks/{id}/proof                — Yaver surfaces (owner/session auth,
//                                          same wrapper as the rest of /tasks)
//   GET /feedback/{fid}/fix-proof        — the feedback-SDK return lane. SDK
//   GET /feedback/{fid}/fix-proof/video    tokens are scoped to /feedback/*
//   GET /feedback/{fid}/fix-proof/poster   (scopePathPrefixes), so the proof
//                                          for "your bug's fix" must be
//                                          reachable under /feedback or a
//                                          feedback-scoped app can never see
//                                          it. Media is proxied from the clip
//                                          store for the same reason.
// Routes only on the wire — filesystem paths never leave the box.

import (
	"net/http"
	"strings"
)

func requestBaseURL(r *http.Request) string {
	if r == nil {
		return ""
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	} else if proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); proto != "" {
		scheme = proto
	}
	host := strings.TrimSpace(r.Host)
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

// enrichTaskProofView upgrades a stored proof with live clip state and
// stamps absolute media/proof routes for the requesting client.
func enrichTaskProofView(p *TaskProof, r *http.Request) {
	if p == nil {
		return
	}
	if p.Status == "capturing" && p.ClipID != "" {
		switch liveClipStatus(p.ClipID) {
		case "ready":
			p.Status = "ready"
		case "failed":
			p.Status = "failed"
			p.FailedReason = "the demo clip recorder failed to finalize the video"
			p.FailedRoute = "POST /vibing/preview/clip/start"
		}
	}
	if p.ClipID != "" {
		base := requestBaseURL(r)
		path := "/vibing/preview/clip/" + urlQueryEscape(p.ClipID)
		p.VideoURL = base + path
		p.PosterURL = base + path + "/poster"
	}
}

// handleTaskProof serves GET /tasks/{id}/proof.
func (s *HTTPServer) handleTaskProof(w http.ResponseWriter, r *http.Request, taskID string) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	task, ok := s.taskMgr.GetTask(taskID)
	if !ok {
		jsonError(w, http.StatusNotFound, "task not found")
		return
	}
	proof, ok := loadTaskProof(taskID)
	if !ok {
		s.taskMgr.mu.RLock()
		videoEnabled := task.VideoEnabled
		status := task.Status
		s.taskMgr.mu.RUnlock()
		reason := "no proof was recorded for this task"
		if !videoEnabled {
			reason = "proof was not enabled for this task — create the task with video_enabled"
		} else if status == TaskStatusRunning || status == TaskStatusQueued {
			reason = "task is still running — proof is generated at completion"
		}
		jsonReply(w, http.StatusNotFound, map[string]interface{}{
			"ok":    false,
			"error": reason,
		})
		return
	}
	enrichTaskProofView(proof, r)
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":    true,
		"proof": proof,
	})
}

// enrichTaskInfoProof mirrors proof state onto the task DTO (detail
// endpoint only — the list handler skips it to stay cheap).
func (s *HTTPServer) enrichTaskInfoProof(info *TaskInfo, r *http.Request) {
	if info == nil || strings.TrimSpace(info.ProofStatus) == "" {
		return
	}
	if info.ProofStatus == "capturing" && info.VideoClipID != "" {
		if st := liveClipStatus(info.VideoClipID); st == "ready" {
			info.ProofStatus = "ready"
		}
	}
	path := "/tasks/" + urlQueryEscape(info.ID) + "/proof"
	if base := requestBaseURL(r); base != "" {
		info.ProofURL = base + path
	} else {
		info.ProofURL = path
	}
}

// handleFeedbackFixProof serves the feedback-SDK return lane:
// /feedback/{fid}/fix-proof[/video|/poster]. The proof JSON here points
// its media URLs at the fix-proof media subroutes (NOT the clip store)
// so a feedback-scoped SDK token can actually fetch them.
func (s *HTTPServer) handleFeedbackFixProof(w http.ResponseWriter, r *http.Request, feedbackID, sub string) {
	if r.Method != http.MethodGet {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET only"})
		return
	}
	if s.taskMgr == nil {
		jsonReply(w, http.StatusServiceUnavailable, map[string]string{"error": "task manager not running on this agent"})
		return
	}
	if _, ok := s.feedbackMgr.GetFeedback(feedbackID); !ok {
		jsonReply(w, http.StatusNotFound, map[string]string{"error": "feedback not found"})
		return
	}
	task, ok := s.taskMgr.FindTaskByFeedbackID(feedbackID)
	if !ok {
		jsonReply(w, http.StatusNotFound, map[string]string{
			"error": "no fix task is linked to this feedback yet — run POST /feedback/" + feedbackID + "/fix first",
		})
		return
	}
	proof, ok := loadTaskProof(task.ID)
	if !ok {
		jsonReply(w, http.StatusNotFound, map[string]string{
			"error": "the fix task has no proof (proof toggle off, or task still running)",
		})
		return
	}

	switch sub {
	case "video", "poster":
		if proof.ClipID == "" {
			jsonReply(w, http.StatusNotFound, map[string]string{"error": "this proof has no video: " + proof.FailedReason})
			return
		}
		mp4, poster, found := findClipOnDisk(proof.ClipID)
		if !found {
			if mgr := ActiveVibePreviewManager(); mgr != nil {
				if clip := mgr.ClipByID(proof.ClipID); clip != nil {
					mp4, poster = clip.Path, clip.PosterPath
				}
			}
		}
		target := mp4
		if sub == "poster" {
			target = poster
		}
		if strings.TrimSpace(target) == "" {
			jsonReply(w, http.StatusNotFound, map[string]string{"error": "proof media not on disk yet"})
			return
		}
		w.Header().Set("Cache-Control", "private, max-age=86400, immutable")
		http.ServeFile(w, r, target)
		return
	case "":
		enrichTaskProofView(proof, r)
		base := requestBaseURL(r)
		fixBase := base + "/feedback/" + urlQueryEscape(feedbackID) + "/fix-proof"
		if proof.ClipID != "" {
			proof.VideoURL = fixBase + "/video"
			proof.PosterURL = fixBase + "/poster"
		}
		jsonReply(w, http.StatusOK, map[string]interface{}{
			"ok":     true,
			"taskId": task.ID,
			"proof":  proof,
		})
		return
	default:
		jsonReply(w, http.StatusNotFound, map[string]string{"error": "unknown fix-proof subroute"})
	}
}
