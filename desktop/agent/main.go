package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	osexec "os/exec"

	"github.com/google/uuid"
)

const version = "1.0.0"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(0)
	}

	cmd := os.Args[1]
	switch cmd {
	case "auth":
		runAuth(os.Args[2:])
	case "signout", "logout":
		runSignout()
	case "connect":
		runConnect(os.Args[2:])
	case "serve":
		runServe(os.Args[2:])
	case "status":
		runStatus()
	case "devices":
		runDevices()
	case "uninstall":
		runUninstall()
	case "help", "--help", "-h":
		printUsage()
	case "version", "--version", "-v":
		fmt.Printf("yaver %s\n", version)
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Print(`Yaver — use Claude from anywhere

Usage:
  yaver auth        Sign in to Yaver (opens browser)
  yaver signout     Sign out and clear credentials
  yaver connect     Connect to your dev machine
  yaver serve       Start the agent on this machine
  yaver status      Show auth and connection status
  yaver devices     List your registered devices
  yaver uninstall   Remove config, certs, and stop the agent
  yaver help        Show this help message
  yaver version     Print version

Run 'yaver <command> -h' for command-specific options.
`)
}

// ---------------------------------------------------------------------------
// auth — sign in via browser OAuth (like claude auth)
// ---------------------------------------------------------------------------

func runAuth(args []string) {
	fs := flag.NewFlagSet("auth", flag.ExitOnError)
	convexURL := fs.String("convex-url", "https://shocking-echidna-394.eu-west-1.convex.site", "Convex site URL")
	token := fs.String("token", "", "Provide token directly (skip browser)")
	fs.Parse(args)

	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	// Check if already logged in
	if cfg.AuthToken != "" && cfg.ConvexSiteURL != "" {
		if err := ValidateToken(cfg.ConvexSiteURL, cfg.AuthToken); err == nil {
			fmt.Println("Already signed in. Use 'yaver signout' to sign out first.")
			return
		}
		// Token expired, continue to re-auth
		fmt.Println("Session expired. Re-authenticating...")
	}

	if *token != "" {
		// Direct token
		cfg.AuthToken = *token
		cfg.ConvexSiteURL = *convexURL
		if err := ValidateToken(cfg.ConvexSiteURL, cfg.AuthToken); err != nil {
			fmt.Fprintf(os.Stderr, "Error: token validation failed: %v\n", err)
			os.Exit(1)
		}
		if cfg.DeviceID == "" {
			cfg.DeviceID = uuid.New().String()
		}
		if err := SaveConfig(cfg); err != nil {
			log.Fatalf("save config: %v", err)
		}
		fmt.Println("Signed in successfully.")
		return
	}

	// Browser-based OAuth — opens yaver.io auth page with provider choice
	fmt.Println("Opening browser to sign in...")
	fmt.Println()

	authPageURL := "https://yaver.io/auth?client=desktop"
	fmt.Printf("If your browser doesn't open, visit:\n  %s\n\n", authPageURL)

	// Start local callback server
	callbackToken := make(chan string, 1)
	srv := &http.Server{Addr: "127.0.0.1:19836"}
	srv.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t := r.URL.Query().Get("token")
		if t != "" {
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<html><body style="background:#0f1117;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column">
				<h2 style="margin-bottom:8px">Signed in!</h2>
				<p style="color:#9ca3af">You can close this tab and return to your terminal.</p>
			</body></html>`)
			callbackToken <- t
		} else {
			http.Error(w, "Missing token", 400)
		}
	})

	go srv.ListenAndServe()
	openBrowser(authPageURL)

	fmt.Println("Waiting for authentication...")

	select {
	case t := <-callbackToken:
		srv.Close()
		cfg.AuthToken = t
		cfg.ConvexSiteURL = *convexURL
		if err := ValidateToken(cfg.ConvexSiteURL, cfg.AuthToken); err != nil {
			fmt.Fprintf(os.Stderr, "Error: token validation failed: %v\n", err)
			os.Exit(1)
		}
		if cfg.DeviceID == "" {
			cfg.DeviceID = uuid.New().String()
		}
		if err := SaveConfig(cfg); err != nil {
			log.Fatalf("save config: %v", err)
		}
		fmt.Println()
		fmt.Println("Signed in successfully.")
		fmt.Println()
		fmt.Println("Next steps:")
		fmt.Println("  yaver serve     Start the agent on this machine")
		fmt.Println("  yaver connect   Connect to a remote machine")
		fmt.Println("  yaver devices   List your devices")

	case <-time.After(5 * time.Minute):
		srv.Close()
		fmt.Fprintln(os.Stderr, "Authentication timed out.")
		os.Exit(1)
	}
}

// ---------------------------------------------------------------------------
// signout — clear credentials
// ---------------------------------------------------------------------------

func runSignout() {
	cfg, err := LoadConfig()
	if err != nil || cfg.AuthToken == "" {
		fmt.Println("Not signed in.")
		return
	}

	cfg.AuthToken = ""
	if err := SaveConfig(cfg); err != nil {
		log.Fatalf("save config: %v", err)
	}
	fmt.Println("Signed out.")
}

// ---------------------------------------------------------------------------
// connect — connect to a remote agent interactively
// ---------------------------------------------------------------------------

func runConnect(args []string) {
	fs := flag.NewFlagSet("connect", flag.ExitOnError)
	host := fs.String("host", "", "Agent host (auto-discovers if not set)")
	port := fs.Int("port", 4433, "Agent QUIC port")
	deviceID := fs.String("device", "", "Device ID to connect to")
	fs.Parse(args)

	cfg := mustLoadAuthConfig()

	// Auto-discover device if host not specified
	if *host == "" {
		devices, err := listDevices(cfg.ConvexSiteURL, cfg.AuthToken)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error listing devices: %v\n", err)
			os.Exit(1)
		}

		if len(devices) == 0 {
			fmt.Fprintln(os.Stderr, "No devices found. Make sure your agent is running on your dev machine.")
			os.Exit(1)
		}

		var target *DeviceInfo
		for i := range devices {
			if *deviceID != "" && devices[i].DeviceID == *deviceID {
				target = &devices[i]
				break
			}
			if *deviceID == "" && devices[i].IsOnline {
				target = &devices[i]
				break
			}
		}

		if target == nil {
			fmt.Fprintln(os.Stderr, "No matching online device. Your devices:")
			for _, d := range devices {
				status := "offline"
				if d.IsOnline {
					status = "online"
				}
				fmt.Fprintf(os.Stderr, "  %s  %-20s  %-8s  %s:%d\n", d.DeviceID[:8], d.Name, status, d.QuicHost, d.QuicPort)
			}
			os.Exit(1)
		}

		*host = target.QuicHost
		*port = target.QuicPort
		fmt.Printf("Connecting to %s (%s)...\n", target.Name, target.DeviceID[:8])
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Println()
		cancel()
	}()

	if err := RunClient(ctx, *host, *port, cfg.AuthToken); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

// ---------------------------------------------------------------------------
// serve — run the QUIC agent server
// ---------------------------------------------------------------------------

func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	port := fs.Int("port", 4433, "QUIC server port")
	workDir := fs.String("work-dir", ".", "Working directory for tasks")
	fs.Parse(args)

	if *workDir == "." {
		wd, err := os.Getwd()
		if err != nil {
			log.Fatalf("get working directory: %v", err)
		}
		*workDir = wd
	}

	cfg := mustLoadAuthConfig()

	log.Println("Yaver agent starting...")
	log.Printf("  Work dir: %s", *workDir)
	log.Printf("  QUIC port: %d", *port)

	// Ensure stable device ID
	if cfg.DeviceID == "" {
		cfg.DeviceID = uuid.New().String()
		log.Printf("Generated device ID: %s", cfg.DeviceID)
	}
	if err := SaveConfig(cfg); err != nil {
		log.Fatalf("save config: %v", err)
	}

	// Validate token
	log.Println("Validating token...")
	if err := ValidateToken(cfg.ConvexSiteURL, cfg.AuthToken); err != nil {
		log.Fatalf("Token expired or invalid. Run 'yaver auth' to re-authenticate.\n  Error: %v", err)
	}
	log.Println("Token validated.")

	// Register device
	hostname, _ := os.Hostname()
	log.Printf("Registering device %s (%s)...", hostname, cfg.DeviceID)
	if err := RegisterDevice(cfg.ConvexSiteURL, RegisterDeviceRequest{
		Token:    cfg.AuthToken,
		DeviceID: cfg.DeviceID,
		Name:     hostname,
		Platform: runtime.GOOS,
		QuicHost: "0.0.0.0",
		QuicPort: *port,
	}); err != nil {
		log.Fatalf("device registration failed: %v", err)
	}
	log.Println("Device registered.")

	// Task store and manager
	taskStore, err := NewTaskStore()
	if err != nil {
		log.Fatalf("failed to create task store: %v", err)
	}
	taskMgr := NewTaskManager(*workDir, taskStore)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go heartbeatLoop(ctx, cfg.ConvexSiteURL, cfg.AuthToken, cfg.DeviceID)

	quicServer := NewQUICServer(*port, cfg.AuthToken, hostname, taskMgr)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigCh
		log.Printf("Received signal %s, shutting down...", sig)
		if err := MarkOffline(cfg.ConvexSiteURL, cfg.AuthToken, cfg.DeviceID); err != nil {
			log.Printf("failed to mark offline: %v", err)
		}
		cancel()
	}()

	if err := quicServer.Start(ctx); err != nil {
		log.Fatalf("QUIC server error: %v", err)
	}

	log.Println("Agent stopped.")
}

// ---------------------------------------------------------------------------
// status — show auth and agent status
// ---------------------------------------------------------------------------

func runStatus() {
	cfg, err := LoadConfig()
	if err != nil || cfg.AuthToken == "" {
		fmt.Println("Status: not signed in")
		fmt.Println()
		fmt.Println("Run 'yaver auth' to sign in.")
		return
	}

	// Check token
	authStatus := "valid"
	if err := ValidateToken(cfg.ConvexSiteURL, cfg.AuthToken); err != nil {
		authStatus = "expired"
	}

	fmt.Printf("Auth:     %s\n", authStatus)
	if cfg.DeviceID != "" {
		fmt.Printf("Device:   %s\n", cfg.DeviceID[:8]+"...")
	}
	fmt.Printf("Backend:  %s\n", cfg.ConvexSiteURL)

	if authStatus == "expired" {
		fmt.Println()
		fmt.Println("Session expired. Run 'yaver auth' to re-authenticate.")
	}
}

// ---------------------------------------------------------------------------
// devices — list registered devices
// ---------------------------------------------------------------------------

func runDevices() {
	cfg := mustLoadAuthConfig()

	devices, err := listDevices(cfg.ConvexSiteURL, cfg.AuthToken)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if len(devices) == 0 {
		fmt.Println("No devices registered.")
		fmt.Println("Run 'yaver serve' on your dev machine to register it.")
		return
	}

	fmt.Printf("%-10s  %-20s  %-8s  %-8s  %s\n", "ID", "NAME", "PLATFORM", "STATUS", "ADDRESS")
	for _, d := range devices {
		status := "offline"
		if d.IsOnline {
			status = "online"
		}
		id := d.DeviceID
		if len(id) > 8 {
			id = id[:8] + "..."
		}
		fmt.Printf("%-10s  %-20s  %-8s  %-8s  %s:%d\n",
			id, d.Name, d.Platform, status, d.QuicHost, d.QuicPort)
	}
}

// ---------------------------------------------------------------------------
// uninstall — remove config, certs, stop agent service
// ---------------------------------------------------------------------------

func runUninstall() {
	fmt.Println("Uninstalling Yaver...")

	// Try to mark device offline and sign out
	cfg, err := LoadConfig()
	if err == nil && cfg.AuthToken != "" && cfg.ConvexSiteURL != "" {
		if cfg.DeviceID != "" {
			if err := MarkOffline(cfg.ConvexSiteURL, cfg.AuthToken, cfg.DeviceID); err != nil {
				fmt.Printf("  Warning: could not mark device offline: %v\n", err)
			} else {
				fmt.Println("  Marked device offline.")
			}
		}
	}

	// Stop system services
	fmt.Println("  Stopping agent service...")
	switch runtime.GOOS {
	case "darwin":
		plistPath := filepath.Join(os.Getenv("HOME"), "Library", "LaunchAgents", "io.yaver.agent.plist")
		osexec.Command("launchctl", "unload", plistPath).Run()
		os.Remove(plistPath)
		fmt.Println("  Removed launchd service.")
	case "linux":
		osexec.Command("systemctl", "--user", "stop", "yaver-agent").Run()
		osexec.Command("systemctl", "--user", "disable", "yaver-agent").Run()
		unitPath := filepath.Join(os.Getenv("HOME"), ".config", "systemd", "user", "yaver-agent.service")
		os.Remove(unitPath)
		osexec.Command("systemctl", "--user", "daemon-reload").Run()
		fmt.Println("  Removed systemd service.")
	}

	// Remove config directory (~/.yaver)
	configDir, err := ConfigDir()
	if err == nil {
		if err := os.RemoveAll(configDir); err != nil {
			fmt.Fprintf(os.Stderr, "  Warning: could not remove %s: %v\n", configDir, err)
		} else {
			fmt.Printf("  Removed %s\n", configDir)
		}
	}

	fmt.Println()
	fmt.Println("Yaver has been uninstalled.")
	fmt.Println()
	fmt.Println("To remove the binary:")
	fmt.Println("  brew uninstall yaver          # if installed via Homebrew")
	fmt.Printf("  rm %s   # if installed manually\n", os.Args[0])
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func mustLoadAuthConfig() *Config {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Not signed in. Run 'yaver auth' first.")
		os.Exit(1)
	}
	if cfg.AuthToken == "" {
		fmt.Fprintln(os.Stderr, "Not signed in. Run 'yaver auth' first.")
		os.Exit(1)
	}
	if cfg.ConvexSiteURL == "" {
		fmt.Fprintln(os.Stderr, "No backend configured. Run 'yaver auth' first.")
		os.Exit(1)
	}
	return cfg
}

type DeviceInfo struct {
	DeviceID string `json:"deviceId"`
	Name     string `json:"name"`
	Platform string `json:"platform"`
	QuicHost string `json:"quicHost"`
	QuicPort int    `json:"quicPort"`
	IsOnline bool   `json:"isOnline"`
}

func listDevices(baseURL, token string) ([]DeviceInfo, error) {
	req, err := newBearerRequest("GET", baseURL+"/devices/list", token, nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("list devices failed (status %d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		Devices []DeviceInfo `json:"devices"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parse devices: %w", err)
	}
	return result.Devices, nil
}

func openBrowser(url string) {
	switch runtime.GOOS {
	case "darwin":
		execOpen("open", url)
	case "linux":
		execOpen("xdg-open", url)
	case "windows":
		execOpen("cmd", "/c", "start", url)
	}
}

func execOpen(name string, args ...string) {
	cmd := osexec.Command(name, args...)
	cmd.Start()
}

func heartbeatLoop(ctx context.Context, baseURL, token, deviceID string) {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := SendHeartbeat(baseURL, token, deviceID); err != nil {
				log.Printf("heartbeat failed: %v", err)
			} else {
				log.Println("Heartbeat sent.")
			}
		}
	}
}
