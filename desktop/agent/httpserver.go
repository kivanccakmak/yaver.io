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
		Title         string `json:"title"`
		Description   string `json:"description"`
		Model         string `json:"model"`
		Runner        string `json:"runner"`        // runner ID: "claude", "codex", "aider" — empty uses default
		CustomCommand string `json:"customCommand"` // arbitrary command — runs via sh -c
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if body.Title == "" {
		jsonError(w, http.StatusBadRequest, "title is required")
		return
	}

	task, err := s.taskMgr.CreateTask(body.Title, body.Description, body.Model, "mobile", body.Runner, body.CustomCommand)
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
		Input string `json:"input"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if body.Input == "" {
		jsonError(w, http.StatusBadRequest, "input is required")
		return
	}

	task, err := s.taskMgr.ResumeTask(id, body.Input)
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
			Prompt string `json:"prompt"`
		}
		json.Unmarshal(call.Arguments, &args)
		if args.Prompt == "" {
			return mcpToolError("prompt is required")
		}
		task, err := s.taskMgr.CreateTask(args.Prompt, "", "", "mcp", "", "")
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
		task, err := s.taskMgr.ResumeTask(args.TaskID, args.Input)
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

	default:
		return mcpToolError("unknown tool: " + call.Name)
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
