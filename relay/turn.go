package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"fmt"
	"log"
	"net"

	"github.com/pion/turn/v3"
)

// startTURN starts a TURN server on UDP+TCP `port` for WebRTC media relay.
// This powers the "Relay Pro" low-latency Vibing lane: clients get short-lived
// TURN credentials (username = expiry unix time, password = base64(HMAC-SHA1(
// secret, username))) from the billing backend, then stream WebRTC through here.
func startTURN(port int, secret string) (*turn.Server, error) {
	udpConn, err := net.ListenPacket("udp4", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		return nil, fmt.Errorf("turn udp listen: %w", err)
	}
	tcpListener, err := net.Listen("tcp4", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		return nil, fmt.Errorf("turn tcp listen: %w", err)
	}

	relayIP, err := publicIPv4()
	if err != nil {
		relayIP = net.ParseIP("0.0.0.0")
	}
	factory := &turn.RelayAddressGeneratorStatic{
		RelayAddress: relayIP,
		Address:      "0.0.0.0",
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm: "yaver.io",
		AuthHandler: func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
			// REST credential check: key = HMAC-SHA1(secret, username).
			if secret == "" || username == "" {
				return nil, false
			}
			mac := hmac.New(sha1.New, []byte(secret))
			mac.Write([]byte(username))
			return mac.Sum(nil), true
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn:            udpConn,
			RelayAddressGenerator: factory,
		}},
		ListenerConfigs: []turn.ListenerConfig{{
			Listener:              tcpListener,
			RelayAddressGenerator: factory,
		}},
	})
	if err != nil {
		return nil, fmt.Errorf("turn server: %w", err)
	}
	log.Printf("  TURN server:        :%d (UDP+TCP, Relay Pro media relay)", port)
	return server, nil
}

// publicIPv4 returns the outbound public IPv4 used for relayed TURN addresses.
func publicIPv4() (net.IP, error) {
	conn, err := net.Dial("udp4", "8.8.8.8:80")
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP, nil
}
