package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
)

const version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(0)
	}

	cmd := os.Args[1]
	switch cmd {
	case "serve":
		runServe(os.Args[2:])
	case "tunnel":
		runTunnel(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Printf("yaver-relay %s\n", version)
	case "help", "--help", "-h":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Print(`yaver-relay — P2P relay server for Yaver

Usage:
  yaver-relay serve     Run the relay server (deploy on public VPS)
  yaver-relay tunnel    Connect local agent to relay (run on dev machine)
  yaver-relay version   Print version
  yaver-relay help      Show this help

Serve flags:
  --quic-port    QUIC port for agent tunnels (default 4433)
  --http-port    HTTP port for mobile clients (default 8443)

Tunnel flags:
  --relay        Relay server address (e.g. relay.yaver.io:4433)
  --agent        Local agent HTTP address (default 127.0.0.1:18080)
  --device-id    Device ID (from yaver config)
  --token        Auth token (from yaver config)

Architecture:
  Mobile App ──HTTPS──► Relay Server ──QUIC tunnel──► Desktop Agent
  (roaming)             (Hetzner VPS)                 (behind NAT)

  • Mobile makes short HTTP requests — IP changes don't matter
  • Agent maintains persistent QUIC tunnel — stable on ethernet
  • No TUN/TAP, no VPN — pure application-layer proxy
  • Auto-reconnect with exponential backoff on disconnect
`)
}

func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	quicPort := fs.Int("quic-port", 4433, "QUIC port for agent tunnels")
	httpPort := fs.Int("http-port", 8443, "HTTP port for mobile clients")
	fs.Parse(args)

	log.Printf("yaver-relay %s starting...", version)
	log.Printf("  QUIC tunnel port: %d", *quicPort)
	log.Printf("  HTTP proxy port:  %d", *httpPort)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		log.Printf("Received %s, shutting down...", sig)
		cancel()
	}()

	server := NewRelayServer(*quicPort, *httpPort)
	if err := server.Start(ctx); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func runTunnel(args []string) {
	fs := flag.NewFlagSet("tunnel", flag.ExitOnError)
	relayAddr := fs.String("relay", "", "Relay server address (host:port)")
	agentAddr := fs.String("agent", "127.0.0.1:18080", "Local agent HTTP address")
	deviceID := fs.String("device-id", "", "Device ID")
	token := fs.String("token", "", "Auth token")
	fs.Parse(args)

	if *relayAddr == "" {
		fmt.Fprintln(os.Stderr, "Error: --relay is required")
		fmt.Fprintln(os.Stderr, "Example: yaver-relay tunnel --relay=relay.yaver.io:4433 --device-id=abc123 --token=mytoken")
		os.Exit(1)
	}
	if *deviceID == "" || *token == "" {
		fmt.Fprintln(os.Stderr, "Error: --device-id and --token are required")
		os.Exit(1)
	}

	log.Printf("Connecting to relay %s...", *relayAddr)
	log.Printf("  Local agent: %s", *agentAddr)
	log.Printf("  Device ID:   %s", (*deviceID)[:8])

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		cancel()
	}()

	client := NewTunnelClient(*relayAddr, *agentAddr, *deviceID, *token)
	if err := client.Run(ctx); err != nil {
		log.Fatalf("tunnel error: %v", err)
	}
}
