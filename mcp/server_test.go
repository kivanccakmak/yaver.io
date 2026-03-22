package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// newTestServer creates a test MCP server with a temp work directory.
func newTestServer(t *testing.T, password string) (*MCPServer, string) {
	t.Helper()
	workDir := t.TempDir()
	pluginsDir := filepath.Join(workDir, "plugins")
	os.MkdirAll(pluginsDir, 0755)
	s := NewMCPServer(0, password, pluginsDir, workDir)
	return s, workDir
}

func doMCPRequest(t *testing.T, s *MCPServer, method string, params interface{}, password string) *JSONRPCResponse {
	t.Helper()
	paramsJSON, _ := json.Marshal(params)
	req := JSONRPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  method,
		Params:  paramsJSON,
	}
	body, _ := json.Marshal(req)

	httpReq := httptest.NewRequest("POST", "/mcp", bytes.NewReader(body))
	httpReq.Header.Set("Content-Type", "application/json")
	if password != "" {
		httpReq.Header.Set("Authorization", "Bearer "+password)
	}

	rr := httptest.NewRecorder()
	handler := s.authMiddleware(s.handleMCP)
	handler(rr, httpReq)

	if rr.Code != http.StatusOK && rr.Code != http.StatusNoContent {
		t.Fatalf("MCP request %s returned status %d: %s", method, rr.Code, rr.Body.String())
	}

	if rr.Code == http.StatusNoContent {
		return nil
	}

	var resp JSONRPCResponse
	json.NewDecoder(rr.Body).Decode(&resp)
	return &resp
}

func TestHealth(t *testing.T) {
	s, _ := newTestServer(t, "")

	rr := httptest.NewRecorder()
	s.handleHealth(rr, httptest.NewRequest("GET", "/health", nil))

	if rr.Code != http.StatusOK {
		t.Fatalf("health returned %d", rr.Code)
	}

	var data map[string]interface{}
	json.NewDecoder(rr.Body).Decode(&data)

	if data["status"] != "ok" {
		t.Errorf("expected status ok, got %v", data["status"])
	}
	if data["version"] != version {
		t.Errorf("expected version %s, got %v", version, data["version"])
	}
}

func TestAuthRequired(t *testing.T) {
	s, _ := newTestServer(t, "secret123")

	// No auth header → 401
	req := httptest.NewRequest("POST", "/mcp", bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`)))
	rr := httptest.NewRecorder()
	handler := s.authMiddleware(s.handleMCP)
	handler(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 without auth, got %d", rr.Code)
	}

	// Wrong password → 401
	req = httptest.NewRequest("POST", "/mcp", bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`)))
	req.Header.Set("Authorization", "Bearer wrong")
	rr = httptest.NewRecorder()
	handler(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 with wrong password, got %d", rr.Code)
	}

	// Correct password → 200
	req = httptest.NewRequest("POST", "/mcp", bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)))
	req.Header.Set("Authorization", "Bearer secret123")
	rr = httptest.NewRecorder()
	handler(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 with correct password, got %d", rr.Code)
	}
}

func TestNoAuthWhenPasswordEmpty(t *testing.T) {
	s, _ := newTestServer(t, "")

	req := httptest.NewRequest("POST", "/mcp", bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)))
	rr := httptest.NewRecorder()
	handler := s.authMiddleware(s.handleMCP)
	handler(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 with no password configured, got %d", rr.Code)
	}
}

func TestInitialize(t *testing.T) {
	s, _ := newTestServer(t, "")

	resp := doMCPRequest(t, s, "initialize", map[string]interface{}{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]interface{}{},
		"clientInfo":      map[string]interface{}{"name": "test", "version": "1.0.0"},
	}, "")

	result, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatal("initialize result is not a map")
	}

	serverInfo, ok := result["serverInfo"].(map[string]interface{})
	if !ok {
		t.Fatal("missing serverInfo")
	}
	if serverInfo["name"] != "yaver-mcp" {
		t.Errorf("expected server name yaver-mcp, got %v", serverInfo["name"])
	}
	if result["protocolVersion"] != "2024-11-05" {
		t.Errorf("expected protocol 2024-11-05, got %v", result["protocolVersion"])
	}
}

func TestToolsList(t *testing.T) {
	s, _ := newTestServer(t, "")

	resp := doMCPRequest(t, s, "tools/list", nil, "")

	result, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatal("tools/list result is not a map")
	}

	tools, ok := result["tools"].([]interface{})
	if !ok {
		t.Fatal("tools is not an array")
	}

	if len(tools) < 10 {
		t.Errorf("expected at least 10 built-in tools, got %d", len(tools))
	}

	// Check a specific tool exists
	found := false
	for _, tool := range tools {
		if m, ok := tool.(map[string]interface{}); ok {
			if m["name"] == "read_file" {
				found = true
				break
			}
		}
	}
	if !found {
		t.Error("read_file tool not found in tools list")
	}
}

func TestToolCallReadFile(t *testing.T) {
	s, workDir := newTestServer(t, "")

	// Create a test file
	testContent := "hello from test file"
	testFile := filepath.Join(workDir, "test.txt")
	os.WriteFile(testFile, []byte(testContent), 0644)

	resp := doMCPRequest(t, s, "tools/call", map[string]interface{}{
		"name":      "read_file",
		"arguments": map[string]string{"path": "test.txt"},
	}, "")

	result, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatal("result is not a map")
	}

	content, ok := result["content"].([]interface{})
	if !ok || len(content) == 0 {
		t.Fatal("missing content array")
	}

	first, ok := content[0].(map[string]interface{})
	if !ok {
		t.Fatal("content[0] is not a map")
	}

	if first["text"] != testContent {
		t.Errorf("expected %q, got %q", testContent, first["text"])
	}
}

func TestToolCallWriteFile(t *testing.T) {
	s, workDir := newTestServer(t, "")

	resp := doMCPRequest(t, s, "tools/call", map[string]interface{}{
		"name":      "write_file",
		"arguments": map[string]string{"path": "output.txt", "content": "written by test"},
	}, "")

	result, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatal("result is not a map")
	}

	// Verify file exists
	data, err := os.ReadFile(filepath.Join(workDir, "output.txt"))
	if err != nil {
		t.Fatalf("file not created: %v", err)
	}
	if string(data) != "written by test" {
		t.Errorf("file content mismatch: %s", data)
	}

	_ = result // success
}

func TestToolCallListDirectory(t *testing.T) {
	s, workDir := newTestServer(t, "")

	// Create some files
	os.WriteFile(filepath.Join(workDir, "a.txt"), []byte("a"), 0644)
	os.WriteFile(filepath.Join(workDir, "b.go"), []byte("b"), 0644)
	os.MkdirAll(filepath.Join(workDir, "subdir"), 0755)

	resp := doMCPRequest(t, s, "tools/call", map[string]interface{}{
		"name":      "list_directory",
		"arguments": map[string]string{},
	}, "")

	result, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatal("result is not a map")
	}

	content, _ := result["content"].([]interface{})
	if len(content) == 0 {
		t.Fatal("empty content")
	}
	text, _ := content[0].(map[string]interface{})["text"].(string)
	if text == "" {
		t.Error("empty directory listing")
	}
}

func TestToolCallExecCommand(t *testing.T) {
	s, _ := newTestServer(t, "")

	resp := doMCPRequest(t, s, "tools/call", map[string]interface{}{
		"name":      "exec_command",
		"arguments": map[string]string{"command": "echo hello-mcp-test"},
	}, "")

	result, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatal("result is not a map")
	}

	content, _ := result["content"].([]interface{})
	first, _ := content[0].(map[string]interface{})
	text, _ := first["text"].(string)
	if text == "" || !bytes.Contains([]byte(text), []byte("hello-mcp-test")) {
		t.Errorf("exec_command did not return expected output, got: %s", text)
	}
}

func TestToolCallSystemInfo(t *testing.T) {
	s, _ := newTestServer(t, "")

	resp := doMCPRequest(t, s, "tools/call", map[string]interface{}{
		"name":      "system_info",
		"arguments": map[string]interface{}{},
	}, "")

	result, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatal("result is not a map")
	}

	content, _ := result["content"].([]interface{})
	first, _ := content[0].(map[string]interface{})
	text, _ := first["text"].(string)
	if text == "" {
		t.Error("system_info returned empty")
	}
}

func TestToolCallGitStatus(t *testing.T) {
	s, workDir := newTestServer(t, "")

	// Init a git repo in the work dir
	cmd := fmt.Sprintf("cd %s && git init && git config user.email 'test@test.com' && git config user.name 'Test'", workDir)
	os.Setenv("GIT_AUTHOR_DATE", time.Now().Format(time.RFC3339))
	exec := doMCPRequest(t, s, "tools/call", map[string]interface{}{
		"name":      "exec_command",
		"arguments": map[string]string{"command": cmd},
	}, "")
	_ = exec

	resp := doMCPRequest(t, s, "tools/call", map[string]interface{}{
		"name":      "git_status",
		"arguments": map[string]interface{}{},
	}, "")

	result, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatal("result is not a map")
	}

	content, _ := result["content"].([]interface{})
	if len(content) == 0 {
		t.Error("git_status returned no content")
	}
}

func TestUnknownTool(t *testing.T) {
	s, _ := newTestServer(t, "")

	resp := doMCPRequest(t, s, "tools/call", map[string]interface{}{
		"name":      "nonexistent_tool",
		"arguments": map[string]interface{}{},
	}, "")

	result, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatal("result is not a map")
	}

	isError, _ := result["isError"].(bool)
	if !isError {
		t.Error("expected isError=true for unknown tool")
	}
}

func TestUnknownMethod(t *testing.T) {
	s, _ := newTestServer(t, "")

	resp := doMCPRequest(t, s, "unknown/method", nil, "")

	if resp.Error == nil {
		t.Error("expected error for unknown method")
	}
}

func TestNotificationNoResponse(t *testing.T) {
	s, _ := newTestServer(t, "")

	resp := doMCPRequest(t, s, "notifications/initialized", nil, "")
	// notifications/initialized returns nil (no response)
	// but our test helper treats 204 as nil
	_ = resp // nil is ok
}

func TestCORS(t *testing.T) {
	s, _ := newTestServer(t, "")

	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	handler := s.corsMiddleware(mux)

	req := httptest.NewRequest("OPTIONS", "/health", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Errorf("OPTIONS expected 204, got %d", rr.Code)
	}
	if rr.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Error("missing CORS header")
	}
}

func TestStatusEndpoint(t *testing.T) {
	s, _ := newTestServer(t, "pw")

	req := httptest.NewRequest("GET", "/status", nil)
	req.Header.Set("Authorization", "Bearer pw")
	rr := httptest.NewRecorder()
	handler := s.authMiddleware(s.handleStatus)
	handler(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status returned %d", rr.Code)
	}

	var data map[string]interface{}
	json.NewDecoder(rr.Body).Decode(&data)

	if data["ok"] != true {
		t.Error("expected ok=true")
	}
	bt, _ := data["builtinTools"].(float64)
	if bt < 10 {
		t.Errorf("expected at least 10 builtin tools, got %v", bt)
	}
}

func TestPluginList(t *testing.T) {
	s, _ := newTestServer(t, "")

	req := httptest.NewRequest("GET", "/plugins", nil)
	rr := httptest.NewRecorder()
	s.handlePlugins(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("plugins list returned %d", rr.Code)
	}

	var data struct {
		OK      bool          `json:"ok"`
		Plugins []interface{} `json:"plugins"`
	}
	json.NewDecoder(rr.Body).Decode(&data)

	if !data.OK {
		t.Error("expected ok=true")
	}
	// No plugins deployed yet
}

func TestFullHTTPServer(t *testing.T) {
	workDir := t.TempDir()
	pluginsDir := filepath.Join(workDir, "plugins")
	os.MkdirAll(pluginsDir, 0755)

	s := NewMCPServer(0, "testpw", pluginsDir, workDir)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/mcp", s.authMiddleware(s.handleMCP))
	ts := httptest.NewServer(s.corsMiddleware(mux))
	defer ts.Close()

	// Health (no auth)
	resp, err := http.Get(ts.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("health: expected 200, got %d", resp.StatusCode)
	}

	// MCP without auth → 401
	mcpBody, _ := json.Marshal(map[string]interface{}{"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
	resp2, err := http.Post(ts.URL+"/mcp", "application/json", bytes.NewReader(mcpBody))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 401 {
		t.Errorf("MCP without auth: expected 401, got %d", resp2.StatusCode)
	}

	// MCP with auth → 200
	req, _ := http.NewRequest("POST", ts.URL+"/mcp", bytes.NewReader(mcpBody))
	req.Header.Set("Authorization", "Bearer testpw")
	req.Header.Set("Content-Type", "application/json")
	resp3, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp3.Body.Close()
	if resp3.StatusCode != 200 {
		body, _ := io.ReadAll(resp3.Body)
		t.Errorf("MCP with auth: expected 200, got %d: %s", resp3.StatusCode, body)
	}

	var mcpResp JSONRPCResponse
	json.NewDecoder(resp3.Body).Decode(&mcpResp)
	result, _ := mcpResp.Result.(map[string]interface{})
	tools, _ := result["tools"].([]interface{})
	if len(tools) < 10 {
		t.Errorf("expected 10+ tools, got %d", len(tools))
	}
}
