package main

// turn.go — Pion TURN/STUN server colocated with the QUIC + HTTP
// listeners. The whole reason it exists: a browser viewer behind
// CG-NAT can't reach a Linux dev box behind another CG-NAT directly.
// ICE will look for a TURN candidate; this is the one the agent
// hands the viewer.
//
// Auth uses Pion's long-term-credential mechanism. Production keeps a
// dedicated TURN REST secret on the relay host and brokers one-minute
// credentials through GET /ice. The legacy colocated listener below remains
// available for explicit self-hosted deployments.
//
// This in-process implementation binds UDP only. The hardened public service
// uses coturn for UDP, TCP, TLS and DTLS plus a bounded allocation range.

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

// loadTURNAuthSecret keeps the long-lived TURN secret out of command lines and
// tracked unit files. systemd deployments use TURN_AUTH_SECRET_FILE with a
// root-readable path; environment-based self-hosted installs remain
// compatible. A missing/unreadable file is a closed failure: /ice returns a
// named 503 and the colocated TURN listener stays disabled.
func loadTURNAuthSecret() string {
	if secret := strings.TrimSpace(os.Getenv("TURN_AUTH_SECRET")); secret != "" {
		return secret
	}
	path := strings.TrimSpace(os.Getenv("TURN_AUTH_SECRET_FILE"))
	if path == "" {
		return ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		log.Printf("  TURN secret:      unavailable from credential file: %v", err)
		return ""
	}
	return strings.TrimSpace(string(b))
}

// StartTURN runs the TURN/STUN server until ctx is cancelled, then
// closes the listener cleanly. publicIP is the address the relay
// reports as its TURN candidate — clients open allocations against
// it, so it must be the box's WAN-reachable address (not 127.0.0.1).
// realm is the long-term-credential realm; "yaver-relay" is the
// default and shows up in browser devtools.
//
// authSecret is the secret used to derive each session's short-lived TURN
// password (see Pion's GenerateLongTermCredentials for the algorithm).
func StartTURN(ctx context.Context, publicIP, realm string, port int, authSecret string) error {
	if authSecret == "" {
		return fmt.Errorf("turn: authSecret cannot be empty")
	}
	if publicIP == "" {
		return fmt.Errorf("turn: publicIP cannot be empty (relay needs a WAN-reachable IP for TURN candidates)")
	}
	if port <= 0 || port > 65535 {
		return fmt.Errorf("turn: port %d out of range", port)
	}
	if realm == "" {
		realm = "yaver-relay"
	}

	udpListener, err := net.ListenPacket("udp4", "0.0.0.0:"+strconv.Itoa(port))
	if err != nil {
		return fmt.Errorf("turn: bind UDP %d: %w", port, err)
	}

	// Pion's leveled logger writes to stdout by default. We pipe its
	// output through the same writer the rest of the relay uses so a
	// single tail -f shows everything.
	logger := logging.NewDefaultLeveledLoggerForScope(
		"yaver-turn",
		logging.LogLevelInfo,
		os.Stderr,
	)

	server, err := turn.NewServer(turn.ServerConfig{
		Realm:       realm,
		AuthHandler: turn.NewLongTermAuthHandler(authSecret, logger),
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn: udpListener,
				RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
					RelayAddress: net.ParseIP(publicIP),
					Address:      "0.0.0.0",
				},
			},
		},
	})
	if err != nil {
		_ = udpListener.Close()
		return fmt.Errorf("turn: create server: %w", err)
	}
	log.Printf("  TURN server:      udp/%d (realm=%s, public-ip=%s)", port, realm, publicIP)

	<-ctx.Done()
	if err := server.Close(); err != nil {
		log.Printf("  TURN server close: %v", err)
	}
	return nil
}
