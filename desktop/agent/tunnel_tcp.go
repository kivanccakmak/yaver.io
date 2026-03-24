package main

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
)

// TunnelSession represents an active TCP port tunnel.
type TunnelSession struct {
	ID        string `json:"id"`
	LocalPort int    `json:"localPort"`
	Protocol  string `json:"protocol"` // "flutter", "rn-metro", "custom"
	Active    bool   `json:"active"`
	CreatedAt string `json:"createdAt"`

	// Internal
	listener net.Listener `json:"-"`
	done     chan struct{} `json:"-"`
}

// TunnelManager manages TCP port tunnels exposed via HTTP.
type TunnelManager struct {
	mu      sync.RWMutex
	tunnels map[string]*TunnelSession
}

// NewTunnelManager creates a new tunnel manager.
func NewTunnelManager() *TunnelManager {
	return &TunnelManager{
		tunnels: make(map[string]*TunnelSession),
	}
}

// CreateTunnel creates a tunnel that exposes a local TCP port via HTTP streaming.
// The local port is on the dev machine (e.g., Flutter VM service at :9100).
// Mobile connects via HTTP endpoints to read/write to this port.
func (tm *TunnelManager) CreateTunnel(localPort int, protocol string) (*TunnelSession, error) {
	// Verify the local port is accessible
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", localPort), 2*time.Second)
	if err != nil {
		// Port not yet available — that's OK for debug sessions that start later
		log.Printf("[tunnel] Port %d not yet available, tunnel will connect when ready", localPort)
	} else {
		conn.Close()
	}

	session := &TunnelSession{
		ID:        uuid.New().String()[:8],
		LocalPort: localPort,
		Protocol:  protocol,
		Active:    true,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
		done:      make(chan struct{}),
	}

	tm.mu.Lock()
	tm.tunnels[session.ID] = session
	tm.mu.Unlock()

	log.Printf("[tunnel] Created tunnel %s → localhost:%d (%s)", session.ID, localPort, protocol)
	return session, nil
}

// GetTunnel returns a tunnel by ID.
func (tm *TunnelManager) GetTunnel(id string) (*TunnelSession, bool) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	t, ok := tm.tunnels[id]
	return t, ok
}

// ListTunnels returns all tunnels.
func (tm *TunnelManager) ListTunnels() []*TunnelSession {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	result := make([]*TunnelSession, 0, len(tm.tunnels))
	for _, t := range tm.tunnels {
		result = append(result, t)
	}
	return result
}

// CloseTunnel closes a tunnel.
func (tm *TunnelManager) CloseTunnel(id string) error {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	t, ok := tm.tunnels[id]
	if !ok {
		return fmt.Errorf("tunnel %q not found", id)
	}
	t.Active = false
	close(t.done)
	if t.listener != nil {
		t.listener.Close()
	}
	delete(tm.tunnels, id)
	log.Printf("[tunnel] Closed tunnel %s", id)
	return nil
}

// HandleTunnelConnect handles bidirectional HTTP streaming to a tunnel's local TCP port.
// This implements a simple HTTP-based TCP proxy:
// - Client sends POST with body = data to send to the TCP port
// - Client receives response body = data from the TCP port
// - Works through relay because it's standard HTTP
func (tm *TunnelManager) HandleTunnelConnect(w http.ResponseWriter, r *http.Request, tunnelID string) {
	tunnel, ok := tm.GetTunnel(tunnelID)
	if !ok {
		http.Error(w, "tunnel not found", http.StatusNotFound)
		return
	}
	if !tunnel.Active {
		http.Error(w, "tunnel closed", http.StatusGone)
		return
	}

	// Connect to local port
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", tunnel.LocalPort), 5*time.Second)
	if err != nil {
		http.Error(w, fmt.Sprintf("cannot connect to port %d: %v", tunnel.LocalPort, err), http.StatusBadGateway)
		return
	}
	defer conn.Close()

	// Hijack the HTTP connection for bidirectional streaming
	hj, ok := w.(http.Hijacker)
	if !ok {
		// Fallback for non-hijackable connections (e.g., HTTP/2)
		// Use simple request-response: forward body to TCP, return TCP response
		tm.handleTunnelSimple(w, r, conn)
		return
	}

	clientConn, buf, err := hj.Hijack()
	if err != nil {
		http.Error(w, "hijack failed", http.StatusInternalServerError)
		return
	}
	defer clientConn.Close()

	// Send HTTP 200 response before starting bidirectional copy
	buf.WriteString("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
	buf.Flush()

	// Bidirectional copy
	done := make(chan struct{}, 2)
	go func() {
		io.Copy(conn, clientConn) // client → TCP
		done <- struct{}{}
	}()
	go func() {
		io.Copy(clientConn, conn) // TCP → client
		done <- struct{}{}
	}()

	select {
	case <-done:
	case <-tunnel.done:
	}
}

// handleTunnelSimple is a fallback for when HTTP hijacking isn't available.
// Forwards request body to TCP port, returns TCP response as HTTP response.
func (tm *TunnelManager) handleTunnelSimple(w http.ResponseWriter, r *http.Request, conn net.Conn) {
	// Send request body to TCP
	if r.Body != nil {
		io.Copy(conn, r.Body)
	}

	// Set response headers for streaming
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)

	flusher, canFlush := w.(http.Flusher)

	// Read from TCP and stream to HTTP response
	buf := make([]byte, 4096)
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			w.Write(buf[:n])
			if canFlush {
				flusher.Flush()
			}
		}
		if err != nil {
			break
		}
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	}
}

// SendInput sends a keystroke to the tunnel's local TCP port.
// Used for hot reload commands (r = reload, R = restart).
func (tm *TunnelManager) SendInput(tunnelID string, input string) error {
	tunnel, ok := tm.GetTunnel(tunnelID)
	if !ok {
		return fmt.Errorf("tunnel %q not found", tunnelID)
	}

	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", tunnel.LocalPort), 2*time.Second)
	if err != nil {
		return fmt.Errorf("connect to port %d: %w", tunnel.LocalPort, err)
	}
	defer conn.Close()

	_, err = conn.Write([]byte(input))
	return err
}
