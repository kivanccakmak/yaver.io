package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

// MCPServer is the standalone Yaver MCP server.
type MCPServer struct {
	httpPort   int
	password   string
	pluginsDir string
	workDir    string
	startedAt  time.Time

	pluginMgr    *PluginManager
	builtinTools []ToolDef
	mu           sync.RWMutex
}

// ToolDef is an MCP tool definition.
type ToolDef struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"inputSchema"`
}

// JSONRPCRequest is a JSON-RPC 2.0 request.
type JSONRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// JSONRPCResponse is a JSON-RPC 2.0 response.
type JSONRPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id,omitempty"`
	Result  interface{} `json:"result,omitempty"`
	Error   interface{} `json:"error,omitempty"`
}

// NewMCPServer creates a new MCP server.
func NewMCPServer(httpPort int, password, pluginsDir, workDir string) *MCPServer {
	s := &MCPServer{
		httpPort:   httpPort,
		password:   password,
		pluginsDir: pluginsDir,
		workDir:    workDir,
		startedAt:  time.Now(),
	}
	s.builtinTools = builtinToolDefs()
	s.pluginMgr = NewPluginManager(pluginsDir)
	return s
}

// RunHTTP starts the HTTP server.
func (s *MCPServer) RunHTTP(ctx context.Context) error {
	// Load plugins
	s.pluginMgr.LoadAll()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/status", s.authMiddleware(s.handleStatus))
	mux.HandleFunc("/mcp", s.authMiddleware(s.handleMCP))
	mux.HandleFunc("/plugins", s.authMiddleware(s.handlePlugins))
	mux.HandleFunc("/plugins/deploy", s.authMiddleware(s.handlePluginDeploy))

	srv := &http.Server{
		Addr:    fmt.Sprintf("0.0.0.0:%d", s.httpPort),
		Handler: s.corsMiddleware(mux),
	}

	log.Printf("MCP server listening on 0.0.0.0:%d", s.httpPort)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()

	select {
	case <-ctx.Done():
		log.Println("Shutting down MCP server...")
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutCtx)
		s.pluginMgr.StopAll()
		return nil
	case err := <-errCh:
		s.pluginMgr.StopAll()
		return err
	}
}

// RunStdio runs the MCP server over stdin/stdout (for Claude Desktop integration).
func (s *MCPServer) RunStdio(ctx context.Context) error {
	s.pluginMgr.LoadAll()

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req JSONRPCRequest
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}

		resp := s.handleJSONRPC(req)
		if resp == nil {
			continue // notification, no response
		}

		out, _ := json.Marshal(resp)
		fmt.Fprintln(os.Stdout, string(out))
	}

	s.pluginMgr.StopAll()
	return nil
}

// handleHealth returns server health (no auth required).
func (s *MCPServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	uptime := time.Since(s.startedAt).Round(time.Second).String()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"version": version,
		"uptime":  uptime,
		"plugins": s.pluginMgr.Count(),
	})
}

// handleStatus returns detailed status.
func (s *MCPServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	plugins := s.pluginMgr.List()
	tools := s.allToolNames()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":           true,
		"version":      version,
		"uptime":       time.Since(s.startedAt).Round(time.Second).String(),
		"builtinTools": len(s.builtinTools),
		"plugins":      plugins,
		"totalTools":   len(tools),
	})
}

// handleMCP handles JSON-RPC 2.0 MCP requests.
func (s *MCPServer) handleMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}

	var req JSONRPCRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid JSON-RPC", http.StatusBadRequest)
		return
	}

	resp := s.handleJSONRPC(req)
	if resp == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// handleJSONRPC processes a JSON-RPC request and returns a response.
func (s *MCPServer) handleJSONRPC(req JSONRPCRequest) *JSONRPCResponse {
	switch req.Method {
	case "initialize":
		return &JSONRPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"protocolVersion": "2024-11-05",
				"capabilities": map[string]interface{}{
					"tools": map[string]interface{}{},
				},
				"serverInfo": map[string]interface{}{
					"name":    "yaver-mcp",
					"version": version,
				},
			},
		}

	case "notifications/initialized":
		return nil // no response for notifications

	case "tools/list":
		tools := s.allTools()
		return &JSONRPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  map[string]interface{}{"tools": tools},
		}

	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		json.Unmarshal(req.Params, &params)

		result := s.callTool(params.Name, params.Arguments)
		return &JSONRPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  result,
		}

	default:
		return &JSONRPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error: map[string]interface{}{
				"code":    -32601,
				"message": "method not found: " + req.Method,
			},
		}
	}
}

// callTool dispatches a tool call to built-in handlers or plugins.
func (s *MCPServer) callTool(name string, args json.RawMessage) interface{} {
	// Try built-in tools first
	if result, ok := handleBuiltinTool(name, args, s.workDir); ok {
		return result
	}

	// Try plugin tools
	if result, ok := s.pluginMgr.CallTool(name, args); ok {
		return result
	}

	return map[string]interface{}{
		"content": []map[string]interface{}{
			{"type": "text", "text": "unknown tool: " + name},
		},
		"isError": true,
	}
}

// allTools returns all tool definitions (built-in + plugins).
func (s *MCPServer) allTools() []map[string]interface{} {
	var tools []map[string]interface{}
	for _, t := range s.builtinTools {
		tools = append(tools, map[string]interface{}{
			"name":        t.Name,
			"description": t.Description,
			"inputSchema": t.InputSchema,
		})
	}
	for _, t := range s.pluginMgr.AllTools() {
		tools = append(tools, t)
	}
	return tools
}

// allToolNames returns all tool names.
func (s *MCPServer) allToolNames() []string {
	var names []string
	for _, t := range s.builtinTools {
		names = append(names, t.Name)
	}
	for _, t := range s.pluginMgr.AllTools() {
		if n, ok := t["name"].(string); ok {
			names = append(names, n)
		}
	}
	return names
}

// handlePlugins lists deployed plugins.
func (s *MCPServer) handlePlugins(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodDelete {
		name := r.URL.Query().Get("name")
		if name == "" {
			jsonErr(w, http.StatusBadRequest, "name required")
			return
		}
		if err := s.pluginMgr.Remove(name); err != nil {
			jsonErr(w, http.StatusNotFound, err.Error())
			return
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
		return
	}

	plugins := s.pluginMgr.List()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":      true,
		"plugins": plugins,
	})
}

// handlePluginDeploy deploys a plugin from a POST request.
func (s *MCPServer) handlePluginDeploy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}

	// Read tar.gz body
	body, err := io.ReadAll(io.LimitReader(r.Body, 100*1024*1024)) // 100MB limit
	if err != nil {
		jsonErr(w, http.StatusBadRequest, "read error")
		return
	}

	name, tools, err := s.pluginMgr.Deploy(body)
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":    true,
		"name":  name,
		"tools": tools,
	})
}

// authMiddleware checks password auth.
func (s *MCPServer) authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.password != "" {
			auth := r.Header.Get("Authorization")
			if auth != "Bearer "+s.password {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}
		next(w, r)
	}
}

// corsMiddleware adds CORS headers.
func (s *MCPServer) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func jsonErr(w http.ResponseWriter, code int, msg string) {
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": msg})
}
