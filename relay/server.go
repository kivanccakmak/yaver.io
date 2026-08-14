package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
)

// RelayServer accepts QUIC tunnels from agents and proxies HTTP requests
// from mobile clients through those tunnels.
type RelayServer struct {
	quicPort int // QUIC port for agent tunnels
	httpPort int // HTTP port for mobile clients

	// password is protected by pwMu for runtime updates
	pwMu     sync.RWMutex
	password string // shared password for relay authentication (empty = no auth)

	startedAt time.Time // server start time for uptime tracking
	passwordFile string
	requestSlots chan struct{}
	corsOrigins []string

	// deviceID -> active agent tunnel
	mu      sync.RWMutex
	tunnels map[string]*agentTunnel
}

type agentTunnel struct {
	deviceID string
	conn     quic.Connection
	peerAddr string // observed public address
	connAt   time.Time
}

func NewRelayServer(quicPort, httpPort int, password string) *RelayServer {
	return &RelayServer{
		quicPort:  quicPort,
		httpPort:  httpPort,
		password:  password,
		startedAt: time.Now(),
		tunnels:   make(map[string]*agentTunnel),
		passwordFile: envOrDefault("RELAY_PASSWORD_FILE", ".relay-password"),
		requestSlots: make(chan struct{}, 256),
		corsOrigins: configuredRelayCORSOrigins(),
	}
}

// getPassword returns the current relay password (thread-safe).
func (s *RelayServer) getPassword() string {
	s.pwMu.RLock()
	defer s.pwMu.RUnlock()
	return s.password
}

// setPassword updates the relay password in memory (thread-safe).
func (s *RelayServer) setPassword(pw string) {
	s.pwMu.Lock()
	defer s.pwMu.Unlock()
	s.password = pw
}

// Start runs both the QUIC tunnel listener and the HTTP proxy.
func (s *RelayServer) Start(ctx context.Context) error {
	errCh := make(chan error, 2)

	go func() { errCh <- s.runQUICListener(ctx) }()
	go func() { errCh <- s.runHTTPProxy(ctx) }()

	// Log connected tunnels periodically
	go s.logTunnels(ctx)

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		return nil
	}
}

// --- QUIC Tunnel Listener (agents connect here) ---

func (s *RelayServer) runQUICListener(ctx context.Context) error {
	tlsCfg, err := generateRelayTLS()
	if err != nil {
		return fmt.Errorf("TLS setup: %w", err)
	}

	addr := fmt.Sprintf("0.0.0.0:%d", s.quicPort)
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return fmt.Errorf("resolve: %w", err)
	}

	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	defer conn.Close()

	tr := &quic.Transport{Conn: conn}
	listener, err := tr.Listen(tlsCfg, &quic.Config{
		MaxIdleTimeout:  120 * time.Second,
		KeepAlivePeriod: 20 * time.Second,
	})
	if err != nil {
		return fmt.Errorf("quic listen: %w", err)
	}
	defer listener.Close()

	log.Printf("[RELAY] QUIC tunnel listener on %s", addr)

	go func() {
		<-ctx.Done()
		listener.Close()
	}()

	for {
		session, err := listener.Accept(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			log.Printf("[RELAY] accept error: %v", err)
			continue
		}
		go s.handleAgentConnection(ctx, session)
	}
}

func (s *RelayServer) handleAgentConnection(ctx context.Context, conn quic.Connection) {
	remoteAddr := conn.RemoteAddr().String()
	log.Printf("[RELAY] Agent connected from %s", remoteAddr)

	// Wait for registration stream
	registrationCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	stream, err := conn.AcceptStream(registrationCtx)
	if err != nil {
		log.Printf("[RELAY] accept registration stream from %s: %v", remoteAddr, err)
		conn.CloseWithError(1, "no registration")
		return
	}

	data, err := readLimitedBody(stream, 1<<16)
	if err != nil {
		log.Printf("[RELAY] read registration from %s: %v", remoteAddr, err)
		conn.CloseWithError(1, "read error")
		return
	}

	var reg RegisterMsg
	if err := json.Unmarshal(data, &reg); err != nil || reg.Type != "register" {
		resp, _ := json.Marshal(RegisterResp{Type: "error", OK: false, Message: "invalid registration"})
		stream.Write(resp)
		stream.Close()
		conn.CloseWithError(1, "bad registration")
		return
	}

	if reg.DeviceID == "" || reg.Token == "" {
		resp, _ := json.Marshal(RegisterResp{Type: "error", OK: false, Message: "deviceId and token required"})
		stream.Write(resp)
		stream.Close()
		conn.CloseWithError(1, "missing fields")
		return
	}

	// Validate relay password if configured
	if pw := s.getPassword(); pw != "" && reg.Password != pw {
		resp, _ := json.Marshal(RegisterResp{Type: "error", OK: false, Message: "invalid relay password"})
		stream.Write(resp)
		stream.Close()
		conn.CloseWithError(1, "invalid relay password")
		return
	}

	// TODO: Validate token against Convex backend
	// For now, accept any non-empty token (the agent already validated it)

	// Register the tunnel
	tunnel := &agentTunnel{
		deviceID: reg.DeviceID,
		conn:     conn,
		peerAddr: remoteAddr,
		connAt:   time.Now(),
	}

	s.mu.Lock()
	old, exists := s.tunnels[reg.DeviceID]
	s.tunnels[reg.DeviceID] = tunnel
	s.mu.Unlock()

	if exists {
		log.Printf("[RELAY] Replacing existing tunnel for device %s (was %s)", shortID(reg.DeviceID), old.peerAddr)
		old.conn.CloseWithError(0, "replaced")
	}

	// Send success
	resp, _ := json.Marshal(RegisterResp{Type: "registered", OK: true})
	stream.Write(resp)
	stream.Close()

	log.Printf("[RELAY] Device %s registered from %s", shortID(reg.DeviceID), remoteAddr)

	// Keep connection alive — block until it dies
	<-conn.Context().Done()

	s.mu.Lock()
	if cur, ok := s.tunnels[reg.DeviceID]; ok && cur.conn == conn {
		delete(s.tunnels, reg.DeviceID)
	}
	s.mu.Unlock()

	log.Printf("[RELAY] Device %s disconnected (%s)", shortID(reg.DeviceID), remoteAddr)
}

// --- HTTP Proxy (mobile clients connect here) ---

func (s *RelayServer) runHTTPProxy(ctx context.Context) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/tunnels", s.handleListTunnels)
	mux.HandleFunc("/admin/set-password", s.handleSetPassword)
	mux.HandleFunc("/admin/status", s.handleAdminStatus)
	mux.HandleFunc("/d/", s.handleProxy) // /d/{deviceId}/...

	srv := &http.Server{
		Addr:    fmt.Sprintf("0.0.0.0:%d", s.httpPort),
		Handler: withRelayCORS(mux, s.corsOrigins),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      15 * time.Minute,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	log.Printf("[RELAY] HTTP proxy on 0.0.0.0:%d", s.httpPort)
	err := srv.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (s *RelayServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	count := len(s.tunnels)
	s.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":      true,
		"tunnels": count,
		"version": version,
	})
}

func (s *RelayServer) handleListTunnels(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	list := make([]map[string]interface{}, 0, len(s.tunnels))
	for _, t := range s.tunnels {
		id := t.deviceID
		if len(id) > 8 {
			id = id[:8] + "..."
		}
		list = append(list, map[string]interface{}{
			"deviceId":    id,
			"peerAddr":    t.peerAddr,
			"connectedAt": t.connAt.Format(time.RFC3339),
			"uptime":      time.Since(t.connAt).Round(time.Second).String(),
		})
	}
	s.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":      true,
		"tunnels": list,
	})
}

// handleSetPassword allows runtime password changes via POST /admin/set-password.
func (s *RelayServer) handleSetPassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Password        string `json:"password"`
		CurrentPassword string `json:"current_password"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": "invalid request body",
		})
		return
	}

	if req.Password == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": "password is required",
		})
		return
	}

	// If a password is currently set, require current_password to match
	if currentPw := s.getPassword(); currentPw != "" {
		if req.CurrentPassword != currentPw {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error": "invalid current password",
			})
			return
		}
	}

	// Update password in memory
	s.setPassword(req.Password)

	// Persist to .relay-password file
	if err := os.WriteFile(s.passwordFile, []byte(req.Password), 0600); err != nil {
		log.Printf("[RELAY] Warning: could not write %s: %v", s.passwordFile, err)
	}

	log.Printf("[RELAY] Password updated via API")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":      true,
		"message": "Password updated",
	})
}

// handleAdminStatus returns relay status info via GET /admin/status.
func (s *RelayServer) handleAdminStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	tunnelCount := len(s.tunnels)
	s.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":           true,
		"password_set": s.getPassword() != "",
		"tunnels":      tunnelCount,
		"uptime":       time.Since(s.startedAt).Round(time.Second).String(),
	})
}

// handleProxy proxies HTTP requests to agents via QUIC tunnel.
// URL format: /d/{deviceId}/... -> forwarded as /... to the agent
func (s *RelayServer) handleProxy(w http.ResponseWriter, r *http.Request) {
	select {
	case s.requestSlots <- struct{}{}:
		defer func() { <-s.requestSlots }()
	default:
		http.Error(w, `{"ok":false,"error":"relay busy"}`, http.StatusServiceUnavailable)
		return
	}
	// Parse: /d/{deviceId}/rest/of/path
	path := strings.TrimPrefix(r.URL.Path, "/d/")
	parts := strings.SplitN(path, "/", 2)
	if len(parts) == 0 || parts[0] == "" {
		http.Error(w, `{"ok":false,"error":"device ID required in path: /d/{deviceId}/..."}`, http.StatusBadRequest)
		return
	}

	deviceID := parts[0]
	forwardPath := "/"
	if len(parts) > 1 {
		forwardPath = "/" + parts[1]
	}

	// Validate relay password if configured
	if pw := s.getPassword(); pw != "" {
		if r.Header.Get("X-Relay-Password") != pw {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error": "invalid relay password",
			})
			return
		}
	}

	// Find the tunnel
	s.mu.RLock()
	tunnel, ok := s.tunnels[deviceID]
	s.mu.RUnlock()

	// Try prefix match if exact match fails (mobile might send short ID)
	if !ok && len(deviceID) >= 8 {
		s.mu.RLock()
		for id, t := range s.tunnels {
			if strings.HasPrefix(id, deviceID) {
				tunnel = t
				ok = true
				break
			}
		}
		s.mu.RUnlock()
	}

	if !ok {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":    false,
			"error": "device not connected to relay",
		})
		return
	}

	// Read request body
	var body []byte
	if r.Body != nil {
		body, err = readLimitedBody(r.Body, 10<<20)
		if err != nil {
			http.Error(w, `{"ok":false,"error":"request body too large"}`, http.StatusRequestEntityTooLarge)
			return
		}
	}

	// Build tunnel request
	headers := make(map[string]string)
	for k, v := range r.Header {
		if len(v) > 0 {
			headers[k] = v[0]
		}
	}

	tunnelReq := TunnelRequest{
		ID:      fmt.Sprintf("%d", time.Now().UnixNano()),
		Method:  r.Method,
		Path:    forwardPath,
		Query:   r.URL.RawQuery,
		Headers: headers,
		Body:    body,
	}

	// Open a QUIC stream to the agent
	streamCtx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	stream, err := tunnel.conn.OpenStreamSync(streamCtx)
	if err != nil {
		log.Printf("[RELAY] open stream to %s failed: %v", shortID(tunnel.deviceID), err)

		// Clean up dead tunnel
		s.mu.Lock()
		if cur, exists := s.tunnels[tunnel.deviceID]; exists && cur.conn == tunnel.conn {
			delete(s.tunnels, tunnel.deviceID)
		}
		s.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":    false,
			"error": "agent tunnel broken, reconnecting...",
		})
		return
	}
	defer stream.Close()
	// A disconnected mobile client must release the QUIC stream and the agent
	// handler promptly. Without this, abandoned SSE/request streams accumulate.
	lifetimeCtx, cancelLifetime := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancelLifetime()
	requestDone := make(chan struct{})
	defer close(requestDone)
	go func() {
		select {
		case <-lifetimeCtx.Done():
			stream.CancelRead(0)
			stream.CancelWrite(0)
		case <-requestDone:
		}
	}()

	// Send request
	reqData, _ := json.Marshal(tunnelReq)
	if _, err := stream.Write(reqData); err != nil {
		log.Printf("[RELAY] write to %s failed: %v", shortID(tunnel.deviceID), err)
		stream.Close()
		http.Error(w, "tunnel write error", http.StatusBadGateway)
		return
	}
	stream.Close() // signal done writing

	// Check if this is an SSE request
	if strings.Contains(forwardPath, "/output") && r.Method == "GET" {
		s.proxySSE(w, r, stream, tunnel.deviceID)
		return
	}

	// Read response
	respData, err := io.ReadAll(io.LimitReader(stream, 10<<20))
	if err != nil {
		log.Printf("[RELAY] read from %s failed: %v", shortID(tunnel.deviceID), err)
		http.Error(w, "tunnel read error", http.StatusBadGateway)
		return
	}

	var tunnelResp TunnelResponse
	if err := json.Unmarshal(respData, &tunnelResp); err != nil {
		log.Printf("[RELAY] parse response from %s failed: %v", shortID(tunnel.deviceID), err)
		http.Error(w, "tunnel response parse error", http.StatusBadGateway)
		return
	}

	// Write response headers
	for k, v := range tunnelResp.Headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(tunnelResp.StatusCode)
	w.Write(tunnelResp.Body)
}

// proxySSE handles Server-Sent Events by streaming from the QUIC stream.
func (s *RelayServer) proxySSE(w http.ResponseWriter, r *http.Request, stream quic.Stream, deviceID string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	buf := make([]byte, 4096)
	for {
		n, err := stream.Read(buf)
		if n > 0 {
			w.Write(buf[:n])
			flusher.Flush()
		}
		if err != nil {
			return
		}
	}
}

func readLimitedBody(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("body exceeds %d bytes", limit)
	}
	return b, nil
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func (s *RelayServer) logTunnels(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.RLock()
			count := len(s.tunnels)
			for _, t := range s.tunnels {
				id := t.deviceID
				if len(id) > 8 {
					id = id[:8]
				}
				log.Printf("[RELAY] Tunnel: %s from %s (up %s)", id, t.peerAddr, time.Since(t.connAt).Round(time.Second))
			}
			s.mu.RUnlock()
			if count == 0 {
				log.Printf("[RELAY] No active tunnels")
			}
		}
	}
}

// --- CORS ---

func configuredRelayCORSOrigins() []string {
	// Production origins are always allowed. Localhost is intentionally
	// limited to HTTP loopback origins for Expo/Next development servers;
	// arbitrary public origins are never accepted by default.
	origins := []string{"https://yaver.io", "https://www.yaver.io"}
	for _, raw := range strings.Split(os.Getenv("RELAY_CORS_ORIGINS"), ",") {
		if origin := strings.TrimSpace(raw); origin != "" {
			origins = append(origins, strings.TrimRight(origin, "/"))
		}
	}
	return origins
}

func isAllowedRelayOrigin(origin string, configured []string) bool {
	for _, allowed := range configured {
		if origin == allowed {
			return true
		}
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Hostname() == "" {
		return false
	}
	host := u.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func withRelayCORS(next http.Handler, configured []string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if isAllowedRelayOrigin(origin, configured) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Relay-Password")
		}
		if r.Method == http.MethodOptions {
			if origin != "" && !isAllowedRelayOrigin(origin, configured) {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- TLS ---

func generateRelayTLS() (*tls.Config, error) {
	certPath := os.Getenv("RELAY_TLS_CERT")
	keyPath := os.Getenv("RELAY_TLS_KEY")
	if (certPath == "") != (keyPath == "") {
		return nil, fmt.Errorf("RELAY_TLS_CERT and RELAY_TLS_KEY must be set together")
	}
	if certPath != "" {
		cert, err := tls.LoadX509KeyPair(certPath, keyPath)
		if err != nil {
			return nil, fmt.Errorf("load relay TLS certificate: %w", err)
		}
		return &tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: []string{"yaver-relay"}}, nil
	}

	log.Printf("[RELAY] WARNING: using an ephemeral TLS certificate; set RELAY_TLS_CERT and RELAY_TLS_KEY for stable relay identity")
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	tmpl := x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{Organization: []string{"Yaver Relay"}},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return nil, err
	}

	return &tls.Config{
		Certificates: []tls.Certificate{{
			Certificate: [][]byte{certDER},
			PrivateKey:  priv,
		}},
		NextProtos: []string{"yaver-relay"},
	}, nil
}
