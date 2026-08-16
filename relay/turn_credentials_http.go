package main

// GET /ice is the credential broker for Yaver's colocated coturn service.
// The long-lived TURN secret never leaves this host: callers authenticate with
// their existing per-account relay credential and receive a 60-second TURN
// REST username/password. Web, mobile, tvOS and future native WebRTC stacks all
// consume the same standard RTCIceServer JSON; no platform-specific secret is
// distributed.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	pionturn "github.com/pion/turn/v4"
)

const relayTURNCredentialTTL = 60 * time.Second

type relayICECredentialResponse struct {
	IceServers []relayICEServer `json:"iceServers"`
	TTLSeconds int              `json:"ttlSeconds"`
	ExpiresAt  string           `json:"expiresAt"`
}

type relayICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

func (s *RelayServer) handleICECredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeRelayErrorCode(w, http.StatusMethodNotAllowed, "relay.ice.method_not_allowed", "use GET")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")

	pw := strings.TrimSpace(r.Header.Get("X-Relay-Password"))
	if pw == "" {
		writeRelayErrorCode(w, http.StatusUnauthorized, RelayCodePasswordMissing, "relay password required")
		return
	}
	userID, ok, err := s.validateRelayAccessE(pw, "", "", "")
	if err != nil {
		writeRelayErrorCode(w, http.StatusServiceUnavailable, RelayCodeAuthBackendUnavailable, "relay auth backend unavailable — retry")
		return
	} else if !ok {
		if !s.abuseGuard.allowInvalidAuth(s.abuseGuard.clientIP(r)) {
			writeRelayErrorCode(w, http.StatusTooManyRequests, RelayCodePasswordRateLimited, "too many invalid relay password attempts")
			return
		}
		writeRelayErrorCode(w, http.StatusUnauthorized, RelayCodePasswordInvalid, "invalid relay password")
		return
	}
	s.abuseGuard.clearInvalidAuth(s.abuseGuard.clientIP(r))

	secret := strings.TrimSpace(s.turnAuthSecret)
	if secret == "" {
		writeRelayErrorCode(w, http.StatusServiceUnavailable, "webrtc.turn_not_configured", "TURN credential service is not configured")
		return
	}
	host := relayTURNPublicHost(r)
	if host == "" {
		writeRelayErrorCode(w, http.StatusServiceUnavailable, "webrtc.turn_host_unavailable", "TURN public host is not configured")
		return
	}

	// A coturn user quota is keyed by TURN username. Use an opaque, secret-
	// keyed account bucket rather than a fresh random nonce per HTTP request;
	// otherwise one valid account can mint unlimited usernames and bypass the
	// quota. The minute expiry bucket allows rotation while keeping at most two
	// account usernames valid during the boundary overlap.
	accountBucket := relayTURNAccountBucket(secret, userID, pw)
	clientIP := s.abuseGuard.clientIP(r)
	if !s.abuseGuard.allow("turn-credential:user:"+accountBucket, s.abuseGuard.cfg.TURNCredPerUserPerMin, s.abuseGuard.cfg.TURNCredBurstPerUser) ||
		!s.abuseGuard.allow("turn-credential:ip:"+clientIP, s.abuseGuard.cfg.TURNCredPerIPPerMin, s.abuseGuard.cfg.TURNCredBurstPerIP) {
		writeRelayErrorCode(w, http.StatusTooManyRequests, "webrtc.turn_rate_limited", "TURN credential request rate exceeded")
		return
	}
	expiresAt := time.Now().UTC().Truncate(time.Minute).Add(time.Minute + relayTURNCredentialTTL)
	credentialTTL := time.Until(expiresAt)
	username, credential, err := pionturn.GenerateLongTermTURNRESTCredentials(secret, accountBucket, credentialTTL)
	if err != nil {
		writeRelayErrorCode(w, http.StatusInternalServerError, "webrtc.turn_credential_failed", "could not generate TURN credentials")
		return
	}

	turnPort := relayTURNPort("TURN_PORT", 3478)
	tlsPort := relayTURNPort("TURN_TLS_PORT", 5349)
	expires, _ := strconv.ParseInt(strings.SplitN(username, ":", 2)[0], 10, 64)
	resp := relayICECredentialResponse{
		IceServers: []relayICEServer{
			{URLs: []string{"stun:" + net.JoinHostPort(host, strconv.Itoa(turnPort))}},
			{
				URLs: []string{
					"turn:" + net.JoinHostPort(host, strconv.Itoa(turnPort)) + "?transport=udp",
					"turn:" + net.JoinHostPort(host, strconv.Itoa(turnPort)) + "?transport=tcp",
					"turns:" + net.JoinHostPort(host, strconv.Itoa(tlsPort)) + "?transport=tcp",
				},
				Username: username, Credential: credential,
			},
		},
		TTLSeconds: int(time.Until(time.Unix(expires, 0)).Seconds()),
		ExpiresAt:  time.Unix(expires, 0).UTC().Format(time.RFC3339),
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func relayTURNAccountBucket(secret, userID, password string) string {
	identity := strings.TrimSpace(userID)
	if identity == "" {
		identity = strings.TrimSpace(password)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("yaver-turn-account\x00" + identity))
	// 128 opaque bits are enough to prevent collisions without disclosing the
	// account ID or enabling an offline password dictionary attack.
	return hex.EncodeToString(mac.Sum(nil)[:16])
}

func relayTURNPublicHost(r *http.Request) string {
	if host := strings.TrimSpace(os.Getenv("TURN_PUBLIC_HOST")); host != "" {
		return strings.Trim(host, "[]")
	}
	host := strings.TrimSpace(r.Host)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if host == "" || strings.ContainsAny(host, " /\\\t\r\n") {
		return ""
	}
	return host
}

func relayTURNPort(name string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback
	}
	p, err := strconv.Atoi(v)
	if err != nil || p < 1 || p > 65535 {
		return fallback
	}
	return p
}
