package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
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
	server      *http.Server

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
		Title       string `json:"title"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if body.Title == "" {
		jsonError(w, http.StatusBadRequest, "title is required")
		return
	}

	task, err := s.taskMgr.CreateTask(body.Title, body.Description)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, fmt.Sprintf("failed to create task: %v", err))
		return
	}

	log.Printf("[HTTP] Task created: %s — %s (status: %s)", task.ID, task.Title, task.Status)
	resp := map[string]interface{}{
		"ok":     true,
		"taskId": task.ID,
		"status": task.Status,
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
		resp.Result = map[string]interface{}{
			"tools": []map[string]interface{}{
				{
					"name":        "create_task",
					"description": "Create a new coding task. Claude will execute this task on the connected development machine, with full access to the codebase, terminal, and tools.",
					"inputSchema": map[string]interface{}{
						"type":     "object",
						"required": []string{"prompt"},
						"properties": map[string]interface{}{
							"prompt": map[string]interface{}{
								"type":        "string",
								"description": "The task prompt describing what Claude should do",
							},
						},
					},
				},
				{
					"name":        "list_tasks",
					"description": "List all tasks and their current status (queued, running, completed, failed, stopped).",
					"inputSchema": map[string]interface{}{
						"type":       "object",
						"properties": map[string]interface{}{},
					},
				},
				{
					"name":        "get_task",
					"description": "Get detailed information about a specific task, including its full output.",
					"inputSchema": map[string]interface{}{
						"type":     "object",
						"required": []string{"task_id"},
						"properties": map[string]interface{}{
							"task_id": map[string]interface{}{
								"type":        "string",
								"description": "The task ID",
							},
						},
					},
				},
				{
					"name":        "stop_task",
					"description": "Stop a running task.",
					"inputSchema": map[string]interface{}{
						"type":     "object",
						"required": []string{"task_id"},
						"properties": map[string]interface{}{
							"task_id": map[string]interface{}{
								"type":        "string",
								"description": "The task ID to stop",
							},
						},
					},
				},
				{
					"name":        "continue_task",
					"description": "Continue a stopped task with additional input/instructions.",
					"inputSchema": map[string]interface{}{
						"type":     "object",
						"required": []string{"task_id", "input"},
						"properties": map[string]interface{}{
							"task_id": map[string]interface{}{
								"type":        "string",
								"description": "The task ID to continue",
							},
							"input": map[string]interface{}{
								"type":        "string",
								"description": "Follow-up instructions for the task",
							},
						},
					},
				},
				{
					"name":        "get_info",
					"description": "Get information about the connected development machine (hostname, working directory, version).",
					"inputSchema": map[string]interface{}{
						"type":       "object",
						"properties": map[string]interface{}{},
					},
				},
			},
		}

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
		task, err := s.taskMgr.CreateTask(args.Prompt, "")
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

	default:
		return mcpToolError("unknown tool: " + call.Name)
	}
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
