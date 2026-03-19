package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ACLPeerInfo is a JSON-safe struct for listing peers with their connection status.
type ACLPeerInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	URL       string `json:"url,omitempty"`
	Command   string `json:"command,omitempty"`
	Connected bool   `json:"connected"`
}

// stdioPeer holds the running process state for a stdio-transport MCP peer.
type stdioPeer struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	mu     sync.Mutex // serializes request/response over stdio
}

// ACLManager manages connections to MCP peers via HTTP or stdio transports.
type ACLManager struct {
	mu         sync.RWMutex
	peers      map[string]ACLPeerConfig
	stdioPeers map[string]*stdioPeer
	httpClient *http.Client
	nextID     atomic.Int64
}

// NewACLManager creates an ACLManager and starts stdio peers.
func NewACLManager(peers []ACLPeerConfig) *ACLManager {
	a := &ACLManager{
		peers:      make(map[string]ACLPeerConfig),
		stdioPeers: make(map[string]*stdioPeer),
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
	for _, p := range peers {
		if err := a.AddPeer(p); err != nil {
			log.Printf("acl: failed to add peer %s: %v", p.ID, err)
		}
	}
	return a
}

// AddPeer registers a peer. For stdio peers, the subprocess is spawned immediately.
func (a *ACLManager) AddPeer(peer ACLPeerConfig) error {
	if peer.ID == "" {
		return fmt.Errorf("peer id is required")
	}
	if peer.Type != "http" && peer.Type != "stdio" {
		return fmt.Errorf("unsupported peer type %q (must be http or stdio)", peer.Type)
	}
	if peer.Type == "http" && peer.URL == "" {
		return fmt.Errorf("url is required for http peers")
	}
	if peer.Type == "stdio" && peer.Command == "" {
		return fmt.Errorf("command is required for stdio peers")
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	if _, exists := a.peers[peer.ID]; exists {
		return fmt.Errorf("peer %q already exists", peer.ID)
	}

	a.peers[peer.ID] = peer

	if peer.Type == "stdio" {
		if err := a.startStdioPeer(peer); err != nil {
			delete(a.peers, peer.ID)
			return fmt.Errorf("start stdio peer %q: %w", peer.ID, err)
		}
	}
	return nil
}

// startStdioPeer spawns the subprocess. Caller must hold a.mu.
func (a *ACLManager) startStdioPeer(peer ACLPeerConfig) error {
	parts := strings.Fields(peer.Command)
	if len(parts) == 0 {
		return fmt.Errorf("empty command")
	}

	cmd := exec.Command(parts[0], parts[1:]...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		stdin.Close()
		return fmt.Errorf("start command: %w", err)
	}

	a.stdioPeers[peer.ID] = &stdioPeer{
		cmd:    cmd,
		stdin:  stdin,
		stdout: bufio.NewReader(stdout),
	}
	log.Printf("acl: started stdio peer %s (pid %d)", peer.ID, cmd.Process.Pid)
	return nil
}

// RemovePeer removes a peer and kills its subprocess if stdio.
func (a *ACLManager) RemovePeer(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if _, exists := a.peers[id]; !exists {
		return fmt.Errorf("peer %q not found", id)
	}

	if sp, ok := a.stdioPeers[id]; ok {
		sp.stdin.Close()
		_ = sp.cmd.Process.Kill()
		_ = sp.cmd.Wait()
		delete(a.stdioPeers, id)
		log.Printf("acl: stopped stdio peer %s", id)
	}

	delete(a.peers, id)
	return nil
}

// ListPeers returns info about all registered peers.
func (a *ACLManager) ListPeers() []ACLPeerInfo {
	a.mu.RLock()
	defer a.mu.RUnlock()

	result := make([]ACLPeerInfo, 0, len(a.peers))
	for _, p := range a.peers {
		info := ACLPeerInfo{
			ID:      p.ID,
			Name:    p.Name,
			Type:    p.Type,
			URL:     p.URL,
			Command: p.Command,
		}
		if p.Type == "stdio" {
			sp, ok := a.stdioPeers[p.ID]
			info.Connected = ok && sp.cmd.ProcessState == nil
		} else {
			info.Connected = true // assume connected; HealthCheck verifies
		}
		result = append(result, info)
	}
	return result
}

// ListPeerTools calls tools/list on the specified peer and returns the tools array.
func (a *ACLManager) ListPeerTools(peerID string) ([]map[string]interface{}, error) {
	resp, err := a.sendRequest(peerID, "tools/list", nil)
	if err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("peer error %d: %s", resp.Error.Code, resp.Error.Message)
	}

	resultMap, ok := resp.Result.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("unexpected result type from tools/list")
	}
	toolsRaw, ok := resultMap["tools"]
	if !ok {
		return nil, fmt.Errorf("no tools field in response")
	}

	// Re-marshal and unmarshal to get a clean []map[string]interface{}.
	data, err := json.Marshal(toolsRaw)
	if err != nil {
		return nil, fmt.Errorf("marshal tools: %w", err)
	}
	var tools []map[string]interface{}
	if err := json.Unmarshal(data, &tools); err != nil {
		return nil, fmt.Errorf("unmarshal tools: %w", err)
	}
	return tools, nil
}

// CallPeerTool calls tools/call on the specified peer for the given tool name and arguments.
func (a *ACLManager) CallPeerTool(peerID, toolName string, args json.RawMessage) (interface{}, error) {
	params := map[string]interface{}{
		"name": toolName,
	}
	if args != nil {
		var arguments interface{}
		if err := json.Unmarshal(args, &arguments); err != nil {
			return nil, fmt.Errorf("invalid arguments: %w", err)
		}
		params["arguments"] = arguments
	}

	paramsJSON, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("marshal params: %w", err)
	}

	resp, err := a.sendRequest(peerID, "tools/call", json.RawMessage(paramsJSON))
	if err != nil {
		return nil, err
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("peer error %d: %s", resp.Error.Code, resp.Error.Message)
	}
	return resp.Result, nil
}

// HealthCheck pings each peer and returns a map of peer ID to reachable status.
func (a *ACLManager) HealthCheck() map[string]bool {
	a.mu.RLock()
	peerIDs := make([]string, 0, len(a.peers))
	for id := range a.peers {
		peerIDs = append(peerIDs, id)
	}
	a.mu.RUnlock()

	results := make(map[string]bool)
	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, id := range peerIDs {
		wg.Add(1)
		go func(peerID string) {
			defer wg.Done()
			_, err := a.sendRequest(peerID, "ping", nil)
			mu.Lock()
			results[peerID] = err == nil
			mu.Unlock()
		}(id)
	}

	wg.Wait()
	return results
}

// Shutdown kills all stdio peer processes and cleans up.
func (a *ACLManager) Shutdown() {
	a.mu.Lock()
	defer a.mu.Unlock()

	for id, sp := range a.stdioPeers {
		sp.stdin.Close()
		_ = sp.cmd.Process.Kill()
		_ = sp.cmd.Wait()
		log.Printf("acl: shutdown stdio peer %s", id)
	}
	a.stdioPeers = make(map[string]*stdioPeer)
	a.peers = make(map[string]ACLPeerConfig)
}

// sendRequest dispatches a JSON-RPC request to the peer using the appropriate transport.
func (a *ACLManager) sendRequest(peerID, method string, params json.RawMessage) (*mcpResponse, error) {
	a.mu.RLock()
	peer, ok := a.peers[peerID]
	a.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("peer %q not found", peerID)
	}

	req := mcpRequest{
		JSONRPC: "2.0",
		ID:      a.nextID.Add(1),
		Method:  method,
		Params:  params,
	}

	switch peer.Type {
	case "http":
		return a.sendHTTP(peer, req)
	case "stdio":
		return a.sendStdio(peer.ID, req)
	default:
		return nil, fmt.Errorf("unsupported peer type %q", peer.Type)
	}
}

// sendHTTP sends a JSON-RPC request to an HTTP MCP peer.
func (a *ACLManager) sendHTTP(peer ACLPeerConfig, req mcpRequest) (*mcpResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequest(http.MethodPost, peer.URL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if peer.Auth != "" {
		httpReq.Header.Set("Authorization", "Bearer "+peer.Auth)
	}

	httpResp, err := a.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("http request to %s: %w", peer.URL, err)
	}
	defer httpResp.Body.Close()

	if httpResp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(io.LimitReader(httpResp.Body, 1024))
		return nil, fmt.Errorf("http %d from %s: %s", httpResp.StatusCode, peer.URL, string(respBody))
	}

	var resp mcpResponse
	if err := json.NewDecoder(httpResp.Body).Decode(&resp); err != nil {
		return nil, fmt.Errorf("decode response from %s: %w", peer.URL, err)
	}
	return &resp, nil
}

// sendStdio sends a JSON-RPC request to a stdio MCP peer via its stdin/stdout.
func (a *ACLManager) sendStdio(peerID string, req mcpRequest) (*mcpResponse, error) {
	a.mu.RLock()
	sp, ok := a.stdioPeers[peerID]
	a.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("stdio peer %q not running", peerID)
	}

	sp.mu.Lock()
	defer sp.mu.Unlock()

	// Write the request as a single JSON line.
	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}
	data = append(data, '\n')

	if _, err := sp.stdin.Write(data); err != nil {
		return nil, fmt.Errorf("write to stdio peer %s: %w", peerID, err)
	}

	// Read one line of response.
	line, err := sp.stdout.ReadBytes('\n')
	if err != nil {
		return nil, fmt.Errorf("read from stdio peer %s: %w", peerID, err)
	}

	var resp mcpResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("decode response from stdio peer %s: %w", peerID, err)
	}
	return &resp, nil
}
