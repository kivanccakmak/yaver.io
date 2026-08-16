package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
)

func binaryAvailable(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func browserFramesAvailable() bool {
	return DiscoverChromeBinary() != ""
}

func (s *HTTPServer) requireProjectSessions(w http.ResponseWriter) *ProjectSessionManager {
	if s.projectSessions == nil {
		jsonError(w, http.StatusServiceUnavailable, "project sessions are unavailable")
		return nil
	}
	return s.projectSessions
}

func (s *HTTPServer) handleV2Capabilities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}
	darwinSimulator := runtime.GOOS == "darwin" && binaryAvailable("xcrun")
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"protocolVersion": 2,
		"capabilities": map[string]bool{
			"git":             binaryAvailable("git"),
			"shell":           true,
			"docker":          binaryAvailable("docker"),
			"lint":            true,
			"typecheck":       true,
			"compile":         true,
			"test":            true,
			"browserFrames":   browserFramesAvailable(),
			"androidEmulator": binaryAvailable("emulator"),
			"iosSimulator":    darwinSimulator,
			"tvosSimulator":   darwinSimulator,
			"webrtc":          false,
		},
	})
}

func (s *HTTPServer) handleV2GitConnections(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}
	repositories, err := ListGitRepositories(false)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not read runner Git catalog")
		return
	}
	status := "pending"
	if len(repositories) > 0 {
		status = "ready"
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"connections": []map[string]interface{}{{
			"gitConnectionId": "runner-provisioned",
			"displayName":     "Runner Git access",
			"status":          status,
			"repositoryCount": len(repositories),
		}},
	})
}

func (s *HTTPServer) handleV2GitRepositories(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}
	repositories, err := ListGitRepositories(r.URL.Query().Get("refresh") == "1")
	if err != nil {
		jsonError(w, http.StatusInternalServerError, fmt.Sprintf("list repositories: %v", err))
		return
	}
	jsonReply(w, http.StatusOK, map[string]interface{}{"repositories": repositories})
}

func (s *HTTPServer) handleV2ProjectSessions(w http.ResponseWriter, r *http.Request) {
	manager := s.requireProjectSessions(w)
	if manager == nil {
		return
	}
	switch r.Method {
	case http.MethodGet:
		jsonReply(w, http.StatusOK, map[string]interface{}{"projectSessions": manager.List()})
	case http.MethodPost:
		var body struct {
			RepositoryID string `json:"repositoryId"`
			BaseRef      string `json:"baseRef"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&body); err != nil || strings.TrimSpace(body.RepositoryID) == "" {
			jsonError(w, http.StatusBadRequest, "repositoryId is required")
			return
		}
		session, err := manager.Create(body.RepositoryID, body.BaseRef)
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error())
			return
		}
		jsonReply(w, http.StatusCreated, map[string]interface{}{"projectSession": session})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "use GET or POST")
	}
}

func (s *HTTPServer) handleV2ProjectSessionByID(w http.ResponseWriter, r *http.Request) {
	manager := s.requireProjectSessions(w)
	if manager == nil {
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v2/project-sessions/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		jsonError(w, http.StatusBadRequest, "project session ID is required")
		return
	}
	sessionID := parts[0]
	session, ok := manager.Get(sessionID)
	if !ok {
		jsonError(w, http.StatusNotFound, "project session not found")
		return
	}

	if len(parts) == 1 {
		switch r.Method {
		case http.MethodGet:
			jsonReply(w, http.StatusOK, map[string]interface{}{"projectSession": session})
		case http.MethodDelete:
			s.stopProjectSessionWork(sessionID)
			deleted, err := manager.Delete(sessionID)
			if err != nil {
				jsonError(w, http.StatusInternalServerError, err.Error())
				return
			}
			jsonReply(w, http.StatusOK, map[string]interface{}{"projectSession": deleted, "deleted": true})
		default:
			jsonError(w, http.StatusMethodNotAllowed, "use GET or DELETE")
		}
		return
	}

	if parts[1] == "tasks" {
		s.handleV2ProjectSessionTasks(w, r, session)
		return
	}
	if parts[1] == "stop" && len(parts) == 2 {
		if r.Method != http.MethodPost {
			jsonError(w, http.StatusMethodNotAllowed, "use POST")
			return
		}
		s.stopProjectSessionWork(sessionID)
		stopped, err := manager.Stop(sessionID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, err.Error())
			return
		}
		jsonReply(w, http.StatusOK, map[string]interface{}{"projectSession": stopped})
		return
	}
	if parts[1] == "validation-runs" {
		s.handleV2ValidationRuns(w, r, session, parts[2:])
		return
	}
	if len(parts) == 3 && parts[1] == "git" {
		s.handleV2ProjectSessionGit(w, r, sessionID, parts[2])
		return
	}
	if len(parts) == 3 && parts[1] == "preview" {
		s.handleV2ProjectSessionPreview(w, r, session, parts[2])
		return
	}
	jsonError(w, http.StatusNotFound, "unknown project session action")
}

func (s *HTTPServer) stopProjectSessionWork(sessionID string) {
	_ = s.projectPreviewMgr.Stop(sessionID)
	s.validationMgr.StopSession(sessionID)
	for _, task := range s.taskMgr.ListTasks() {
		if task.ProjectSessionID == sessionID && (task.Status == TaskStatusRunning || task.Status == TaskStatusQueued) {
			_ = s.taskMgr.StopTask(task.ID)
		}
	}
}

func (s *HTTPServer) handleV2ValidationRuns(w http.ResponseWriter, r *http.Request, session *ProjectSession, suffix []string) {
	if len(suffix) == 0 {
		switch r.Method {
		case http.MethodGet:
			jsonReply(w, http.StatusOK, map[string]interface{}{"validationRuns": s.validationMgr.List(session.ProjectSessionID)})
		case http.MethodPost:
			var body struct {
				Kind string `json:"kind"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8*1024)).Decode(&body); err != nil {
				jsonError(w, http.StatusBadRequest, "validation kind is required")
				return
			}
			run, err := s.validationMgr.Start(session, body.Kind)
			if err != nil {
				jsonError(w, http.StatusBadRequest, err.Error())
				return
			}
			jsonReply(w, http.StatusAccepted, map[string]interface{}{"validationRun": run})
		default:
			jsonError(w, http.StatusMethodNotAllowed, "use GET or POST")
		}
		return
	}
	run, ok := s.validationMgr.Get(suffix[0])
	if !ok || run.ProjectSessionID != session.ProjectSessionID {
		jsonError(w, http.StatusNotFound, "validation run not found")
		return
	}
	if len(suffix) == 2 && suffix[1] == "stop" {
		if r.Method != http.MethodPost {
			jsonError(w, http.StatusMethodNotAllowed, "use POST")
			return
		}
		_ = s.validationMgr.Stop(run.ValidationRunID)
		run, _ = s.validationMgr.Get(run.ValidationRunID)
		jsonReply(w, http.StatusOK, map[string]interface{}{"validationRun": run})
		return
	}
	if len(suffix) == 1 && r.Method == http.MethodGet {
		jsonReply(w, http.StatusOK, map[string]interface{}{"validationRun": run})
		return
	}
	jsonError(w, http.StatusNotFound, "unknown validation action")
}

func (s *HTTPServer) handleV2ProjectSessionPreview(w http.ResponseWriter, r *http.Request, session *ProjectSession, action string) {
	switch action {
	case "start":
		if r.Method != http.MethodPost {
			jsonError(w, http.StatusMethodNotAllowed, "use POST")
			return
		}
		var body struct {
			PreviewTarget string `json:"previewTarget"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 8*1024)).Decode(&body)
		status, err := s.projectPreviewMgr.Start(session, body.PreviewTarget)
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error())
			return
		}
		jsonReply(w, http.StatusAccepted, status)
	case "status":
		if r.Method != http.MethodGet {
			jsonError(w, http.StatusMethodNotAllowed, "use GET")
			return
		}
		jsonReply(w, http.StatusOK, s.projectPreviewMgr.Status(session.ProjectSessionID))
	case "stream":
		if r.Method != http.MethodGet {
			jsonError(w, http.StatusMethodNotAllowed, "use GET")
			return
		}
		body, contentType, err := s.projectPreviewMgr.Fetch(session.ProjectSessionID)
		if err != nil {
			jsonError(w, http.StatusBadGateway, err.Error())
			return
		}
		if contentType == "" {
			contentType = "text/html; charset=utf-8"
		}
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	case "stop":
		if r.Method != http.MethodPost {
			jsonError(w, http.StatusMethodNotAllowed, "use POST")
			return
		}
		if err := s.projectPreviewMgr.Stop(session.ProjectSessionID); err != nil && !strings.Contains(err.Error(), "not running") {
			jsonError(w, http.StatusBadRequest, err.Error())
			return
		}
		jsonReply(w, http.StatusOK, s.projectPreviewMgr.Status(session.ProjectSessionID))
	default:
		jsonError(w, http.StatusNotFound, "unknown preview action")
	}
}

func (s *HTTPServer) handleV2ProjectSessionTasks(w http.ResponseWriter, r *http.Request, session *ProjectSession) {
	if session.Status != "ready" {
		jsonError(w, http.StatusConflict, "project session is not ready")
		return
	}
	if r.Method == http.MethodGet {
		all := s.taskMgr.ListTasks()
		filtered := make([]TaskInfo, 0)
		for _, task := range all {
			if task.ProjectSessionID == session.ProjectSessionID {
				filtered = append(filtered, task)
			}
		}
		jsonReply(w, http.StatusOK, map[string]interface{}{"tasks": filtered})
		return
	}
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use GET or POST")
		return
	}
	var body struct {
		Title           string `json:"title"`
		Description     string `json:"description"`
		Model           string `json:"model"`
		ReasoningEffort string `json:"reasoningEffort"`
		Runner          string `json:"runner"`
		CustomCommand   string `json:"customCommand"`
		Mode            string `json:"mode"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024)).Decode(&body); err != nil || strings.TrimSpace(body.Title) == "" {
		jsonError(w, http.StatusBadRequest, "title is required")
		return
	}
	task, err := s.taskMgr.CreateTaskInProjectSession(
		body.Title, body.Description, body.Model, body.ReasoningEffort,
		"cloud-studio", body.Runner, body.CustomCommand, body.Mode,
		session.ProjectSessionID, session.WorkDir,
	)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, fmt.Sprintf("failed to create task: %v", err))
		return
	}
	jsonReply(w, http.StatusCreated, map[string]interface{}{
		"taskId": task.ID, "status": task.Status, "runnerId": task.RunnerID,
		"model": task.Model, "reasoningEffort": body.ReasoningEffort,
		"projectSessionId": task.ProjectSessionID,
	})
}

func (s *HTTPServer) handleV2ProjectSessionGit(w http.ResponseWriter, r *http.Request, sessionID, action string) {
	manager := s.projectSessions
	switch action {
	case "status":
		if r.Method != http.MethodGet {
			jsonError(w, http.StatusMethodNotAllowed, "use GET")
			return
		}
		status, err := manager.GitStatus(sessionID)
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error())
			return
		}
		jsonReply(w, http.StatusOK, status)
	case "diff":
		if r.Method != http.MethodGet {
			jsonError(w, http.StatusMethodNotAllowed, "use GET")
			return
		}
		diff, err := manager.GitDiff(sessionID)
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error())
			return
		}
		jsonReply(w, http.StatusOK, map[string]string{"diff": diff})
	case "commit":
		if r.Method != http.MethodPost {
			jsonError(w, http.StatusMethodNotAllowed, "use POST")
			return
		}
		var body struct {
			Message string `json:"message"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8*1024)).Decode(&body); err != nil {
			jsonError(w, http.StatusBadRequest, "commit message is required")
			return
		}
		sha, err := manager.GitCommit(sessionID, body.Message)
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error())
			return
		}
		jsonReply(w, http.StatusOK, map[string]string{"commitSha": sha})
	case "push-review", "push-review-branch":
		if r.Method != http.MethodPost {
			jsonError(w, http.StatusMethodNotAllowed, "use POST")
			return
		}
		branch, err := manager.PushReview(sessionID)
		if err != nil {
			jsonError(w, http.StatusBadRequest, err.Error())
			return
		}
		jsonReply(w, http.StatusOK, map[string]string{"reviewBranch": branch})
	default:
		jsonError(w, http.StatusNotFound, "unknown Git action")
	}
}
