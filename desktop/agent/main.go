package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/google/uuid"
)

func main() {
	token := flag.String("token", "", "Authentication token for Convex")
	port := flag.Int("port", 4433, "QUIC server port")
	workDir := flag.String("work-dir", ".", "Working directory for tasks")
	flag.Parse()

	if *token == "" {
		fmt.Fprintln(os.Stderr, "error: --token is required")
		flag.Usage()
		os.Exit(1)
	}

	// Resolve working directory.
	if *workDir == "." {
		wd, err := os.Getwd()
		if err != nil {
			log.Fatalf("get working directory: %v", err)
		}
		*workDir = wd
	}

	log.Println("Yaver Desktop Agent starting...")
	log.Printf("  Work dir: %s", *workDir)
	log.Printf("  QUIC port: %d", *port)

	// Load or create config.
	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	// Persist token.
	cfg.AuthToken = *token

	// Ensure a stable device ID.
	if cfg.DeviceID == "" {
		cfg.DeviceID = uuid.New().String()
		log.Printf("Generated device ID: %s", cfg.DeviceID)
	}
	if err := SaveConfig(cfg); err != nil {
		log.Fatalf("save config: %v", err)
	}

	// Validate token with Convex.
	log.Println("Validating token...")
	if err := ValidateToken(*token); err != nil {
		log.Fatalf("token validation failed: %v", err)
	}
	log.Println("Token validated.")

	// Register device.
	hostname, _ := os.Hostname()
	log.Printf("Registering device %s (%s)...", hostname, cfg.DeviceID)
	if err := RegisterDevice(RegisterDeviceRequest{
		Token:    *token,
		DeviceID: cfg.DeviceID,
		Name:     hostname,
		Platform: runtime.GOOS,
		Host:     "0.0.0.0",
		Port:     *port,
	}); err != nil {
		log.Fatalf("device registration failed: %v", err)
	}
	log.Println("Device registered.")

	// Create task manager.
	taskMgr := NewTaskManager(*workDir)

	// Create cancellable context for graceful shutdown.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start heartbeat goroutine.
	go heartbeatLoop(ctx, *token, cfg.DeviceID)

	// Start QUIC server.
	quicServer := NewQUICServer(*port, *token, hostname, taskMgr)

	// Listen for shutdown signals.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigCh
		log.Printf("Received signal %s, shutting down...", sig)

		// Mark device offline.
		if err := MarkOffline(*token, cfg.DeviceID); err != nil {
			log.Printf("failed to mark offline: %v", err)
		}
		cancel()
	}()

	// This blocks until the context is cancelled.
	if err := quicServer.Start(ctx); err != nil {
		log.Fatalf("QUIC server error: %v", err)
	}

	log.Println("Agent stopped.")
}

// heartbeatLoop sends heartbeats to Convex every 2 minutes.
func heartbeatLoop(ctx context.Context, token, deviceID string) {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := SendHeartbeat(token, deviceID); err != nil {
				log.Printf("heartbeat failed: %v", err)
			} else {
				log.Println("Heartbeat sent.")
			}
		}
	}
}
