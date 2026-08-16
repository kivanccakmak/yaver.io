package main

// turn_credentials.go — issues short-lived TURN credentials so the
// web viewer's RTCPeerConnection can include a relay-backed ICE
// candidate. When ICE can't find a direct path (CG-NAT both ends,
// corporate WiFi blocking inbound UDP, etc.), the relay's colocated
// TURN listener (relay/turn.go) becomes the rendezvous.
//
// Official relays broker Pion long-term credentials after authenticating the
// account's scoped relay password; the long-lived TURN secret never leaves the
// relay. Self-hosters can still opt into local derivation with
// TURN_AUTH_SECRET (or RELAY_PASSWORD). The browser sees only a short-lived
// credential, valid for about one minute.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	pionturn "github.com/pion/turn/v4"
	"github.com/pion/webrtc/v4"
)

// turnCredentialResponse is the shape the web viewer plugs straight
// into RTCPeerConnection { iceServers: [...] }. We always include a
// public STUN entry (so direct ICE candidates still get gathered)
// before the TURN entry — that order matches what works best with
// Chrome / Safari ICE prioritization.
type turnCredentialResponse struct {
	IceServers []turnIceServer `json:"iceServers"`
	TTLSeconds int             `json:"ttlSeconds"`
}

type turnIceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// rtcICEServerProvider is injected into RemoteRuntimeManager by HTTPServer.
// Keeping the provider at the authenticated server boundary lets both Pion
// peers use the same managed relay broker without putting the long-lived TURN
// secret on every customer machine.
type rtcICEServerProvider func(context.Context) []webrtc.ICEServer

// turnCredentialTTL is how long each derived password is valid for.
// 60s is short enough that a leaked password becomes useless almost
// immediately, long enough that ICE always finishes within the
// window.
const turnCredentialTTL = 60 * time.Second

// handleRemoteRuntimeTURNCredentials backs GET
// /remote-runtime/turn-credentials. The viewer fetches it once per
// session, sticks the result into RTCPeerConnection, then forgets
// about it. Owner-only — guests on the vibing scope cannot mint TURN
// credentials (they'd be eligible to relay arbitrary UDP through the
// operator's bandwidth).
func (s *HTTPServer) handleRemoteRuntimeTURNCredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}

	resp := localTURNCredentialResponse()
	if len(resp.IceServers) > 1 {
		jsonReply(w, http.StatusOK, resp)
		return
	}

	// Official/shared relays broker ephemeral credentials after validating the
	// account's existing relay password. The TURN secret stays on the relay;
	// this agent and its viewers receive only a 60-second credential. A broker
	// outage degrades honestly to STUN rather than blocking the whole preview.
	if managed, err := s.fetchManagedTURNCredentials(r.Context()); err == nil && len(managed.IceServers) > 1 {
		jsonReply(w, http.StatusOK, managed)
		return
	}
	jsonReply(w, http.StatusOK, resp)
}

func localTURNCredentialResponse() turnCredentialResponse {
	resp := turnCredentialResponse{TTLSeconds: int(turnCredentialTTL / time.Second)}

	// Always offer a STUN server so Chrome/Safari can still gather
	// host + srflx candidates for the direct-WebRTC happy path.
	// Google's free STUN is used by every webrtc.org example for a
	// reason — it's reliable and globally anycast. Self-hosters who
	// want a private STUN flip the env var.
	stunURL := strings.TrimSpace(os.Getenv("YAVER_STUN_URL"))
	if stunURL == "" {
		stunURL = "stun:stun.l.google.com:19302"
	}
	resp.IceServers = append(resp.IceServers, turnIceServer{URLs: []string{stunURL}})

	// TURN is opt-in. If the operator hasn't pointed us at one (via
	// either YAVER_TURN_URL or, for a self-hosted relay, the same
	// host that backs RELAY_URL), we just return STUN-only and let
	// ICE try its best. The viewer never knows whether the agent
	// has TURN configured — it only sees what's in the response.
	turnURL := resolveTurnURL()
	if turnURL == "" {
		return resp
	}

	secret := turnAuthSecret()
	if secret == "" {
		// Configuration mistake worth making visible — without a
		// shared secret the relay's TURN handler refuses every
		// request. Log it but still return STUN-only so the viewer
		// doesn't fail the whole session.
		return resp
	}

	user, pass, err := pionturn.GenerateLongTermCredentials(secret, turnCredentialTTL)
	if err != nil {
		return resp
	}

	resp.IceServers = append(resp.IceServers, turnIceServer{
		URLs:       []string{turnURL},
		Username:   user,
		Credential: pass,
	})
	return resp
}

// iceServersForHTTPServer is the one source used by both sides of an agent's
// PeerConnection. Local/self-hosted TURN env config wins. Otherwise it asks a
// configured relay's authenticated /ice broker. Every network leg is bounded;
// a broker failure returns STUN-only and can never wedge session creation.
func (s *HTTPServer) iceServersForHTTPServer(ctx context.Context) []webrtc.ICEServer {
	local := iceServersForPeer()
	if len(local) > 1 || s == nil || strings.TrimSpace(s.convexURL) == "" || strings.TrimSpace(s.token) == "" {
		return local
	}
	resp, err := s.fetchManagedTURNCredentials(ctx)
	if err != nil {
		return local
	}
	managed := make([]webrtc.ICEServer, 0, len(resp.IceServers))
	for _, server := range resp.IceServers {
		if len(server.URLs) == 0 {
			continue
		}
		managed = append(managed, webrtc.ICEServer{
			URLs:       append([]string(nil), server.URLs...),
			Username:   server.Username,
			Credential: server.Credential,
		})
	}
	if len(managed) == 0 {
		return local
	}
	return managed
}

type relayICEEndpoint struct {
	URL      string
	Password string
}

func (s *HTTPServer) fetchManagedTURNCredentials(ctx context.Context) (turnCredentialResponse, error) {
	if s == nil || strings.TrimSpace(s.convexURL) == "" || strings.TrimSpace(s.token) == "" {
		return turnCredentialResponse{}, fmt.Errorf("managed TURN requires an authenticated agent")
	}
	cfg, err := LoadConfig()
	if err != nil || cfg == nil {
		return turnCredentialResponse{}, fmt.Errorf("load relay config: %w", err)
	}
	return fetchManagedTURNCredentialsFromConfig(ctx, cfg)
}

// fetchManagedTURNCredentialsFromConfig is shared by live session creation and
// `yaver doctor`. This prevents diagnostics from claiming TURN is absent while
// the authenticated /ice broker used by real viewers is healthy.
func fetchManagedTURNCredentialsFromConfig(ctx context.Context, cfg *Config) (turnCredentialResponse, error) {
	endpoints := relayICEEndpoints(cfg)
	if len(endpoints) == 0 {
		return turnCredentialResponse{}, fmt.Errorf("no authenticated relay endpoint configured")
	}
	deadlineCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 4 * time.Second}
	var lastErr error
	for i, endpoint := range endpoints {
		if i >= 3 {
			break
		}
		resp, err := fetchRelayTURNCredentials(deadlineCtx, client, endpoint)
		if err == nil && len(resp.IceServers) > 1 {
			return resp, nil
		}
		lastErr = err
		if deadlineCtx.Err() != nil {
			break
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("relay returned no TURN server")
	}
	return turnCredentialResponse{}, lastErr
}

func managedICEServersFromConfig(ctx context.Context, cfg *Config) ([]webrtc.ICEServer, error) {
	resp, err := fetchManagedTURNCredentialsFromConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	managed := make([]webrtc.ICEServer, 0, len(resp.IceServers))
	for _, server := range resp.IceServers {
		if len(server.URLs) == 0 {
			continue
		}
		managed = append(managed, webrtc.ICEServer{
			URLs:       append([]string(nil), server.URLs...),
			Username:   server.Username,
			Credential: server.Credential,
		})
	}
	if len(managed) == 0 {
		return nil, fmt.Errorf("relay returned no usable ICE server")
	}
	return managed, nil
}

func relayICEEndpoints(cfg *Config) []relayICEEndpoint {
	if cfg == nil {
		return nil
	}
	global := runtimeRelayPassword(cfg)
	servers := runtimeRelayConfigs(cfg)
	out := make([]relayICEEndpoint, 0, len(servers))
	seen := map[string]struct{}{}
	for _, server := range servers {
		base := strings.TrimRight(strings.TrimSpace(server.HttpURL), "/")
		password := strings.TrimSpace(server.Password)
		if password == "" {
			password = global
		}
		if base == "" || password == "" {
			continue
		}
		u, err := url.Parse(base)
		if err != nil || u.User != nil || u.Hostname() == "" || !safeRelayICEURL(u) {
			continue
		}
		iceURL := base + "/ice"
		if _, ok := seen[iceURL]; ok {
			continue
		}
		seen[iceURL] = struct{}{}
		out = append(out, relayICEEndpoint{URL: iceURL, Password: password})
	}
	return out
}

func safeRelayICEURL(u *url.URL) bool {
	if u == nil {
		return false
	}
	if strings.EqualFold(u.Scheme, "https") {
		return true
	}
	if !strings.EqualFold(u.Scheme, "http") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func fetchRelayTURNCredentials(ctx context.Context, client *http.Client, endpoint relayICEEndpoint) (turnCredentialResponse, error) {
	var out turnCredentialResponse
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.URL, nil)
	if err != nil {
		return out, err
	}
	req.Header.Set("X-Relay-Password", endpoint.Password)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return out, err
	}
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("TURN broker returned HTTP %d", resp.StatusCode)
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return out, fmt.Errorf("decode TURN broker response: %w", err)
	}
	if out.TTLSeconds < 1 || out.TTLSeconds > 600 || len(out.IceServers) == 0 || len(out.IceServers) > 8 {
		return turnCredentialResponse{}, fmt.Errorf("TURN broker returned invalid bounds")
	}
	for _, server := range out.IceServers {
		if len(server.URLs) == 0 || len(server.URLs) > 8 {
			return turnCredentialResponse{}, fmt.Errorf("TURN broker returned invalid URL list")
		}
		for _, rawURL := range server.URLs {
			lower := strings.ToLower(strings.TrimSpace(rawURL))
			if !strings.HasPrefix(lower, "stun:") && !strings.HasPrefix(lower, "turn:") && !strings.HasPrefix(lower, "turns:") {
				return turnCredentialResponse{}, fmt.Errorf("TURN broker returned unsupported ICE URL")
			}
		}
	}
	return out, nil
}

// turnAuthSecret is the self-hosted compatibility path. Managed Yaver relays
// use GET /ice and never distribute their long-lived TURN secret to agents.
func turnAuthSecret() string {
	if v := strings.TrimSpace(os.Getenv("TURN_AUTH_SECRET")); v != "" {
		return v
	}
	return strings.TrimSpace(os.Getenv("RELAY_PASSWORD"))
}

// turnCredentialsRouteHelper writes a JSON 200 response. Defensive
// helper used by tests that don't have an HTTPServer available.
func writeTURNCredentials(w http.ResponseWriter, resp turnCredentialResponse) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// derivedTurnURLFromRelayURL builds "turn:<host>:<port>" from RELAY_URL
// (e.g. "https://relay.yaver.io" → "turn:relay.yaver.io:3478").
//
// This is the F2 fix (WEBRTC_LANE_DEEP_AUDIT): production WebRTC was
// STUN-only because nothing in any deploy pipeline set YAVER_TURN_URL, even
// though the shipped relay already colocates a TURN server on the same host.
// Operators who set RELAY_URL (everyone — it is how the agent finds the
// relay) now get TURN for free; YAVER_TURN_URL still wins when explicitly
// set. Port defaults to 3478 (IANA TURN) and can be overridden with
// YAVER_TURN_PORT; host comes from the relay URL's hostname so a WAN relay
// host yields WAN TURN candidates.
//
// Returns "" when RELAY_URL is unset or unparseable — callers then fall back
// to STUN-only exactly as before, never failing the whole session.
func derivedTurnURLFromRelayURL() string {
	relayURL := strings.TrimSpace(os.Getenv("RELAY_URL"))
	if relayURL == "" {
		return ""
	}
	u, err := url.Parse(relayURL)
	if err != nil || u.Hostname() == "" {
		return ""
	}
	port := strings.TrimSpace(os.Getenv("YAVER_TURN_PORT"))
	if port == "" {
		port = "3478"
	}
	return "turn:" + u.Hostname() + ":" + port
}

// resolveTurnURL is the single source of truth for the agent's TURN server:
// explicit YAVER_TURN_URL wins; otherwise derive from RELAY_URL (F2). Both
// /remote-runtime/turn-credentials and iceServersForPeer use this so a
// relay-backed deploy can never drift between the two ICE configs.
func resolveTurnURL() string {
	if v := strings.TrimSpace(os.Getenv("YAVER_TURN_URL")); v != "" {
		return v
	}
	return derivedTurnURLFromRelayURL()
}
