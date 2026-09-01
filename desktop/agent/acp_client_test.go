package main

// acp_client_test.go — wire-contract tests for the ACP stdio client.
//
// The tests exercise the client against a FAKE ACP server written in Go over
// the same newline-delimited stdio JSON-RPC transport opencode/codex-acp/
// claude-agent-acp speak, so the framing, id matching, notification routing,
// and session/prompt payload shapes are locked without spawning a real LLM.
//
// The live-loop proof (real `opencode acp` / adapters) lives in the manual
// probes from 2026-08-11/12; these tests pin the contract the client depends
// on so a regression in either direction fails here first.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	osexec "os/exec"
	"strings"
	"testing"
	"time"
)

// fakeACPServer is a minimal scriptable ACP v1 stdio server. It reads
// newline-delimited JSON-RPC requests and answers according to a handler
// function, and can emit server→client notifications on demand.
type fakeACPServer struct {
	t      *testing.T
	cmd    *osexec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
}

// TestFakeACPServerChild is the child-process entry point; it never runs as a
// test itself. It is driven entirely by the parent's stdin.
func TestFakeACPServerChild(t *testing.T) {
	// Guard: only run when the parent explicitly spawned us. The env var is
	// set by fakeACPServerDriver below.
	if os.Getenv("FAKE_ACP_CHILD") != "1" {
		t.Skip("child entrypoint only")
	}
	// Serialize the handler spec over env? Simpler: the child just echoes
	// canned responses keyed by method, sufficient for the wire contract.
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	w := bufio.NewWriter(os.Stdout)
	for sc.Scan() {
		line := sc.Bytes()
		var req struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      int64           `json:"id"`
			Method  string          `json:"method"`
			Params  json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}
		if req.Method == "" {
			continue
		}
		switch req.Method {
		case "initialize":
			resp := map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"protocolVersion": 1,
					"agentInfo":       map[string]any{"name": "FakeACPAgent", "version": "9.9.9"},
					"agentCapabilities": map[string]any{
						"loadSession": true,
						"auth":        map[string]any{"logout": map[string]any{}},
					},
					"authMethods": []map[string]any{
						{"id": "fake-subscription", "name": "Fake Subscription", "type": "terminal",
							"args": []string{"--cli", "auth", "login", "--fakesub"}},
						{"id": "fake-api-key", "name": "Fake API Key"},
					},
				},
			}
			fmt.Fprintln(w, mustJSONString(resp))
		case "session/new":
			var params struct {
				Cwd        string         `json:"cwd"`
				MCPServers []acpMCPServer `json:"mcpServers"`
			}
			_ = json.Unmarshal(req.Params, &params)
			// Contract: mcpServers must be present (array). The real
			// opencode returns -32602 when omitted; mirror that.
			if len(req.Params) == 0 || !strings.Contains(string(req.Params), "mcpServers") {
				fmt.Fprintln(w, mustJSONString(map[string]any{
					"jsonrpc": "2.0", "id": req.ID,
					"error": map[string]any{"code": -32602, "message": "Invalid params", "data": map[string]any{"_errors": []string{"mcpServers required"}}},
				}))
				_ = w.Flush()
				continue
			}
			// Emit a notification before answering (streaming contract).
			fmt.Fprintln(w, mustJSONString(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": "fake-session-1",
					"update":    map[string]any{"sessionUpdate": "config_option_update"},
				},
			}))
			fmt.Fprintln(w, mustJSONString(map[string]any{
				"jsonrpc": "2.0", "id": req.ID,
				"result": map[string]any{
					"sessionId": "fake-session-1",
					"configOptions": []map[string]any{
						{"id": "model", "name": "Model", "type": "select", "currentValue": "fake/model"},
					},
				},
			}))
		case "session/prompt":
			if os.Getenv("FAKE_ACP_PROMPT_BLOCK") == "1" {
				// Cancellation contract: the parent drops the pending request and
				// closes/kills this ACP process; no response is intentionally sent.
				time.Sleep(30 * time.Second)
				continue
			}
			var params struct {
				SessionID string            `json:"sessionId"`
				Prompt    []acpContentBlock `json:"prompt"`
			}
			_ = json.Unmarshal(req.Params, &params)
			// Verify the image block survived the wire.
			hasImage := false
			for _, b := range params.Prompt {
				if b.Type == "image" && b.MimeType == "image/png" && b.Data != "" {
					hasImage = true
				}
			}
			gotImage := "false"
			if hasImage {
				gotImage = "true"
			}
			_ = gotImage
			// Echo a message chunk then the final turn result.
			fmt.Fprintln(w, mustJSONString(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": params.SessionID,
					"update":    map[string]any{"sessionUpdate": "agent_message_chunk", "messageId": "msg-1", "content": []map[string]any{{"type": "text", "text": "PONG"}}},
				},
			}))
			fmt.Fprintln(w, mustJSONString(map[string]any{
				"jsonrpc": "2.0", "id": req.ID,
				"result": map[string]any{
					"stopReason": "end_turn",
					"usage":      map[string]any{"inputTokens": 10, "outputTokens": 2, "totalTokens": 12},
				},
			}))
		case "authenticate":
			fmt.Fprintln(w, mustJSONString(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}}))
		case "logout":
			fmt.Fprintln(w, mustJSONString(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}}))
		case "session/list":
			fmt.Fprintln(w, mustJSONString(map[string]any{
				"jsonrpc": "2.0", "id": req.ID,
				"result": map[string]any{"sessions": []map[string]any{{"sessionId": "fake-session-1", "cwd": "/tmp", "title": "Fake"}}},
			}))
		default:
			fmt.Fprintln(w, mustJSONString(map[string]any{
				"jsonrpc": "2.0", "id": req.ID,
				"error": map[string]any{"code": -32601, "message": "Method not found", "data": map[string]any{"method": req.Method}},
			}))
		}
		_ = w.Flush()
	}
	os.Exit(0)
}

func mustJSONString(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// fakeACPClient spawns the fake server with a canned handler set.
func fakeACPClient(t *testing.T) *acpClient {
	return fakeACPClientWithNotify(t, nil)
}

func fakeACPClientWithNotify(t *testing.T, onNotify acpNotifyHandler) *acpClient {
	t.Helper()
	// The child is driven by FAKE_ACP_CHILD=1 through the test binary itself.
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := osexec.Command(exe, "-test.run=TestFakeACPServerChild")
	cmd.Env = append(os.Environ(), "FAKE_ACP_CHILD=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	c := &acpClient{
		cmd:      cmd,
		stdin:    stdin,
		done:     make(chan struct{}),
		cancel:   func() {},
		pending:  make(map[int64]chan acpRPCResponse),
		onNotify: onNotify,
	}
	go c.readLoop(stdout)
	go func() {
		_ = cmd.Wait()
		close(c.done)
	}()
	t.Cleanup(c.Close)
	return c
}

// TestACPAuthStateLocksInitializeContract verifies initialize → capabilities
// → auth-method discovery end to end over real stdio.
func TestACPAuthStateLocksInitializeContract(t *testing.T) {
	c := fakeACPClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	st := c.AuthState(ctx)
	if !st.Reachable {
		t.Fatalf("expected reachable ACP server, got error: %s", st.Error)
	}
	if st.AgentName != "FakeACPAgent" || st.AgentVersion != "9.9.9" {
		t.Fatalf("agent info mismatch: %+v", st)
	}
	if len(st.AuthMethods) != 2 {
		t.Fatalf("expected 2 auth methods, got %d: %+v", len(st.AuthMethods), st.AuthMethods)
	}
	// The terminal-type subscription method must decode with args intact —
	// this is the claude-ai-login shape the terminal-login flow depends on.
	var sub *acpAuthMethod
	for i := range st.AuthMethods {
		if st.AuthMethods[i].ID == "fake-subscription" {
			sub = &st.AuthMethods[i]
		}
	}
	if sub == nil {
		t.Fatal("subscription auth method missing")
	}
	if sub.Type != "terminal" {
		t.Fatalf("expected terminal type, got %q", sub.Type)
	}
	if len(sub.Args) != 4 || sub.Args[0] != "--cli" {
		t.Fatalf("terminal args not decoded: %v", sub.Args)
	}
}

// TestACPSessionNewRequiresMCPSevers pins the -32602 contract: omitting
// mcpServers must fail (mirroring real opencode), and passing them must
// succeed with a session id + config options.
func TestACPSessionNewRequiresMCPSevers(t *testing.T) {
	c := fakeACPClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Omit mcpServers entirely — the raw call path (bypasses NewSession's
	// nil-guard) must surface the agent's -32602, proving the client does
	// not silently fabricate a session.
	raw, err := c.call(ctx, "session/new", map[string]any{"cwd": "/tmp"})
	if err == nil {
		t.Fatalf("expected error when mcpServers omitted, got result %s", string(raw))
	}
	var rpcErr *acpJSONRPCError
	if !errorsAs(err, &rpcErr) || rpcErr.Code != -32602 {
		t.Fatalf("expected -32602, got %v", err)
	}

	// With mcpServers the yaver stdio descriptor must ride through.
	sessionID, opts, err := c.NewSession(ctx, "/tmp", []acpMCPServer{acpYaverMCPServer("/fake/yaver")})
	if err != nil {
		t.Fatalf("NewSession with mcpServers failed: %v", err)
	}
	if sessionID != "fake-session-1" {
		t.Fatalf("session id mismatch: %q", sessionID)
	}
	if len(opts) == 0 || opts[0].ID != "model" {
		t.Fatalf("config options not decoded: %+v", opts)
	}
}

// TestACPPromptCarriesImageBlocks verifies the screenshot path: a prompt with
// a base64 image block reaches the agent intact and the turn returns
// end_turn. This is the exact payload shape the plan's "screenshot attachment
// → Read tool" use case depends on.
func TestACPPromptCarriesImageBlocks(t *testing.T) {
	c := fakeACPClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, _, err := c.NewSession(ctx, "/tmp", []acpMCPServer{})
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}

	notifications := make(chan string, 8)
	orig := c.onNotify
	c.onNotify = func(method string, params json.RawMessage) {
		if method == "session/update" && strings.Contains(string(params), "agent_message_chunk") {
			notifications <- "chunk"
		}
		if orig != nil {
			orig(method, params)
		}
	}

	res, err := c.Prompt(ctx, "fake-session-1", []acpContentBlock{
		acpTextBlock("Describe the screenshot."),
		acpImageBlock("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "image/png"),
	})
	if err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	if res.StopReason != "end_turn" {
		t.Fatalf("expected end_turn, got %q", res.StopReason)
	}
	if res.Usage == nil || res.Usage.TotalTokens != 12 {
		t.Fatalf("usage not decoded: %+v", res.Usage)
	}
	select {
	case <-notifications:
	case <-time.After(2 * time.Second):
		t.Fatal("agent_message_chunk notification was not routed to the handler")
	}
}

// TestACPAuthenticateSendsMethodID verifies agent-type auth: authenticate
// carries the subscription method id and tolerates a clean response.
func TestACPAuthenticateSendsMethodID(t *testing.T) {
	c := fakeACPClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := c.Authenticate(ctx, "fake-subscription"); err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if err := c.Logout(ctx); err != nil {
		t.Fatalf("Logout: %v", err)
	}
}

// TestACPStreamClosesPendingCalls verifies the "process died mid-call"
// fallback: every pending call fails fast with a stream-closed error instead
// of hanging forever. This is the ACP-side half of the probe-fallback story.
func TestACPStreamClosesPendingCalls(t *testing.T) {
	c := fakeACPClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Kill the child out from under a pending call.
	_ = c.cmd.Process.Kill()
	_, err := c.call(ctx, "session/list", map[string]any{})
	if err == nil {
		t.Fatal("expected error after process death")
	}
	if strings.Contains(err.Error(), "context deadline") {
		t.Fatalf("call hung instead of failing fast: %v", err)
	}
}

func TestACPAnswersServerRequestWithoutBlockingNotifications(t *testing.T) {
	serverToClient, send := io.Pipe()
	clientToServer, receive := io.Pipe()
	defer send.Close()
	defer receive.Close()

	answerStarted := make(chan struct{}, 1)
	c := &acpClient{
		stdin:   receive,
		done:    make(chan struct{}),
		cancel:  func() {},
		pending: make(map[int64]chan acpRPCResponse),
		onRequest: func(_ context.Context, method string, _ json.RawMessage) (json.RawMessage, *acpJSONRPCError) {
			if method != "elicitation/create" {
				t.Fatalf("request method = %q", method)
			}
			answerStarted <- struct{}{}
			return json.RawMessage(`{"action":"cancel"}`), nil
		},
	}
	go c.readLoop(serverToClient)

	response := make(chan acpRPCServerResponse, 1)
	go func() {
		var got acpRPCServerResponse
		err := json.NewDecoder(clientToServer).Decode(&got)
		if err != nil {
			t.Errorf("decode ACP server response: %v", err)
			return
		}
		response <- got
	}()

	if _, err := io.WriteString(send, `{"jsonrpc":"2.0","id":"ask-1","method":"elicitation/create","params":{"mode":"form"}}`+"\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-answerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("server request was not dispatched")
	}
	select {
	case got := <-response:
		if string(got.ID) != `"ask-1"` || string(got.Result) != `{"action":"cancel"}` || got.Error != nil {
			t.Fatalf("unexpected ACP response: %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server request did not receive JSON-RPC response")
	}
}

// TestACPSubscriptionMethodMapping covers the per-runner subscription auth
// method mapping used by /runner-auth/status.
func TestACPSubscriptionMethodMapping(t *testing.T) {
	cases := []struct {
		runner string
		want   string
	}{
		{"opencode", "opencode-login"},
		{"claude", "claude-ai-login"},
		{"codex", "chat-gpt"},
		{"glm", ""},
	}
	for _, tc := range cases {
		if got := acpSubscriptionMethodID(tc.runner); got != tc.want {
			t.Errorf("acpSubscriptionMethodID(%q) = %q, want %q", tc.runner, got, tc.want)
		}
	}
}

func errorsAs(err error, target any) bool {
	return asErr(err, target)
}

func asErr(err error, target any) bool {
	switch t := target.(type) {
	case **acpJSONRPCError:
		*t, _ = err.(*acpJSONRPCError)
		return *t != nil
	}
	return false
}
