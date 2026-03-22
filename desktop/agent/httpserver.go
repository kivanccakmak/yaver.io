package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// HTTPServer serves the V1 HTTP API for mobile clients over Tailscale.
type HTTPServer struct {
	port        int
	token       string
	ownerUserID string
	convexURL   string
	hostname    string
	taskMgr     *TaskManager
	execMgr     *ExecManager
	aclMgr      *ACLManager
	emailMgr    *EmailManager
	server      *http.Server
	onShutdown  func() // called when mobile requests agent shutdown

	// Cache validated tokens (token -> userId) to avoid repeated Convex calls
	tokenCache sync.Map
}

// NewHTTPServer creates a new HTTP server bound to the given port.
func NewHTTPServer(port int, token, ownerUserID, convexURL, hostname string, taskMgr *TaskManager) *HTTPServer {
	return &HTTPServer{
		port:        port,
		token:       token,
		ownerUserID: ownerUserID,
		convexURL:   convexURL,
		hostname:    hostname,
		taskMgr:     taskMgr,
	}
}

// Start starts the HTTP server and blocks until the context is cancelled.
func (s *HTTPServer) Start(ctx context.Context) error {
	mux := http.NewServeMux()

	// Public
	mux.HandleFunc("/health", s.handleHealth)

	// Authenticated
	mux.HandleFunc("/tasks", s.auth(s.handleTasks))
	mux.HandleFunc("/tasks/", s.auth(s.handleTaskByID))
	mux.HandleFunc("/info", s.auth(s.handleInfo))
	mux.HandleFunc("/agent/status", s.auth(s.handleAgentStatus))
	mux.HandleFunc("/agent/runners", s.auth(s.handleRunners))
	mux.HandleFunc("/agent/runner/restart", s.auth(s.handleRunnerRestart))
	mux.HandleFunc("/agent/runner/switch", s.auth(s.handleRunnerSwitch))
	mux.HandleFunc("/agent/shutdown", s.auth(s.handleShutdown))
	mux.HandleFunc("/agent/clean", s.auth(s.handleClean))
	mux.HandleFunc("/agent/doctor", s.auth(s.handleDoctor))
	mux.HandleFunc("/agent/tools", s.auth(s.handleTools))
	mux.HandleFunc("/tmux/sessions", s.auth(s.handleTmuxSessions))
	mux.HandleFunc("/tmux/adopt", s.auth(s.handleTmuxAdopt))
	mux.HandleFunc("/tmux/detach", s.auth(s.handleTmuxDetach))
	mux.HandleFunc("/tmux/input", s.auth(s.handleTmuxInput))

	// Exec (remote command execution)
	mux.HandleFunc("/exec", s.auth(s.handleExec))
	mux.HandleFunc("/exec/", s.auth(s.handleExecByID))

	// MCP (Model Context Protocol) endpoint — JSON-RPC 2.0 over HTTP
	mux.HandleFunc("/mcp", s.handleMCP)

	s.server = &http.Server{
		Addr:    fmt.Sprintf("0.0.0.0:%d", s.port),
		Handler: withCORS(mux),
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.server.Shutdown(shutdownCtx)
	}()

	log.Printf("HTTP server listening on 0.0.0.0:%d", s.port)
	err := s.server.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

func (s *HTTPServer) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			log.Printf("[AUTH] %s %s — missing Authorization header", r.Method, r.URL.Path)
			jsonError(w, http.StatusUnauthorized, "missing or invalid Authorization header")
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")

		// Fast path: exact match with the agent's own token
		if token == s.token {
			next(w, r)
			return
		}

		// Check token cache
		if cachedUID, ok := s.tokenCache.Load(token); ok {
			if cachedUID.(string) == s.ownerUserID {
				next(w, r)
				return
			}
			log.Printf("[AUTH] %s %s — token belongs to different user (cached)", r.Method, r.URL.Path)
			jsonError(w, http.StatusForbidden, "token belongs to a different user")
			return
		}

		// Validate against Convex and cache the result
		log.Printf("[AUTH] %s %s — validating token against Convex...", r.Method, r.URL.Path)
		uid, err := ValidateTokenUser(s.convexURL, token)
		if err != nil {
			log.Printf("[AUTH] %s %s — token validation failed: %v", r.Method, r.URL.Path, err)
			jsonError(w, http.StatusForbidden, "invalid token")
			return
		}
		s.tokenCache.Store(token, uid)
		log.Printf("[AUTH] %s %s — token validated, uid=%s (owner=%s)", r.Method, r.URL.Path, uid, s.ownerUserID)

		if uid != s.ownerUserID {
			log.Printf("[AUTH] %s %s — uid mismatch: got %s, want %s", r.Method, r.URL.Path, uid, s.ownerUserID)
			jsonError(w, http.StatusForbidden, "token belongs to a different user")
			return
		}
		next(w, r)
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

func (s *HTTPServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":       true,
		"hostname": s.hostname,
		"version":  version,
	})
}

func (s *HTTPServer) handleInfo(w http.ResponseWriter, r *http.Request) {
	hostname, _ := os.Hostname()
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":       true,
		"hostname": hostname,
		"version":  version,
		"workDir":  s.taskMgr.workDir,
	})
}

// handleAgentStatus returns detailed agent and runner health status.
func (s *HTTPServer) handleAgentStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}
	status := s.taskMgr.GetAgentStatus()
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":     true,
		"status": status,
	})
}

// handleRunnerRestart checks if the runner is healthy and clears the runnerDown flag.
// Mobile can call this to "restart" the runner after all retries were exhausted.
// handleRunners returns all available runners with their install status and models.
func (s *HTTPServer) handleRunners(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}

	type modelInfo struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description,omitempty"`
		IsDefault   bool   `json:"isDefault,omitempty"`
	}

	type runnerInfo struct {
		ID        string      `json:"id"`
		Name      string      `json:"name"`
		Command   string      `json:"command"`
		Installed bool        `json:"installed"`
		IsDefault bool        `json:"isDefault"`
		Models    []modelInfo `json:"models"`
	}

	// Build models index by runner
	modelsByRunner := make(map[string][]modelInfo)
	for _, m := range GetCachedModels() {
		modelsByRunner[m.RunnerID] = append(modelsByRunner[m.RunnerID], modelInfo{
			ID:          m.ModelID,
			Name:        m.Name,
			Description: m.Description,
			IsDefault:   m.IsDefault,
		})
	}

	var runners []runnerInfo
	seenIDs := make(map[string]bool)

	// Add default runner first, then others sorted by ID
	defaultID := s.taskMgr.runner.RunnerID
	addRunner := func(r RunnerConfig) {
		if seenIDs[r.RunnerID] {
			return
		}
		_, err := osexec.LookPath(r.Command)
		runners = append(runners, runnerInfo{
			ID:        r.RunnerID,
			Name:      r.Name,
			Command:   r.Command,
			Installed: err == nil,
			IsDefault: r.RunnerID == defaultID,
			Models:    modelsByRunner[r.RunnerID],
		})
		seenIDs[r.RunnerID] = true
	}

	// Default runner first
	if r, ok := builtinRunners[defaultID]; ok {
		addRunner(r)
	}
	// Then rest in stable order
	for _, id := range []string{"claude", "codex", "aider"} {
		if r, ok := builtinRunners[id]; ok {
			addRunner(r)
		}
	}
	// Any remaining runners from Convex
	for _, r := range builtinRunners {
		addRunner(r)
	}

	// Include the active runner if it's custom (not in builtinRunners)
	if !seenIDs[s.taskMgr.runner.RunnerID] {
		runners = append(runners, runnerInfo{
			ID:        s.taskMgr.runner.RunnerID,
			Name:      s.taskMgr.runner.Name,
			Command:   s.taskMgr.runner.Command,
			Installed: true,
			IsDefault: true,
			Models:    nil, // custom runners have no predefined models
		})
	}

	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"runners": runners,
		"default": s.taskMgr.runner.RunnerID,
	})
}

func (s *HTTPServer) handleRunnerRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}

	// Check runner health
	if err := s.taskMgr.CheckRunner(); err != nil {
		jsonError(w, http.StatusServiceUnavailable, fmt.Sprintf("runner not available: %v", err))
		return
	}

	// Clear runnerDown flag in Convex
	if s.taskMgr.ConvexURL != "" {
		go func() {
			_ = SetRunnerDown(s.taskMgr.ConvexURL, s.taskMgr.AuthToken, s.taskMgr.DeviceID, false)
			_ = ReportDeviceEvent(s.taskMgr.ConvexURL, s.taskMgr.AuthToken, s.taskMgr.DeviceID, "restart", "manual restart from mobile")
		}()
	}

	log.Printf("[HTTP] Runner restart triggered from mobile — runner is healthy")
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"message": "Runner is healthy, runnerDown flag cleared",
	})
}

// handleRunnerSwitch switches the active runner. Validates the binary exists first.
func (s *HTTPServer) handleRunnerSwitch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}

	var body struct {
		RunnerID string `json:"runnerId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if body.RunnerID == "" {
		jsonError(w, http.StatusBadRequest, "runnerId is required")
		return
	}

	// Map runner IDs to commands
	runnerCommands := map[string]string{
		"claude": "claude",
		"codex":  "codex",
		"aider":  "aider",
	}

	cmd, known := runnerCommands[body.RunnerID]
	if !known {
		jsonError(w, http.StatusBadRequest, fmt.Sprintf("unknown runner: %s (available: claude, codex, aider)", body.RunnerID))
		return
	}

	// Check if binary exists on this machine
	path, err := osexec.LookPath(cmd)
	if err != nil {
		log.Printf("[HTTP] Runner switch failed: %s not found on machine", cmd)
		jsonError(w, http.StatusNotFound, fmt.Sprintf("%s is not installed on this machine", cmd))
		return
	}

	// Build new runner config
	var newRunner RunnerConfig
	switch body.RunnerID {
	case "claude":
		newRunner = defaultRunner
	case "codex":
		newRunner = RunnerConfig{
			RunnerID: "codex",
			Name:     "OpenAI Codex",
			Command:  "codex",
			Args:     []string{"--quiet", "--full-auto", "{prompt}"},
			OutputMode: "raw",
		}
	case "aider":
		newRunner = RunnerConfig{
			RunnerID: "aider",
			Name:     "Aider",
			Command:  "aider",
			Args:     []string{"--yes-always", "--no-git", "--message", "{prompt}"},
			OutputMode:  "raw",
			ExitCommand: "/quit",
		}
	}

	// Update the task manager's runner
	s.taskMgr.mu.Lock()
	s.taskMgr.runner = newRunner
	s.taskMgr.mu.Unlock()

	log.Printf("[HTTP] Runner switched to %s (%s) at %s", newRunner.Name, body.RunnerID, path)

	// Also save to Convex user settings (non-blocking)
	if s.taskMgr.ConvexURL != "" {
		go func() {
			payload, _ := json.Marshal(map[string]string{"runnerId": body.RunnerID})
			req, err := newBearerRequest("POST", s.taskMgr.ConvexURL+"/settings", s.taskMgr.AuthToken, bytes.NewReader(payload))
			if err == nil {
				resp, err := http.DefaultClient.Do(req)
				if err == nil {
					resp.Body.Close()
				}
			}
		}()
	}

	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":       true,
		"runner":   newRunner.Name,
		"runnerId": body.RunnerID,
		"path":     path,
	})
}

// handleShutdown gracefully shuts down the yaver agent. Called from mobile.
func (s *HTTPServer) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}

	log.Printf("[HTTP] Shutdown requested from mobile")

	// Stop all running tasks first
	stopped := s.taskMgr.StopAllTasks()
	log.Printf("[HTTP] Stopped %d tasks before shutdown", stopped)

	// Report event to Convex
	if s.taskMgr.ConvexURL != "" {
		go func() {
			_ = ReportDeviceEvent(s.taskMgr.ConvexURL, s.taskMgr.AuthToken, s.taskMgr.DeviceID, "stopped", "shutdown from mobile")
			_ = MarkOffline(s.taskMgr.ConvexURL, s.taskMgr.AuthToken, s.taskMgr.DeviceID)
		}()
	}

	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"message": "Agent shutting down",
		"stopped": stopped,
	})

	// Trigger shutdown after response is sent
	if s.onShutdown != nil {
		go func() {
			time.Sleep(500 * time.Millisecond) // let response flush
			s.onShutdown()
		}()
	}
}

// handleClean removes old tasks, images, and logs. Called from mobile settings.
func (s *HTTPServer) handleClean(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}
	var body struct {
		Days int  `json:"days"`
		All  bool `json:"all"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Days == 0 {
		body.Days = 30
	}

	result := performClean(body.Days, body.All, false)
	log.Printf("[HTTP] Clean: removed %d tasks, %d image dirs, freed %s", result.TasksRemoved, result.ImagesRemoved, formatBytes(result.BytesFreed))
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":     true,
		"result": result,
	})
}

// handleTasks handles GET /tasks (list) and POST /tasks (create).
func (s *HTTPServer) handleTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.listTasks(w, r)
	case http.MethodPost:
		s.createTask(w, r)
	case http.MethodDelete:
		count := s.taskMgr.DeleteAllTasks()
		jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true, "deleted": count})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *HTTPServer) listTasks(w http.ResponseWriter, r *http.Request) {
	tasks := s.taskMgr.ListTasks()
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":    true,
		"tasks": tasks,
	})
}

func (s *HTTPServer) createTask(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title         string            `json:"title"`
		Description   string            `json:"description"`
		Model         string            `json:"model"`
		Runner        string            `json:"runner"`        // runner ID: "claude", "codex", "aider" — empty uses default
		CustomCommand string            `json:"customCommand"` // arbitrary command — runs via sh -c
		SpeechContext *SpeechContext     `json:"speechContext"` // voice input/output preferences
		Images        []ImageAttachment `json:"images,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if body.Title == "" {
		jsonError(w, http.StatusBadRequest, "title is required")
		return
	}

	task, err := s.taskMgr.CreateTask(body.Title, body.Description, body.Model, "mobile", body.Runner, body.CustomCommand, body.Images, body.SpeechContext)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, fmt.Sprintf("failed to create task: %v", err))
		return
	}

	log.Printf("[HTTP] Task created: %s — %s (status: %s, model: %s, runner: %s)", task.ID, task.Title, task.Status, body.Model, task.RunnerID)
	resp := map[string]interface{}{
		"ok":       true,
		"taskId":   task.ID,
		"status":   task.Status,
		"runnerId": task.RunnerID,
	}
	log.Printf("[HTTP] Sending create response for task %s", task.ID)
	jsonReply(w, http.StatusCreated, resp)
	log.Printf("[HTTP] Response sent for task %s", task.ID)
}

// handleTaskByID routes /tasks/{id}, /tasks/{id}/output, /tasks/{id}/stop, /tasks/{id}/continue
func (s *HTTPServer) handleTaskByID(w http.ResponseWriter, r *http.Request) {
	// Parse path: /tasks/{id}[/action]
	path := strings.TrimPrefix(r.URL.Path, "/tasks/")
	parts := strings.SplitN(path, "/", 2)
	taskID := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	if taskID == "" {
		jsonError(w, http.StatusBadRequest, "task ID required")
		return
	}

	if taskID == "stop-all" {
		s.handleStopAll(w, r)
		return
	}
	if taskID == "delete-all" {
		s.handleDeleteAll(w, r)
		return
	}

	switch action {
	case "":
		if r.Method == http.MethodDelete {
			s.deleteTask(w, r, taskID)
		} else {
			s.getTask(w, r, taskID)
		}
	case "output":
		s.streamOutput(w, r, taskID)
	case "stop":
		s.stopTask(w, r, taskID)
	case "exit":
		s.exitTask(w, r, taskID)
	case "continue":
		s.continueTask(w, r, taskID)
	default:
		jsonError(w, http.StatusNotFound, "unknown action")
	}
}

func (s *HTTPServer) getTask(w http.ResponseWriter, r *http.Request, id string) {
	log.Printf("[HTTP] GET task %s", id)
	task, ok := s.taskMgr.GetTask(id)
	if !ok {
		log.Printf("[HTTP] Task %s not found", id)
		jsonError(w, http.StatusNotFound, "task not found")
		return
	}

	s.taskMgr.mu.RLock()
	output := task.Output
	if len(output) > 10000 {
		output = output[len(output)-10000:]
	}
	info := TaskInfo{
		ID:          task.ID,
		Title:       task.Title,
		Description: task.Description,
		Status:      task.Status,
		RunnerID:    task.RunnerID,
		SessionID:   task.SessionID,
		Output:      output,
		ResultText:  task.ResultText,
		CostUSD:     task.CostUSD,
		Turns:       task.Turns,
		Source:      task.Source,
		TmuxSession: task.TmuxSession,
		IsAdopted:   task.IsAdopted,
		CreatedAt:   task.CreatedAt,
		StartedAt:   task.StartedAt,
		FinishedAt:  task.FinishedAt,
	}
	s.taskMgr.mu.RUnlock()

	log.Printf("[HTTP] Task %s status=%s output_len=%d", id, info.Status, len(info.Output))
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":   true,
		"task": info,
	})
}

// streamOutput streams task output as Server-Sent Events (SSE).
func (s *HTTPServer) streamOutput(w http.ResponseWriter, r *http.Request, id string) {
	log.Printf("[HTTP] SSE stream requested for task %s", id)
	task, ok := s.taskMgr.GetTask(id)
	if !ok {
		log.Printf("[HTTP] SSE task %s not found", id)
		jsonError(w, http.StatusNotFound, "task not found")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		jsonError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()

	// First send any existing output as initial data.
	s.taskMgr.mu.RLock()
	existingOutput := task.Output
	currentStatus := task.Status
	s.taskMgr.mu.RUnlock()

	if existingOutput != "" {
		fmt.Fprintf(w, "data: %s\n\n", jsonString(map[string]interface{}{
			"type": "output",
			"text": existingOutput,
		}))
		flusher.Flush()
	}

	// If already finished, send done event and return.
	if currentStatus == TaskStatusFinished || currentStatus == TaskStatusFailed || currentStatus == TaskStatusStopped {
		fmt.Fprintf(w, "data: %s\n\n", jsonString(map[string]interface{}{
			"type":   "done",
			"status": currentStatus,
		}))
		flusher.Flush()
		return
	}

	// Stream live output from the channel.
	for {
		select {
		case <-ctx.Done():
			return
		case text, ok := <-task.outputCh:
			if !ok {
				// Channel closed — task finished.
				s.taskMgr.mu.RLock()
				finalStatus := task.Status
				s.taskMgr.mu.RUnlock()
				fmt.Fprintf(w, "data: %s\n\n", jsonString(map[string]interface{}{
					"type":   "done",
					"status": finalStatus,
				}))
				flusher.Flush()
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", jsonString(map[string]interface{}{
				"type": "output",
				"text": text,
			}))
			flusher.Flush()
		}
	}
}

func (s *HTTPServer) stopTask(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}

	if err := s.taskMgr.StopTask(id); err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}

	log.Printf("[HTTP] Task stopped: %s", id)
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":     true,
		"taskId": id,
		"status": TaskStatusStopped,
	})
}

func (s *HTTPServer) exitTask(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}

	if err := s.taskMgr.GracefulStopTask(id); err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}

	log.Printf("[HTTP] Task gracefully exited: %s", id)
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":     true,
		"taskId": id,
		"status": TaskStatusStopped,
	})
}

func (s *HTTPServer) deleteTask(w http.ResponseWriter, r *http.Request, id string) {
	if err := s.taskMgr.DeleteTask(id); err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	log.Printf("[HTTP] Task deleted: %s", id)
	jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (s *HTTPServer) handleStopAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}
	count := s.taskMgr.StopAllTasks()
	log.Printf("[HTTP] Stopped all tasks: %d", count)
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"stopped": count,
	})
}

func (s *HTTPServer) handleDeleteAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		jsonError(w, http.StatusMethodNotAllowed, "use DELETE")
		return
	}
	count := s.taskMgr.DeleteAllTasks()
	log.Printf("[HTTP] Deleted all tasks: %d", count)
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"deleted": count,
	})
}

func (s *HTTPServer) continueTask(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}

	var body struct {
		Input  string            `json:"input"`
		Images []ImageAttachment `json:"images,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if body.Input == "" {
		jsonError(w, http.StatusBadRequest, "input is required")
		return
	}

	task, err := s.taskMgr.ResumeTask(id, body.Input, body.Images)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, fmt.Sprintf("resume failed: %v", err))
		return
	}

	log.Printf("[HTTP] Task resumed: %s (session=%s)", id, task.SessionID)
	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":     true,
		"taskId": task.ID,
		"status": task.Status,
	})
}

// ---------------------------------------------------------------------------
// Doctor & Tools handlers
// ---------------------------------------------------------------------------

// handleDoctor runs system diagnostics and returns results as JSON.
func (s *HTTPServer) handleDoctor(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}

	type checkResult struct {
		Name    string `json:"name"`
		Status  string `json:"status"` // "pass", "warn", "fail"
		Detail  string `json:"detail"`
		Section string `json:"section"`
	}

	var checks []checkResult

	addCheck := func(section, name, status, detail string) {
		checks = append(checks, checkResult{Name: name, Status: status, Detail: detail, Section: section})
	}

	// Config
	cfg, err := LoadConfig()
	if err != nil {
		addCheck("config", "Config file", "fail", fmt.Sprintf("Error: %v", err))
	} else {
		p, _ := ConfigPath()
		addCheck("config", "Config file", "pass", p)
	}
	addCheck("config", "Version", "pass", version)

	// Auth
	if cfg == nil || cfg.AuthToken == "" {
		addCheck("auth", "Auth token", "fail", "Not signed in")
	} else {
		addCheck("auth", "Auth token", "pass", "Present")
		if cfg.DeviceID != "" {
			addCheck("auth", "Device ID", "pass", cfg.DeviceID[:8]+"...")
		} else {
			addCheck("auth", "Device ID", "fail", "Not set")
		}
	}

	// Agent
	agentPID, agentRunning := isAgentRunning()
	if agentRunning {
		addCheck("agent", "Agent process", "pass", fmt.Sprintf("Running (PID %d)", agentPID))
	} else {
		addCheck("agent", "Agent process", "warn", "Not running")
	}

	if tmuxAvailable() {
		addCheck("agent", "Tmux", "pass", "available")
	} else {
		addCheck("agent", "Tmux", "warn", "not installed")
	}

	// HTTP server
	statusClient := &http.Client{Timeout: 3 * time.Second}
	if resp, err := statusClient.Get("http://127.0.0.1:18080/health"); err == nil {
		resp.Body.Close()
		addCheck("agent", "HTTP server", "pass", "Listening on :18080")
	} else {
		addCheck("agent", "HTTP server", "warn", "Not reachable on port 18080")
	}

	// AI Runners
	runners := []struct{ id, name, cmd, install string }{
		{"claude", "Claude Code", "claude", "npm install -g @anthropic-ai/claude-code"},
		{"codex", "OpenAI Codex", "codex", "npm install -g @openai/codex"},
		{"aider", "Aider", "aider", "pip install aider-chat"},
		{"ollama", "Ollama", "ollama", "brew install ollama"},
		{"goose", "Goose", "goose", "pip install goose-ai"},
		{"amp", "Amp", "amp", "npm install -g @anthropic/amp"},
		{"opencode", "OpenCode", "opencode", "go install github.com/mbreithecker/opencode@latest"},
	}
	for _, r := range runners {
		p, err := osexec.LookPath(r.cmd)
		if err != nil {
			addCheck("runners", r.name, "warn", "Not installed — "+r.install)
		} else {
			out, verr := osexec.Command(r.cmd, "--version").CombinedOutput()
			if verr == nil {
				ver := strings.TrimSpace(strings.Split(string(out), "\n")[0])
				if len(ver) > 60 {
					ver = ver[:60]
				}
				addCheck("runners", r.name, "pass", fmt.Sprintf("%s (%s)", p, ver))
			} else {
				addCheck("runners", r.name, "pass", p)
			}
		}
	}

	// Relay servers
	if cfg != nil && len(cfg.RelayServers) > 0 {
		relayClient := &http.Client{Timeout: 5 * time.Second}
		for _, rs := range cfg.RelayServers {
			label := rs.Label
			if label == "" {
				label = rs.ID
			}
			start := time.Now()
			resp, err := relayClient.Get(rs.HttpURL + "/health")
			rtt := time.Since(start)
			if err != nil {
				addCheck("relay", "Relay: "+label, "fail", "Unreachable")
			} else {
				resp.Body.Close()
				addCheck("relay", "Relay: "+label, "pass", fmt.Sprintf("OK (%dms)", rtt.Milliseconds()))
			}
		}
	} else {
		addCheck("relay", "Relay servers", "warn", "None configured")
	}

	// Network
	ip := getLocalIP()
	if ip != "" {
		addCheck("network", "Local IP", "pass", ip)
	} else {
		addCheck("network", "Local IP", "warn", "Could not determine")
	}

	// Voice
	if cfg != nil && cfg.Speech != nil && cfg.Speech.Provider != "" {
		addCheck("voice", "Speech provider", "pass", cfg.Speech.Provider)
		if cfg.Speech.TTSEnabled {
			addCheck("voice", "TTS", "pass", "Enabled")
		} else {
			addCheck("voice", "TTS", "pass", "Disabled")
		}
	} else {
		addCheck("voice", "Speech provider", "warn", "Not configured")
	}

	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":     true,
		"checks": checks,
	})
}

// handleTools scans for installed AI tools and returns their info.
func (s *HTTPServer) handleTools(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}

	type toolInfo struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Command   string `json:"command"`
		Installed bool   `json:"installed"`
		Path      string `json:"path,omitempty"`
		Version   string `json:"version,omitempty"`
		Install   string `json:"installCmd"`
	}

	tools := []struct{ id, name, cmd, install string }{
		{"claude", "Claude Code", "claude", "npm install -g @anthropic-ai/claude-code"},
		{"codex", "OpenAI Codex", "codex", "npm install -g @openai/codex"},
		{"aider", "Aider", "aider", "pip install aider-chat"},
		{"ollama", "Ollama", "ollama", "brew install ollama"},
		{"goose", "Goose", "goose", "pip install goose-ai"},
		{"amp", "Amp", "amp", "npm install -g @anthropic/amp"},
		{"opencode", "OpenCode", "opencode", "go install github.com/mbreithecker/opencode@latest"},
		{"qwen", "Qwen", "qwen", "pip install qwen-agent"},
		{"cursor", "Cursor", "cursor", "https://cursor.com"},
	}

	var result []toolInfo
	for _, t := range tools {
		ti := toolInfo{ID: t.id, Name: t.name, Command: t.cmd, Install: t.install}
		p, err := osexec.LookPath(t.cmd)
		if err == nil {
			ti.Installed = true
			ti.Path = p
			out, verr := osexec.Command(t.cmd, "--version").CombinedOutput()
			if verr == nil {
				ver := strings.TrimSpace(strings.Split(string(out), "\n")[0])
				if len(ver) > 60 {
					ver = ver[:60]
				}
				ti.Version = ver
			}
		}
		result = append(result, ti)
	}

	// Also check supporting tools
	type supportTool struct {
		Name      string `json:"name"`
		Command   string `json:"command"`
		Installed bool   `json:"installed"`
		Purpose   string `json:"purpose"`
	}
	var support []supportTool
	supportChecks := []struct{ name, cmd, purpose string }{
		{"tmux", "tmux", "Session management"},
		{"Node.js", "node", "JS toolchain"},
		{"Python", "python3", "Python toolchain"},
		{"Go", "go", "Go toolchain"},
		{"Git", "git", "Version control"},
		{"sox", "sox", "Audio recording"},
		{"ffmpeg", "ffmpeg", "Media processing"},
		{"whisper", "whisper-cpp", "On-device STT"},
		{"Docker", "docker", "Container runtime"},
		{"cloudflared", "cloudflared", "Cloudflare Tunnel"},
	}
	for _, s := range supportChecks {
		st := supportTool{Name: s.name, Command: s.cmd, Purpose: s.purpose}
		if _, err := osexec.LookPath(s.cmd); err == nil {
			st.Installed = true
		}
		support = append(support, st)
	}

	jsonReply(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"tools":   result,
		"support": support,
	})
}

// ---------------------------------------------------------------------------
// Exec handlers (remote command execution)
// ---------------------------------------------------------------------------

func (s *HTTPServer) handleExec(w http.ResponseWriter, r *http.Request) {
	if s.execMgr == nil {
		jsonError(w, http.StatusServiceUnavailable, "exec is not enabled")
		return
	}
	switch r.Method {
	case http.MethodGet:
		sessions := s.execMgr.ListExecs()
		execs := make([]map[string]interface{}, 0, len(sessions))
		for _, sess := range sessions {
			execs = append(execs, sess.Snapshot())
		}
		jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true, "execs": execs})
	case http.MethodPost:
		var body struct {
			Command string            `json:"command"`
			WorkDir string            `json:"workDir,omitempty"`
			Shell   string            `json:"shell,omitempty"`
			Timeout int               `json:"timeout,omitempty"`
			Env     map[string]string `json:"env,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		if body.Command == "" {
			jsonError(w, http.StatusBadRequest, "command is required")
			return
		}
		sess, err := s.execMgr.StartExec(body.Command, body.WorkDir, body.Shell, body.Env, body.Timeout)
		if err != nil {
			code := http.StatusInternalServerError
			if strings.Contains(err.Error(), "blocked") {
				code = http.StatusBadRequest
			} else if strings.Contains(err.Error(), "too many") {
				code = http.StatusTooManyRequests
			}
			jsonError(w, code, err.Error())
			return
		}
		log.Printf("[HTTP] Exec started: %s — %s (pid=%d)", sess.ID, body.Command, sess.PID)
		jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true, "execId": sess.ID, "pid": sess.PID})
	default:
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *HTTPServer) handleExecByID(w http.ResponseWriter, r *http.Request) {
	if s.execMgr == nil {
		jsonError(w, http.StatusServiceUnavailable, "exec is not enabled")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/exec/")
	parts := strings.SplitN(path, "/", 2)
	execID := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}
	if execID == "" {
		jsonError(w, http.StatusBadRequest, "exec ID required")
		return
	}

	switch action {
	case "":
		if r.Method == http.MethodDelete {
			if err := s.execMgr.KillExec(execID); err != nil {
				jsonError(w, http.StatusNotFound, err.Error())
				return
			}
			jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true})
		} else {
			sess, ok := s.execMgr.GetExec(execID)
			if !ok {
				jsonError(w, http.StatusNotFound, "exec session not found")
				return
			}
			jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true, "exec": sess.Snapshot()})
		}
	case "input":
		if r.Method != http.MethodPost {
			jsonError(w, http.StatusMethodNotAllowed, "use POST")
			return
		}
		var body struct {
			Input string `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if err := s.execMgr.SendInput(execID, body.Input); err != nil {
			jsonError(w, http.StatusBadRequest, err.Error())
			return
		}
		jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true})
	case "signal":
		if r.Method != http.MethodPost {
			jsonError(w, http.StatusMethodNotAllowed, "use POST")
			return
		}
		var body struct {
			Signal string `json:"signal"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if err := s.execMgr.SignalExec(execID, body.Signal); err != nil {
			jsonError(w, http.StatusBadRequest, err.Error())
			return
		}
		jsonReply(w, http.StatusOK, map[string]interface{}{"ok": true})
	case "stream":
		s.streamExecOutput(w, r, execID)
	default:
		jsonError(w, http.StatusNotFound, "unknown action")
	}
}

func (s *HTTPServer) streamExecOutput(w http.ResponseWriter, r *http.Request, execID string) {
	ch, err := s.execMgr.Subscribe(execID)
	if err != nil {
		jsonError(w, http.StatusNotFound, err.Error())
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		jsonError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	for evt := range ch {
		data, _ := json.Marshal(evt)
		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
	}
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

func jsonReply(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	jsonReply(w, status, map[string]interface{}{
		"ok":    false,
		"error": msg,
	})
}

func jsonString(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) — JSON-RPC 2.0 over HTTP
// Allows AI agents like Claude to use Yaver as an MCP server.
// ---------------------------------------------------------------------------

type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type mcpResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id"`
	Result  interface{} `json:"result,omitempty"`
	Error   *mcpError   `json:"error,omitempty"`
}

type mcpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *HTTPServer) handleMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "use POST")
		return
	}

	var req mcpRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(mcpResponse{
			JSONRPC: "2.0",
			ID:      nil,
			Error:   &mcpError{Code: -32700, Message: "Parse error"},
		})
		return
	}

	var resp mcpResponse
	resp.JSONRPC = "2.0"
	resp.ID = req.ID

	switch req.Method {
	case "initialize":
		resp.Result = map[string]interface{}{
			"protocolVersion": "2024-11-05",
			"capabilities": map[string]interface{}{
				"tools": map[string]interface{}{},
			},
			"serverInfo": map[string]interface{}{
				"name":    "yaver",
				"version": version,
			},
		}

	case "tools/list":
		resp.Result = s.getMCPToolsList()

	case "tools/call":
		resp.Result = s.handleMCPToolCall(req.Params)

	case "notifications/initialized":
		// Client notification, no response needed but we return empty result
		resp.Result = map[string]interface{}{}

	default:
		resp.Error = &mcpError{Code: -32601, Message: "Method not found: " + req.Method}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(resp)
}

func (s *HTTPServer) handleMCPToolCall(params json.RawMessage) interface{} {
	var call struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(params, &call); err != nil {
		return map[string]interface{}{
			"content": []map[string]interface{}{
				{"type": "text", "text": "Invalid tool call parameters"},
			},
			"isError": true,
		}
	}

	switch call.Name {
	case "create_task":
		var args struct {
			Prompt    string `json:"prompt"`
			Verbosity *int   `json:"verbosity"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.Prompt == "" {
			return mcpToolError("prompt is required")
		}
		var sc *SpeechContext
		if args.Verbosity != nil {
			sc = &SpeechContext{Verbosity: args.Verbosity}
		}
		task, err := s.taskMgr.CreateTask(args.Prompt, "", "", "mcp", "", "", nil, sc)
		if err != nil {
			return mcpToolError(fmt.Sprintf("failed to create task: %v", err))
		}
		log.Printf("[MCP] Task created: %s", task.ID)
		return mcpToolResult(fmt.Sprintf("Task created successfully.\nTask ID: %s\nStatus: %s", task.ID, task.Status))

	case "list_tasks":
		tasks := s.taskMgr.ListTasks()
		if len(tasks) == 0 {
			return mcpToolResult("No tasks found.")
		}
		var sb strings.Builder
		for _, t := range tasks {
			sb.WriteString(fmt.Sprintf("- [%s] %s — %s", t.Status, t.ID, t.Title))
			if t.Status == "running" {
				sb.WriteString(" (running)")
			}
			sb.WriteString("\n")
		}
		return mcpToolResult(sb.String())

	case "get_task":
		var args struct {
			TaskID string `json:"task_id"`
		}
		json.Unmarshal(call.Arguments, &args)
		task, ok := s.taskMgr.GetTask(args.TaskID)
		if !ok {
			return mcpToolError("task not found: " + args.TaskID)
		}
		s.taskMgr.mu.RLock()
		output := task.Output
		status := task.Status
		title := task.Title
		s.taskMgr.mu.RUnlock()
		return mcpToolResult(fmt.Sprintf("Task: %s\nStatus: %s\nTitle: %s\n\nOutput:\n%s", args.TaskID, status, title, output))

	case "stop_task":
		var args struct {
			TaskID string `json:"task_id"`
		}
		json.Unmarshal(call.Arguments, &args)
		if err := s.taskMgr.StopTask(args.TaskID); err != nil {
			return mcpToolError(err.Error())
		}
		log.Printf("[MCP] Task stopped: %s", args.TaskID)
		return mcpToolResult("Task stopped: " + args.TaskID)

	case "continue_task":
		var args struct {
			TaskID string `json:"task_id"`
			Input  string `json:"input"`
		}
		json.Unmarshal(call.Arguments, &args)
		task, err := s.taskMgr.ResumeTask(args.TaskID, args.Input, nil)
		if err != nil {
			return mcpToolError(fmt.Sprintf("resume failed: %v", err))
		}
		log.Printf("[MCP] Task resumed: %s (session=%s)", args.TaskID, task.SessionID)
		return mcpToolResult(fmt.Sprintf("Task resumed. Task ID: %s", task.ID))

	case "get_info":
		hostname, _ := os.Hostname()
		return mcpToolResult(fmt.Sprintf("Hostname: %s\nVersion: %s\nWork Dir: %s", hostname, version, s.taskMgr.workDir))

	// --- Runner Management ---
	case "list_runners":
		var sb strings.Builder
		sb.WriteString("Available runners:\n")
		defaultID := s.taskMgr.runner.RunnerID
		for id, r := range builtinRunners {
			_, err := osexec.LookPath(r.Command)
			installed := "not installed"
			if err == nil {
				installed = "installed"
			}
			def := ""
			if id == defaultID {
				def = " (active)"
			}
			sb.WriteString(fmt.Sprintf("- %s: %s [%s]%s\n", id, r.Name, installed, def))
		}
		return mcpToolResult(sb.String())

	case "switch_runner":
		var args struct {
			RunnerID string `json:"runner_id"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.RunnerID == "" {
			return mcpToolError("runner_id is required")
		}
		r, ok := builtinRunners[args.RunnerID]
		if !ok {
			return mcpToolError(fmt.Sprintf("unknown runner: %s", args.RunnerID))
		}
		if _, err := osexec.LookPath(r.Command); err != nil {
			return mcpToolError(fmt.Sprintf("%s is not installed on this machine", r.Command))
		}
		s.taskMgr.mu.Lock()
		s.taskMgr.runner = r
		s.taskMgr.mu.Unlock()
		log.Printf("[MCP] Runner switched to %s", args.RunnerID)
		return mcpToolResult(fmt.Sprintf("Runner switched to %s (%s)", r.Name, args.RunnerID))

	// --- System & Config ---
	case "get_system_info":
		status := s.taskMgr.GetAgentStatus()
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("Hostname: %s\n", status.System.Hostname))
		sb.WriteString(fmt.Sprintf("OS: %s/%s\n", status.System.OS, status.System.Arch))
		if status.System.MemoryMB > 0 {
			sb.WriteString(fmt.Sprintf("Memory: %d MB\n", status.System.MemoryMB))
		}
		sb.WriteString(fmt.Sprintf("Runner: %s (%s) — %s\n", status.Runner.Name, status.Runner.ID, func() string {
			if status.Runner.Installed {
				return "installed"
			}
			return "not installed"
		}()))
		sb.WriteString(fmt.Sprintf("Running tasks: %d / %d total\n", status.RunningTasks, status.TotalTasks))
		sb.WriteString(fmt.Sprintf("Work dir: %s\n", s.taskMgr.workDir))
		sb.WriteString(fmt.Sprintf("Version: %s\n", version))
		return mcpToolResult(sb.String())

	case "get_config":
		cfg, err := LoadConfig()
		if err != nil {
			return mcpToolError(fmt.Sprintf("load config: %v", err))
		}
		// Redact sensitive fields
		safeCfg := map[string]interface{}{
			"auto_start":   cfg.AutoStart,
			"auto_update":  cfg.AutoUpdate,
			"relay_count":  len(cfg.RelayServers),
			"acl_peers":    len(cfg.ACLPeers),
			"email_configured": cfg.Email != nil && cfg.Email.Provider != "",
		}
		if cfg.Sandbox != nil {
			safeCfg["sandbox"] = map[string]interface{}{
				"enabled":     cfg.Sandbox.Enabled,
				"allow_sudo":  cfg.Sandbox.AllowSudo,
			}
		} else {
			safeCfg["sandbox"] = "default (enabled, no sudo)"
		}
		data, _ := json.MarshalIndent(safeCfg, "", "  ")
		return mcpToolResult(string(data))

	case "set_work_dir":
		var args struct {
			Path string `json:"path"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.Path == "" {
			return mcpToolError("path is required")
		}
		info, err := os.Stat(args.Path)
		if err != nil {
			return mcpToolError(fmt.Sprintf("path not accessible: %v", err))
		}
		if !info.IsDir() {
			return mcpToolError("path is not a directory")
		}
		if err := ValidateWorkDir(args.Path, s.taskMgr.Sandbox); err != nil {
			return mcpToolError(err.Error())
		}
		s.taskMgr.mu.Lock()
		s.taskMgr.workDir = args.Path
		s.taskMgr.mu.Unlock()
		log.Printf("[MCP] Work dir changed to %s", args.Path)
		return mcpToolResult(fmt.Sprintf("Working directory changed to: %s", args.Path))

	case "list_projects":
		fp, err := projectsFilePath()
		if err != nil {
			return mcpToolError(fmt.Sprintf("projects file: %v", err))
		}
		data, err := os.ReadFile(fp)
		if err != nil {
			if os.IsNotExist(err) {
				return mcpToolResult("No projects discovered yet. Run 'yaver discover' to scan.")
			}
			return mcpToolError(fmt.Sprintf("read projects: %v", err))
		}
		content := string(data)
		if len(content) > 5000 {
			content = content[:5000] + "\n... (truncated)"
		}
		return mcpToolResult(content)

	// --- Relay Management ---
	case "get_relay_config":
		cfg, err := LoadConfig()
		if err != nil {
			return mcpToolError(fmt.Sprintf("load config: %v", err))
		}
		if len(cfg.RelayServers) == 0 {
			return mcpToolResult("No relay servers configured. Use add_relay_server to add one.")
		}
		var sb strings.Builder
		for _, rs := range cfg.RelayServers {
			sb.WriteString(fmt.Sprintf("- [%s] %s", rs.ID, rs.QuicAddr))
			if rs.Label != "" {
				sb.WriteString(fmt.Sprintf(" (%s)", rs.Label))
			}
			if rs.Region != "" {
				sb.WriteString(fmt.Sprintf(" region=%s", rs.Region))
			}
			sb.WriteString("\n")
		}
		return mcpToolResult(sb.String())

	case "add_relay_server":
		var args struct {
			QuicAddr string `json:"quic_addr"`
			HttpURL  string `json:"http_url"`
			Password string `json:"password"`
			Label    string `json:"label"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.QuicAddr == "" {
			return mcpToolError("quic_addr is required")
		}
		cfg, err := LoadConfig()
		if err != nil {
			return mcpToolError(fmt.Sprintf("load config: %v", err))
		}
		newRelay := RelayServerConfig{
			ID:       fmt.Sprintf("relay-%d", len(cfg.RelayServers)+1),
			QuicAddr: args.QuicAddr,
			HttpURL:  args.HttpURL,
			Password: args.Password,
			Label:    args.Label,
		}
		cfg.RelayServers = append(cfg.RelayServers, newRelay)
		if err := SaveConfig(cfg); err != nil {
			return mcpToolError(fmt.Sprintf("save config: %v", err))
		}
		log.Printf("[MCP] Relay server added: %s", args.QuicAddr)
		return mcpToolResult(fmt.Sprintf("Relay server added: %s (ID: %s). Restart agent to connect.", args.QuicAddr, newRelay.ID))

	case "remove_relay_server":
		var args struct {
			RelayID string `json:"relay_id"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.RelayID == "" {
			return mcpToolError("relay_id is required")
		}
		cfg, err := LoadConfig()
		if err != nil {
			return mcpToolError(fmt.Sprintf("load config: %v", err))
		}
		found := false
		var remaining []RelayServerConfig
		for _, rs := range cfg.RelayServers {
			if rs.ID == args.RelayID {
				found = true
				continue
			}
			remaining = append(remaining, rs)
		}
		if !found {
			return mcpToolError("relay server not found: " + args.RelayID)
		}
		cfg.RelayServers = remaining
		if err := SaveConfig(cfg); err != nil {
			return mcpToolError(fmt.Sprintf("save config: %v", err))
		}
		return mcpToolResult(fmt.Sprintf("Relay server %s removed. Restart agent to apply.", args.RelayID))

	// --- Filesystem ---
	case "read_file":
		var args struct {
			Path string `json:"path"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.Path == "" {
			return mcpToolError("path is required")
		}
		filePath := s.resolveFilePath(args.Path)
		data, err := os.ReadFile(filePath)
		if err != nil {
			return mcpToolError(fmt.Sprintf("read file: %v", err))
		}
		content := string(data)
		if len(content) > 100*1024 {
			content = content[:100*1024] + "\n... (truncated at 100KB)"
		}
		return mcpToolResult(content)

	case "write_file":
		var args struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.Path == "" || args.Content == "" {
			return mcpToolError("path and content are required")
		}
		filePath := s.resolveFilePath(args.Path)
		dir := filepath.Dir(filePath)
		if err := os.MkdirAll(dir, 0755); err != nil {
			return mcpToolError(fmt.Sprintf("create directory: %v", err))
		}
		if err := os.WriteFile(filePath, []byte(args.Content), 0644); err != nil {
			return mcpToolError(fmt.Sprintf("write file: %v", err))
		}
		return mcpToolResult(fmt.Sprintf("File written: %s (%d bytes)", filePath, len(args.Content)))

	case "list_directory":
		var args struct {
			Path string `json:"path"`
		}
		json.Unmarshal(call.Arguments, &args)
		dirPath := s.taskMgr.workDir
		if args.Path != "" {
			dirPath = s.resolveFilePath(args.Path)
		}
		entries, err := os.ReadDir(dirPath)
		if err != nil {
			return mcpToolError(fmt.Sprintf("list directory: %v", err))
		}
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("Directory: %s\n\n", dirPath))
		for _, e := range entries {
			info, _ := e.Info()
			if info != nil {
				if info.IsDir() {
					sb.WriteString(fmt.Sprintf("  %s/\n", e.Name()))
				} else {
					sb.WriteString(fmt.Sprintf("  %s (%d bytes)\n", e.Name(), info.Size()))
				}
			}
		}
		return mcpToolResult(sb.String())

	case "search_files":
		var args struct {
			Pattern string `json:"pattern"`
			Content string `json:"content"`
			Path    string `json:"path"`
		}
		json.Unmarshal(call.Arguments, &args)
		searchDir := s.taskMgr.workDir
		if args.Path != "" {
			searchDir = s.resolveFilePath(args.Path)
		}

		if args.Content != "" {
			// Grep-style search using OS grep
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := osexec.CommandContext(ctx, "grep", "-rl", "--include="+args.Pattern, args.Content, searchDir)
			out, _ := cmd.Output()
			result := strings.TrimSpace(string(out))
			if result == "" {
				return mcpToolResult("No matches found.")
			}
			lines := strings.Split(result, "\n")
			if len(lines) > 50 {
				lines = lines[:50]
				result = strings.Join(lines, "\n") + "\n... (50+ matches, truncated)"
			}
			return mcpToolResult(result)
		}

		if args.Pattern != "" {
			// Glob-style file search
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := osexec.CommandContext(ctx, "find", searchDir, "-name", args.Pattern, "-type", "f")
			out, _ := cmd.Output()
			result := strings.TrimSpace(string(out))
			if result == "" {
				return mcpToolResult("No files found matching pattern.")
			}
			lines := strings.Split(result, "\n")
			if len(lines) > 50 {
				lines = lines[:50]
				result = strings.Join(lines, "\n") + "\n... (50+ files, truncated)"
			}
			return mcpToolResult(result)
		}

		return mcpToolError("provide either 'pattern' (glob) or 'content' (grep) to search")

	// --- Email ---
	case "email_list_inbox":
		if s.emailMgr == nil {
			return mcpToolError("Email not configured. Run 'yaver email setup' first.")
		}
		var args struct {
			Folder string `json:"folder"`
			Search string `json:"search"`
			Limit  int    `json:"limit"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.Limit <= 0 {
			args.Limit = 20
		}
		if args.Folder == "" {
			args.Folder = "inbox"
		}
		emails, err := s.emailMgr.ListInbox(args.Folder, args.Search, args.Limit)
		if err != nil {
			return mcpToolError(fmt.Sprintf("list inbox: %v", err))
		}
		if len(emails) == 0 {
			return mcpToolResult("No emails found.")
		}
		data, _ := json.MarshalIndent(emails, "", "  ")
		return mcpToolResult(string(data))

	case "email_get":
		if s.emailMgr == nil {
			return mcpToolError("Email not configured. Run 'yaver email setup' first.")
		}
		var args struct {
			EmailID string `json:"email_id"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.EmailID == "" {
			return mcpToolError("email_id is required")
		}
		email, err := s.emailMgr.GetEmail(args.EmailID)
		if err != nil {
			return mcpToolError(fmt.Sprintf("get email: %v", err))
		}
		data, _ := json.MarshalIndent(email, "", "  ")
		return mcpToolResult(string(data))

	case "email_send":
		if s.emailMgr == nil {
			return mcpToolError("Email not configured. Run 'yaver email setup' first.")
		}
		var args struct {
			To      string `json:"to"`
			Subject string `json:"subject"`
			Body    string `json:"body"`
			CC      string `json:"cc"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.To == "" || args.Subject == "" || args.Body == "" {
			return mcpToolError("to, subject, and body are required")
		}
		if err := s.emailMgr.SendEmail(args.To, args.Subject, args.Body, args.CC); err != nil {
			return mcpToolError(fmt.Sprintf("send email: %v", err))
		}
		return mcpToolResult(fmt.Sprintf("Email sent to %s: %s", args.To, args.Subject))

	case "email_sync":
		if s.emailMgr == nil {
			return mcpToolError("Email not configured. Run 'yaver email setup' first.")
		}
		count, err := s.emailMgr.SyncEmails()
		if err != nil {
			return mcpToolError(fmt.Sprintf("sync failed: %v", err))
		}
		return mcpToolResult(fmt.Sprintf("Synced %d emails to local database.", count))

	case "email_search":
		if s.emailMgr == nil {
			return mcpToolError("Email not configured. Run 'yaver email setup' first.")
		}
		var args struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.Query == "" {
			return mcpToolError("query is required")
		}
		if args.Limit <= 0 {
			args.Limit = 20
		}
		emails, err := s.emailMgr.SearchEmails(args.Query, args.Limit)
		if err != nil {
			return mcpToolError(fmt.Sprintf("search: %v", err))
		}
		if len(emails) == 0 {
			return mcpToolResult("No emails found matching query.")
		}
		data, _ := json.MarshalIndent(emails, "", "  ")
		return mcpToolResult(string(data))

	// --- ACL (Agent Communication Layer) ---
	case "acl_list_peers":
		if s.aclMgr == nil {
			return mcpToolResult("ACL not initialized. No peers configured.")
		}
		peers := s.aclMgr.ListPeers()
		if len(peers) == 0 {
			return mcpToolResult("No MCP peers connected. Use acl_add_peer to connect to another MCP server.")
		}
		data, _ := json.MarshalIndent(peers, "", "  ")
		return mcpToolResult(string(data))

	case "acl_add_peer":
		if s.aclMgr == nil {
			return mcpToolError("ACL not initialized")
		}
		var args struct {
			Name string `json:"name"`
			URL  string `json:"url"`
			Auth string `json:"auth"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.Name == "" || args.URL == "" {
			return mcpToolError("name and url are required")
		}
		peer := ACLPeerConfig{
			ID:   strings.ToLower(strings.ReplaceAll(args.Name, " ", "-")),
			Name: args.Name,
			URL:  args.URL,
			Type: "http",
			Auth: args.Auth,
		}
		if err := s.aclMgr.AddPeer(peer); err != nil {
			return mcpToolError(fmt.Sprintf("add peer: %v", err))
		}
		// Persist to config
		cfg, _ := LoadConfig()
		if cfg != nil {
			cfg.ACLPeers = append(cfg.ACLPeers, peer)
			SaveConfig(cfg)
		}
		return mcpToolResult(fmt.Sprintf("Connected to MCP peer: %s (%s)", args.Name, args.URL))

	case "acl_remove_peer":
		if s.aclMgr == nil {
			return mcpToolError("ACL not initialized")
		}
		var args struct {
			PeerID string `json:"peer_id"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.PeerID == "" {
			return mcpToolError("peer_id is required")
		}
		if err := s.aclMgr.RemovePeer(args.PeerID); err != nil {
			return mcpToolError(err.Error())
		}
		// Persist removal to config
		cfg, _ := LoadConfig()
		if cfg != nil {
			var remaining []ACLPeerConfig
			for _, p := range cfg.ACLPeers {
				if p.ID != args.PeerID {
					remaining = append(remaining, p)
				}
			}
			cfg.ACLPeers = remaining
			SaveConfig(cfg)
		}
		return mcpToolResult(fmt.Sprintf("Disconnected from peer: %s", args.PeerID))

	case "acl_list_peer_tools":
		if s.aclMgr == nil {
			return mcpToolError("ACL not initialized")
		}
		var args struct {
			PeerID string `json:"peer_id"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.PeerID == "" {
			return mcpToolError("peer_id is required")
		}
		tools, err := s.aclMgr.ListPeerTools(args.PeerID)
		if err != nil {
			return mcpToolError(fmt.Sprintf("list tools: %v", err))
		}
		data, _ := json.MarshalIndent(tools, "", "  ")
		return mcpToolResult(string(data))

	case "acl_call_peer_tool":
		if s.aclMgr == nil {
			return mcpToolError("ACL not initialized")
		}
		var args struct {
			PeerID   string          `json:"peer_id"`
			ToolName string          `json:"tool_name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.PeerID == "" || args.ToolName == "" {
			return mcpToolError("peer_id and tool_name are required")
		}
		result, err := s.aclMgr.CallPeerTool(args.PeerID, args.ToolName, args.Arguments)
		if err != nil {
			return mcpToolError(fmt.Sprintf("call tool: %v", err))
		}
		data, _ := json.MarshalIndent(result, "", "  ")
		return mcpToolResult(string(data))

	case "acl_health":
		if s.aclMgr == nil {
			return mcpToolResult("ACL not initialized. No peers configured.")
		}
		health := s.aclMgr.HealthCheck()
		var sb strings.Builder
		for id, ok := range health {
			status := "healthy"
			if !ok {
				status = "unreachable"
			}
			sb.WriteString(fmt.Sprintf("- %s: %s\n", id, status))
		}
		return mcpToolResult(sb.String())

	// --- Tmux Session Management ---
	case "tmux_list_sessions":
		tmuxMgr := s.taskMgr.TmuxMgr
		if tmuxMgr == nil {
			return mcpToolResult("Tmux is not available on this machine. Install tmux to use session adoption.")
		}
		sessions, err := tmuxMgr.ListTmuxSessions()
		if err != nil {
			return mcpToolError(fmt.Sprintf("list sessions: %v", err))
		}
		if len(sessions) == 0 {
			return mcpToolResult("No tmux sessions found.")
		}
		var sb strings.Builder
		sb.WriteString("Tmux sessions:\n")
		for _, s := range sessions {
			agent := s.AgentType
			if agent == "" {
				agent = "shell"
			}
			sb.WriteString(fmt.Sprintf("- %s [%s] %s, %d window(s)", s.Name, s.Relationship, agent, s.Windows))
			if s.TaskID != "" {
				sb.WriteString(fmt.Sprintf(", task=%s", s.TaskID))
			}
			if s.Attached {
				sb.WriteString(" (attached)")
			}
			sb.WriteString("\n")
		}
		return mcpToolResult(sb.String())

	case "tmux_adopt_session":
		var args struct {
			SessionName string `json:"session_name"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.SessionName == "" {
			return mcpToolError("session_name is required")
		}
		tmuxMgr := s.taskMgr.TmuxMgr
		if tmuxMgr == nil {
			return mcpToolError("tmux is not available on this machine")
		}
		task, err := tmuxMgr.AdoptSession(args.SessionName)
		if err != nil {
			return mcpToolError(fmt.Sprintf("adopt failed: %v", err))
		}
		log.Printf("[MCP] Adopted tmux session %q as task %s", args.SessionName, task.ID)
		return mcpToolResult(fmt.Sprintf("Adopted tmux session %q as task %s.\nStatus: %s\nRunner: %s", args.SessionName, task.ID, task.Status, task.RunnerID))

	case "tmux_detach_session":
		var args struct {
			TaskID string `json:"task_id"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.TaskID == "" {
			return mcpToolError("task_id is required")
		}
		tmuxMgr := s.taskMgr.TmuxMgr
		if tmuxMgr == nil {
			return mcpToolError("tmux is not available on this machine")
		}
		if err := tmuxMgr.DetachSession(args.TaskID); err != nil {
			return mcpToolError(fmt.Sprintf("detach failed: %v", err))
		}
		log.Printf("[MCP] Detached tmux session (task %s)", args.TaskID)
		return mcpToolResult(fmt.Sprintf("Detached task %s. The tmux session continues running.", args.TaskID))

	case "tmux_send_input":
		var args struct {
			TaskID string `json:"task_id"`
			Input  string `json:"input"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.TaskID == "" {
			return mcpToolError("task_id is required")
		}
		tmuxMgr := s.taskMgr.TmuxMgr
		if tmuxMgr == nil {
			return mcpToolError("tmux is not available on this machine")
		}
		if err := tmuxMgr.SendTmuxInput(args.TaskID, args.Input); err != nil {
			return mcpToolError(fmt.Sprintf("send input failed: %v", err))
		}
		return mcpToolResult("Input sent to tmux session.")

	// --- Diagnostics & Status ---
	case "yaver_doctor":
		return s.mcpDoctor()

	case "yaver_status":
		return s.mcpStatus()

	case "yaver_devices":
		cfg, err := LoadConfig()
		if err != nil || cfg.AuthToken == "" || cfg.ConvexSiteURL == "" {
			return mcpToolError("Not signed in. Run 'yaver auth' first.")
		}
		devices, err := listDevices(cfg.ConvexSiteURL, cfg.AuthToken)
		if err != nil {
			return mcpToolError(fmt.Sprintf("list devices: %v", err))
		}
		if len(devices) == 0 {
			return mcpToolResult("No devices registered. Run 'yaver serve' on your dev machine to register it.")
		}
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("%-10s  %-20s  %-8s  %-8s  %s\n", "ID", "NAME", "PLATFORM", "STATUS", "ADDRESS"))
		for _, d := range devices {
			status := "offline"
			if d.IsOnline {
				status = "online"
			}
			id := d.DeviceID
			if len(id) > 8 {
				id = id[:8] + "..."
			}
			sb.WriteString(fmt.Sprintf("%-10s  %-20s  %-8s  %-8s  %s:%d\n",
				id, d.Name, d.Platform, status, d.QuicHost, d.QuicPort))
		}
		return mcpToolResult(sb.String())

	case "yaver_logs":
		var args struct {
			Lines int `json:"lines"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.Lines <= 0 {
			args.Lines = 50
		}
		if args.Lines > 500 {
			args.Lines = 500
		}
		lp := logFilePath()
		if lp == "" {
			return mcpToolError("Could not determine log file path")
		}
		out, err := osexec.Command("tail", "-n", fmt.Sprintf("%d", args.Lines), lp).CombinedOutput()
		if err != nil {
			if strings.Contains(string(out), "No such file") {
				return mcpToolResult("No logs found. Start the agent with 'yaver serve'.")
			}
			return mcpToolError(fmt.Sprintf("read logs: %v: %s", err, string(out)))
		}
		return mcpToolResult(string(out))

	case "yaver_clear_logs":
		lp := logFilePath()
		if lp == "" {
			return mcpToolError("Could not determine log file path")
		}
		if err := os.Truncate(lp, 0); err != nil {
			if os.IsNotExist(err) {
				return mcpToolResult("No log file to clear.")
			}
			return mcpToolError(fmt.Sprintf("clear logs: %v", err))
		}
		log.Printf("[MCP] Logs cleared")
		return mcpToolResult("Agent logs cleared.")

	case "yaver_help":
		var args struct {
			Topic string `json:"topic"`
		}
		json.Unmarshal(call.Arguments, &args)
		return mcpToolResult(yaverHelpText(args.Topic))

	case "yaver_ping":
		hostname, _ := os.Hostname()
		return mcpToolResult(fmt.Sprintf("Pong! Agent is alive.\nHostname: %s\nVersion: %s\nWork Dir: %s", hostname, version, s.taskMgr.workDir))

	case "agent_shutdown":
		var args struct {
			Confirm bool `json:"confirm"`
		}
		json.Unmarshal(call.Arguments, &args)
		if !args.Confirm {
			return mcpToolError("You must pass confirm: true to shut down the agent.")
		}
		log.Printf("[MCP] Shutdown requested")
		// Trigger shutdown after returning the response
		go func() {
			time.Sleep(500 * time.Millisecond)
			if s.onShutdown != nil {
				s.onShutdown()
			}
		}()
		return mcpToolResult("Agent shutdown initiated. All running tasks will be stopped.")

	// --- Config Management ---
	case "config_set":
		var args struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.Key == "" || args.Value == "" {
			return mcpToolError("key and value are required")
		}
		cfg, err := LoadConfig()
		if err != nil {
			return mcpToolError(fmt.Sprintf("load config: %v", err))
		}
		switch args.Key {
		case "auto-start":
			cfg.AutoStart = args.Value == "true" || args.Value == "1" || args.Value == "yes"
			if err := SaveConfig(cfg); err != nil {
				return mcpToolError(fmt.Sprintf("save config: %v", err))
			}
			return mcpToolResult(fmt.Sprintf("auto-start set to %v", cfg.AutoStart))
		case "auto-update":
			cfg.AutoUpdate = args.Value == "true" || args.Value == "1" || args.Value == "yes"
			if err := SaveConfig(cfg); err != nil {
				return mcpToolError(fmt.Sprintf("save config: %v", err))
			}
			return mcpToolResult(fmt.Sprintf("auto-update set to %v", cfg.AutoUpdate))
		default:
			return mcpToolError(fmt.Sprintf("Unknown config key: %s. Supported: auto-start, auto-update", args.Key))
		}

	case "relay_test":
		var args struct {
			URL string `json:"url"`
		}
		json.Unmarshal(call.Arguments, &args)
		var urls []string
		if args.URL != "" {
			urls = []string{strings.TrimRight(args.URL, "/")}
		} else {
			cfg, err := LoadConfig()
			if err != nil {
				return mcpToolError(fmt.Sprintf("load config: %v", err))
			}
			for _, rs := range cfg.RelayServers {
				urls = append(urls, rs.HttpURL)
			}
			if len(urls) == 0 {
				return mcpToolResult("No relay servers configured. Use add_relay_server or pass a URL.")
			}
		}
		client := &http.Client{Timeout: 10 * time.Second}
		var sb strings.Builder
		for _, u := range urls {
			start := time.Now()
			resp, err := client.Get(u + "/health")
			rtt := time.Since(start)
			if err != nil {
				sb.WriteString(fmt.Sprintf("FAIL  %s  error: %v\n", u, err))
				continue
			}
			resp.Body.Close()
			if resp.StatusCode == 200 {
				sb.WriteString(fmt.Sprintf("OK    %s  %dms\n", u, rtt.Milliseconds()))
			} else {
				sb.WriteString(fmt.Sprintf("FAIL  %s  status: %d\n", u, resp.StatusCode))
			}
		}
		return mcpToolResult(sb.String())

	case "relay_set_password":
		var args struct {
			Password string `json:"password"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.Password == "" {
			return mcpToolError("password is required")
		}
		cfg, err := LoadConfig()
		if err != nil {
			return mcpToolError(fmt.Sprintf("load config: %v", err))
		}
		cfg.RelayPassword = args.Password
		if err := SaveConfig(cfg); err != nil {
			return mcpToolError(fmt.Sprintf("save config: %v", err))
		}
		signalRunningAgent()
		log.Printf("[MCP] Relay password set")
		return mcpToolResult("Relay password saved. Agent notified.")

	case "relay_clear_password":
		cfg, err := LoadConfig()
		if err != nil {
			return mcpToolError(fmt.Sprintf("load config: %v", err))
		}
		if cfg.RelayPassword == "" {
			return mcpToolResult("No relay password was set.")
		}
		cfg.RelayPassword = ""
		if err := SaveConfig(cfg); err != nil {
			return mcpToolError(fmt.Sprintf("save config: %v", err))
		}
		signalRunningAgent()
		log.Printf("[MCP] Relay password cleared")
		return mcpToolResult("Relay password cleared. Agent notified.")

	// --- Tunnel Management ---
	case "tunnel_list":
		cfg, err := LoadConfig()
		if err != nil {
			return mcpToolError(fmt.Sprintf("load config: %v", err))
		}
		if len(cfg.CloudflareTunnels) == 0 {
			return mcpToolResult("No Cloudflare Tunnels configured.\nAdd one with: yaver tunnel add <url>")
		}
		var sb strings.Builder
		sb.WriteString("Cloudflare Tunnels:\n")
		for _, t := range cfg.CloudflareTunnels {
			cfAccess := "no"
			if t.CFAccessClientId != "" {
				cfAccess = "yes"
			}
			label := t.Label
			if label == "" {
				label = "-"
			}
			sb.WriteString(fmt.Sprintf("- %s  %s  (CF Access: %s, label: %s)\n", t.ID, t.URL, cfAccess, label))
		}
		return mcpToolResult(sb.String())

	case "tunnel_add":
		var args struct {
			URL            string `json:"url"`
			CFClientId     string `json:"cf_client_id"`
			CFClientSecret string `json:"cf_client_secret"`
			Label          string `json:"label"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.URL == "" {
			return mcpToolError("url is required")
		}
		rawURL := strings.TrimRight(args.URL, "/")
		id := fmt.Sprintf("%x", func() uint32 {
			var h uint32
			for _, c := range rawURL {
				h = h*31 + uint32(c)
			}
			return h
		}())
		if len(id) > 8 {
			id = id[:8]
		}
		cfg, err := LoadConfig()
		if err != nil {
			return mcpToolError(fmt.Sprintf("load config: %v", err))
		}
		for _, t := range cfg.CloudflareTunnels {
			if t.URL == rawURL {
				return mcpToolError(fmt.Sprintf("Tunnel already configured: %s (id: %s)", rawURL, t.ID))
			}
		}
		tunnel := CloudflareTunnelConfig{
			ID:                   id,
			URL:                  rawURL,
			CFAccessClientId:     args.CFClientId,
			CFAccessClientSecret: args.CFClientSecret,
			Label:                args.Label,
			Priority:             len(cfg.CloudflareTunnels) + 1,
		}
		cfg.CloudflareTunnels = append(cfg.CloudflareTunnels, tunnel)
		if err := SaveConfig(cfg); err != nil {
			return mcpToolError(fmt.Sprintf("save config: %v", err))
		}
		log.Printf("[MCP] Added Cloudflare Tunnel: %s", rawURL)
		return mcpToolResult(fmt.Sprintf("Added Cloudflare Tunnel:\n  ID: %s\n  URL: %s\n  CF Access: %v", id, rawURL, args.CFClientId != ""))

	case "tunnel_remove":
		var args struct {
			TunnelID string `json:"tunnel_id"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.TunnelID == "" {
			return mcpToolError("tunnel_id is required")
		}
		cfg, err := LoadConfig()
		if err != nil {
			return mcpToolError(fmt.Sprintf("load config: %v", err))
		}
		found := false
		var remaining []CloudflareTunnelConfig
		for _, t := range cfg.CloudflareTunnels {
			if t.ID == args.TunnelID || t.URL == args.TunnelID {
				found = true
				log.Printf("[MCP] Removed Cloudflare Tunnel: %s (%s)", t.URL, t.ID)
			} else {
				remaining = append(remaining, t)
			}
		}
		if !found {
			return mcpToolError(fmt.Sprintf("Tunnel not found: %s", args.TunnelID))
		}
		cfg.CloudflareTunnels = remaining
		if err := SaveConfig(cfg); err != nil {
			return mcpToolError(fmt.Sprintf("save config: %v", err))
		}
		return mcpToolResult(fmt.Sprintf("Removed tunnel: %s", args.TunnelID))

	case "tunnel_test":
		var args struct {
			URL string `json:"url"`
		}
		json.Unmarshal(call.Arguments, &args)
		var tunnels []CloudflareTunnelConfig
		if args.URL != "" {
			tunnels = []CloudflareTunnelConfig{{URL: strings.TrimRight(args.URL, "/")}}
		} else {
			cfg, err := LoadConfig()
			if err != nil {
				return mcpToolError(fmt.Sprintf("load config: %v", err))
			}
			tunnels = cfg.CloudflareTunnels
			if len(tunnels) == 0 {
				return mcpToolResult("No tunnels configured. Pass a URL or add with tunnel_add.")
			}
		}
		client := &http.Client{Timeout: 10 * time.Second}
		var sb strings.Builder
		for _, t := range tunnels {
			req, _ := http.NewRequest("GET", t.URL+"/health", nil)
			if t.CFAccessClientId != "" {
				req.Header.Set("CF-Access-Client-Id", t.CFAccessClientId)
				req.Header.Set("CF-Access-Client-Secret", t.CFAccessClientSecret)
			}
			start := time.Now()
			resp, err := client.Do(req)
			rtt := time.Since(start)
			if err != nil {
				sb.WriteString(fmt.Sprintf("FAIL  %s  error: %v\n", t.URL, err))
				continue
			}
			resp.Body.Close()
			if resp.StatusCode == 200 {
				sb.WriteString(fmt.Sprintf("OK    %s  %dms\n", t.URL, rtt.Milliseconds()))
			} else {
				sb.WriteString(fmt.Sprintf("FAIL  %s  status: %d\n", t.URL, resp.StatusCode))
			}
		}
		return mcpToolResult(sb.String())

	default:
		return mcpToolError("unknown tool: " + call.Name)
	}
}

// mcpDoctor runs a doctor-like health check and returns results as text.
func (s *HTTPServer) mcpDoctor() interface{} {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Yaver Doctor (v%s)\n\n", version))

	ok, warn, fail := 0, 0, 0
	check := func(name, status, detail string) {
		icon := "✓"
		switch status {
		case "warn":
			icon = "!"
			warn++
		case "fail":
			icon = "✗"
			fail++
		default:
			ok++
		}
		sb.WriteString(fmt.Sprintf("  %-30s %s %s\n", name, icon, detail))
	}

	// Config
	sb.WriteString("── Configuration ──\n")
	cfg, err := LoadConfig()
	if err != nil {
		check("Config file", "fail", fmt.Sprintf("Error: %v", err))
	} else {
		p, _ := ConfigPath()
		check("Config file", "ok", p)
	}

	// Auth
	sb.WriteString("\n── Authentication ──\n")
	if cfg == nil || cfg.AuthToken == "" {
		check("Auth token", "fail", "Not signed in — run 'yaver auth'")
	} else {
		check("Auth token", "ok", "Present")
		if cfg.DeviceID != "" {
			check("Device ID", "ok", cfg.DeviceID[:8]+"...")
		} else {
			check("Device ID", "fail", "Not set — run 'yaver serve'")
		}
		if cfg.ConvexSiteURL != "" {
			check("Backend", "ok", cfg.ConvexSiteURL)
		} else {
			check("Backend", "fail", "Not configured")
		}
	}

	// Agent
	sb.WriteString("\n── Agent ──\n")
	agentPID, agentRunning := isAgentRunning()
	if agentRunning {
		check("Agent process", "ok", fmt.Sprintf("Running (PID %d)", agentPID))
	} else {
		check("Agent process", "warn", "Not running — start with 'yaver serve'")
	}

	if tmuxAvailable() {
		check("Tmux", "ok", "available")
	} else {
		check("Tmux", "warn", "not installed — session adoption requires tmux")
	}

	// Tasks
	status := s.taskMgr.GetAgentStatus()
	check("Tasks", "ok", fmt.Sprintf("%d running, %d total", status.RunningTasks, status.TotalTasks))

	// Runners
	sb.WriteString("\n── AI Runners ──\n")
	runners := []struct{ id, name, cmd string }{
		{"claude", "Claude Code", "claude"},
		{"codex", "OpenAI Codex", "codex"},
		{"aider", "Aider", "aider"},
		{"ollama", "Ollama", "ollama"},
		{"goose", "Goose", "goose"},
		{"amp", "Amp", "amp"},
		{"opencode", "OpenCode", "opencode"},
	}
	for _, r := range runners {
		path, err := osexec.LookPath(r.cmd)
		if err != nil {
			check(r.name, "warn", "Not installed")
		} else {
			check(r.name, "ok", path)
		}
	}

	// Relay
	sb.WriteString("\n── Relay Servers ──\n")
	if cfg != nil && len(cfg.RelayServers) > 0 {
		client := &http.Client{Timeout: 5 * time.Second}
		for _, rs := range cfg.RelayServers {
			label := rs.Label
			if label == "" {
				label = rs.ID
			}
			start := time.Now()
			resp, err := client.Get(rs.HttpURL + "/health")
			rtt := time.Since(start)
			if err != nil {
				check("Relay: "+label, "fail", "Unreachable")
			} else {
				resp.Body.Close()
				if resp.StatusCode == 200 {
					check("Relay: "+label, "ok", fmt.Sprintf("OK (%dms)", rtt.Milliseconds()))
				} else {
					check("Relay: "+label, "fail", fmt.Sprintf("HTTP %d", resp.StatusCode))
				}
			}
		}
	} else {
		check("Relay servers", "warn", "None configured")
	}

	// Tunnels
	if cfg != nil && len(cfg.CloudflareTunnels) > 0 {
		sb.WriteString("\n── Cloudflare Tunnels ──\n")
		for _, t := range cfg.CloudflareTunnels {
			label := t.Label
			if label == "" {
				label = t.ID
			}
			cf := ""
			if t.CFAccessClientId != "" {
				cf = " (CF Access)"
			}
			check("Tunnel: "+label, "ok", t.URL+cf)
		}
	}

	// Network
	sb.WriteString("\n── Network ──\n")
	ip := getLocalIP()
	if ip != "" && ip != "0.0.0.0" {
		check("Local IP", "ok", ip)
	} else {
		check("Local IP", "warn", "Could not determine")
	}

	sb.WriteString(fmt.Sprintf("\nSummary: %d passed, %d warnings, %d failures\n", ok, warn, fail))
	return mcpToolResult(sb.String())
}

// mcpStatus returns auth/agent/relay status information.
func (s *HTTPServer) mcpStatus() interface{} {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Yaver v%s\n\n", version))

	cfg, err := LoadConfig()
	if err != nil {
		return mcpToolError(fmt.Sprintf("load config: %v", err))
	}

	// Agent
	agentPID, running := isAgentRunning()
	if running {
		sb.WriteString(fmt.Sprintf("Agent: running (PID %d)\n", agentPID))
	} else {
		sb.WriteString("Agent: stopped\n")
	}

	// Auth
	if cfg.AuthToken != "" {
		sb.WriteString("Auth: signed in\n")
		if cfg.DeviceID != "" {
			sb.WriteString(fmt.Sprintf("Device: %s\n", cfg.DeviceID[:8]+"..."))
		}
	} else {
		sb.WriteString("Auth: not signed in\n")
	}

	// Runner
	s.taskMgr.mu.RLock()
	runner := s.taskMgr.runner
	s.taskMgr.mu.RUnlock()
	sb.WriteString(fmt.Sprintf("Runner: %s (%s)\n", runner.Name, runner.RunnerID))

	// Work dir
	sb.WriteString(fmt.Sprintf("Work dir: %s\n", s.taskMgr.workDir))

	// Relay
	if len(cfg.RelayServers) > 0 {
		sb.WriteString(fmt.Sprintf("\nRelay servers: %d configured\n", len(cfg.RelayServers)))
		for _, rs := range cfg.RelayServers {
			label := rs.Label
			if label == "" {
				label = rs.ID
			}
			pw := "no password"
			if rs.Password != "" || cfg.RelayPassword != "" {
				pw = "password set"
			}
			sb.WriteString(fmt.Sprintf("  - %s: %s (%s)\n", label, rs.HttpURL, pw))
		}
	} else {
		sb.WriteString("\nRelay servers: none configured\n")
	}

	// Tunnels
	if len(cfg.CloudflareTunnels) > 0 {
		sb.WriteString(fmt.Sprintf("\nCloudflare Tunnels: %d configured\n", len(cfg.CloudflareTunnels)))
		for _, t := range cfg.CloudflareTunnels {
			label := t.Label
			if label == "" {
				label = t.ID
			}
			sb.WriteString(fmt.Sprintf("  - %s: %s\n", label, t.URL))
		}
	}

	// Tasks
	status := s.taskMgr.GetAgentStatus()
	sb.WriteString(fmt.Sprintf("\nTasks: %d running, %d total\n", status.RunningTasks, status.TotalTasks))

	return mcpToolResult(sb.String())
}

// yaverHelpText returns help documentation for the given topic.
func yaverHelpText(topic string) string {
	switch strings.ToLower(topic) {
	case "tmux":
		return `Tmux Session Adoption
═══════════════════

Yaver can discover and adopt existing tmux sessions, making them visible and
controllable from the mobile app. This is useful when you start an AI agent
(Claude Code, Aider, Codex, etc.) in tmux and want to monitor/interact with
it from your phone.

How it works:
1. Start a tmux session: tmux new -s my-agent
2. Run an AI agent inside it (e.g., claude, aider, codex)
3. Yaver detects it: yaver tmux list (or tmux_list_sessions MCP tool)
4. Adopt it: yaver tmux adopt my-agent (or tmux_adopt_session MCP tool)
5. The session now appears as a task in the mobile app
6. You can send input from mobile — it goes to tmux via send-keys
7. Output is polled every 500ms and streamed to mobile

MCP Tools:
- tmux_list_sessions: List all sessions with agent detection
- tmux_adopt_session: Adopt a session as a Yaver task
- tmux_detach_session: Stop monitoring (session keeps running)
- tmux_send_input: Send keyboard input to an adopted session

Agent detection: Yaver inspects the process tree in each pane to identify
running agents (claude, codex, aider, ollama, goose, amp, opencode).`

	case "relay":
		return `Relay Servers
═════════════

Relay servers enable NAT traversal — your mobile can reach your dev machine
even when it's behind a firewall or on a different network.

How it works:
- Desktop agent connects outbound to relay via QUIC tunnel on startup
- Mobile makes short-lived HTTP requests to relay
- Relay is pass-through — no data stored
- Password-protected for security

Setup:
  yaver relay add https://relay.example.com --password secret --label "My Relay"
  yaver relay test   # Test connectivity
  yaver relay list   # View configured relays

MCP Tools: get_relay_config, add_relay_server, remove_relay_server, relay_test,
relay_set_password, relay_clear_password

Self-hosting: cd relay && RELAY_PASSWORD=secret docker compose up -d`

	case "tunnel":
		return `Cloudflare Tunnels
══════════════════

Cloudflare Tunnel creates a secure HTTPS path from Cloudflare's edge to your
machine. No port forwarding, works through any firewall.

Setup:
  1. Install cloudflared: brew install cloudflared
  2. Create a tunnel: cloudflared tunnel create yaver
  3. Route traffic: cloudflared tunnel route dns yaver yaver.example.com
  4. Run tunnel: cloudflared tunnel --url http://localhost:18080 run yaver
  5. Add to Yaver: yaver tunnel add https://yaver.example.com

MCP Tools: tunnel_list, tunnel_add, tunnel_remove, tunnel_test

For CF Access (zero-trust):
  yaver tunnel add https://yaver.example.com --cf-client-id ID --cf-client-secret SECRET`

	case "mobile":
		return `Mobile App
══════════

The Yaver mobile app (iOS/Android) lets you control AI coding agents from your phone.

Features:
- Create tasks: send prompts to Claude Code, Codex, Aider, etc.
- Live streaming: see agent output in real-time
- Follow-up: send additional instructions to running tasks
- Tmux adoption: discover and control pre-existing tmux sessions
- Multi-device: connect to any registered machine
- Connection modes: LAN (direct), relay (NAT traversal), Cloudflare tunnel

Connection priority:
  1. LAN beacon (UDP broadcast, ~5ms) — same WiFi
  2. Convex IP (direct HTTP, ~5ms) — known IP
  3. QUIC relay (proxied, ~50ms) — roaming/NAT
  4. Cloudflare tunnel — zero-trust

Network changes (WiFi ↔ cellular) are handled silently.`

	case "mcp":
		return `MCP (Model Context Protocol)
════════════════════════════

Yaver exposes an MCP server so AI agents can interact with it programmatically.

Start MCP server:
  yaver mcp              # stdio mode (for Claude Code, etc.)
  yaver mcp --http 8080  # HTTP mode (for remote tools)

Available tool categories:
- Tasks: create_task, list_tasks, get_task, stop_task, continue_task
- Runners: list_runners, switch_runner
- System: get_info, get_system_info, get_config, set_work_dir, list_projects
- Files: read_file, write_file, list_directory, search_files
- Relay: get_relay_config, add_relay_server, remove_relay_server, relay_test
- Tunnels: tunnel_list, tunnel_add, tunnel_remove, tunnel_test
- Tmux: tmux_list_sessions, tmux_adopt_session, tmux_detach_session, tmux_send_input
- Email: email_list_inbox, email_get, email_send, email_sync, email_search
- ACL: acl_list_peers, acl_add_peer, acl_remove_peer, acl_call_peer_tool
- Diagnostics: yaver_doctor, yaver_status, yaver_devices, yaver_logs, yaver_ping
- Config: config_set, relay_set_password, relay_clear_password

Use yaver_help with a topic for details on any category.`

	case "runners":
		return `AI Runners
══════════

Yaver supports multiple AI coding agents. You can switch between them per-task
or set a default.

Built-in runners:
- claude: Claude Code (default) — npm i -g @anthropic-ai/claude-code
- codex: OpenAI Codex — npm i -g @openai/codex
- aider: Aider — pip install aider-chat
- ollama: Ollama — brew install ollama
- goose: Goose — pip install goose-ai
- amp: Amp — npm i -g @anthropic/amp
- opencode: OpenCode — go install github.com/mbreithecker/opencode@latest

Custom runners:
  yaver set-runner custom "my-tool --auto {prompt}"

MCP Tools: list_runners, switch_runner

The runner is also selectable per-task from the mobile app.`

	case "tasks":
		return `Task Management
═══════════════

Tasks are the core abstraction — each task is an AI agent session.

Lifecycle: queued → running → completed/failed/stopped

From mobile: tap + to create, tap task to view, input bar for follow-ups
From MCP: create_task, list_tasks, get_task, stop_task, continue_task
From CLI: yaver attach (interactive REPL)

Adopted tmux sessions also appear as tasks with source="tmux-adopted".
They support input via tmux send-keys and output via pane polling.

Tasks are persisted to ~/.yaver/tasks.json and survive agent restarts.
Adopted tasks are automatically re-adopted if the tmux session still exists.`

	case "auth":
		return `Authentication
══════════════

Yaver uses OAuth via the web app for authentication.

  yaver auth          # Opens browser for sign-in (Apple/Google/Microsoft)
  yaver auth --headless  # Device code flow for SSH/headless servers
  yaver signout       # Clear credentials
  yaver status        # Check auth status

The auth flow:
1. CLI opens https://yaver.io/auth?client=desktop
2. User signs in via Apple/Google/Microsoft
3. Web redirects to http://127.0.0.1:19836/callback?token=<token>
4. CLI saves token to ~/.config/yaver/config.json

The token is used for all API calls and is refreshed automatically.`

	default:
		return `Yaver — AI Coding Agent on Your Phone
═════════════════════════════════════

Yaver is an open-source P2P tool that lets you control any AI coding agent
(Claude Code, Codex, Aider, Ollama, etc.) from your mobile device.

Key features:
- Tasks: Create and manage AI agent sessions from mobile
- Tmux adoption: Discover and control existing tmux sessions
- Multi-runner: Switch between Claude, Codex, Aider, and custom agents
- P2P: Task data flows directly between devices (no server storage)
- Multiple transports: LAN direct, QUIC relay, Cloudflare tunnel
- MCP: Full programmatic access for AI-to-AI workflows

Use yaver_help with a topic for details:
  tmux, relay, tunnel, mobile, mcp, runners, tasks, auth

Quick start:
  1. Install: brew install kivanccakmak/yaver/yaver
  2. Sign in: yaver auth
  3. That's it — the mobile app discovers your machine automatically

CLI commands: auth, serve, status, devices, tmux, relay, tunnel, config,
set-runner, mcp, email, acl, doctor, logs, ping, attach, connect`
	}
}

// resolveFilePath resolves a path relative to the work directory.
func (s *HTTPServer) resolveFilePath(path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Join(s.taskMgr.workDir, path)
}

func mcpToolResult(text string) interface{} {
	return map[string]interface{}{
		"content": []map[string]interface{}{
			{"type": "text", "text": text},
		},
	}
}

func mcpToolError(text string) interface{} {
	return map[string]interface{}{
		"content": []map[string]interface{}{
			{"type": "text", "text": text},
		},
		"isError": true,
	}
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// ---------------------------------------------------------------------------
// tmux session management endpoints
// ---------------------------------------------------------------------------

// GET /tmux/sessions — list all tmux sessions with relationship info
func (s *HTTPServer) handleTmuxSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	tmuxMgr := s.taskMgr.TmuxMgr
	if tmuxMgr == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"sessions": []TmuxSession{}})
		return
	}
	sessions, err := tmuxMgr.ListTmuxSessions()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if sessions == nil {
		sessions = []TmuxSession{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"sessions": sessions})
}

// POST /tmux/adopt — adopt an existing tmux session as a yaver task
func (s *HTTPServer) handleTmuxAdopt(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	tmuxMgr := s.taskMgr.TmuxMgr
	if tmuxMgr == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "tmux not available"})
		return
	}
	var body struct {
		Session string `json:"session"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Session == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing session name"})
		return
	}
	task, err := tmuxMgr.AdoptSession(body.Session)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"taskId":  task.ID,
		"session": body.Session,
	})
}

// POST /tmux/detach — detach an adopted tmux session (stop monitoring, keep session alive)
func (s *HTTPServer) handleTmuxDetach(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	tmuxMgr := s.taskMgr.TmuxMgr
	if tmuxMgr == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "tmux not available"})
		return
	}
	var body struct {
		TaskID string `json:"taskId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.TaskID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing taskId"})
		return
	}
	if err := tmuxMgr.DetachSession(body.TaskID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "detached"})
}

// POST /tmux/input — send keyboard input to an adopted tmux session
func (s *HTTPServer) handleTmuxInput(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	tmuxMgr := s.taskMgr.TmuxMgr
	if tmuxMgr == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "tmux not available"})
		return
	}
	var body struct {
		TaskID string `json:"taskId"`
		Input  string `json:"input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.TaskID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing taskId or input"})
		return
	}
	if err := tmuxMgr.SendTmuxInput(body.TaskID, body.Input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}
