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

const version = "1.2.0"

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
	case "logs":
		runLogs(os.Args[2:])
	case "stop":
		runStop()
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
  yaver serve       Start the agent (runs in background)
  yaver stop        Stop the running agent
  yaver logs        Show agent logs
  yaver status      Show auth and connection status
  yaver devices     List your registered devices
  yaver uninstall   Remove config, certs, and stop the agent
  yaver help        Show this help message
  yaver version     Print version

Flags for serve:
  --debug           Run in foreground with verbose logging
  --port            HTTP server port (default 8080)
  --quic-port       QUIC server port (default 4433)
  --work-dir        Working directory for tasks (default .)

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

// pidFilePath returns the path to the PID file.
func pidFilePath() string {
	dir, err := ConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "agent.pid")
}

// logFilePath returns the path to the log file.
func logFilePath() string {
	dir, err := ConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "agent.log")
}

// isAgentRunning checks if the agent process is alive.
func isAgentRunning() (int, bool) {
	pidFile := pidFilePath()
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return 0, false
	}
	var pid int
	if _, err := fmt.Sscanf(string(data), "%d", &pid); err != nil {
		return 0, false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return 0, false
	}
	// Signal 0 checks if process exists
	if err := proc.Signal(syscall.Signal(0)); err != nil {
		os.Remove(pidFile)
		return 0, false
	}
	return pid, true
}

func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	httpPort := fs.Int("port", 8080, "HTTP server port")
	quicPort := fs.Int("quic-port", 4433, "QUIC server port (legacy)")
	workDir := fs.String("work-dir", ".", "Working directory for tasks")
	noQUIC := fs.Bool("no-quic", false, "Disable QUIC server (HTTP only)")
	debug := fs.Bool("debug", false, "Run in foreground with verbose logging")
	fs.Parse(args)

	if *workDir == "." {
		wd, err := os.Getwd()
		if err != nil {
			log.Fatalf("get working directory: %v", err)
		}
		*workDir = wd
	}

	// Check if already running
	if pid, running := isAgentRunning(); running {
		fmt.Printf("Yaver agent is already running (PID %d).\n", pid)
		fmt.Println("Use 'yaver stop' to stop it, or 'yaver logs' to view logs.")
		return
	}

	cfg := mustLoadAuthConfig()

	// Validate token before forking
	if err := ValidateToken(cfg.ConvexSiteURL, cfg.AuthToken); err != nil {
		fmt.Fprintf(os.Stderr, "Token expired or invalid. Run 'yaver auth' to re-authenticate.\n")
		os.Exit(1)
	}

	// If not debug mode, fork into background
	if !*debug {
		// Re-exec ourselves with an internal flag
		execPath, err := os.Executable()
		if err != nil {
			log.Fatalf("cannot find executable: %v", err)
		}

		logFile := logFilePath()
		lf, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			log.Fatalf("cannot open log file: %v", err)
		}

		// Build args for the child process
		childArgs := []string{"serve", "--debug"}
		childArgs = append(childArgs, fmt.Sprintf("--port=%d", *httpPort))
		childArgs = append(childArgs, fmt.Sprintf("--quic-port=%d", *quicPort))
		childArgs = append(childArgs, fmt.Sprintf("--work-dir=%s", *workDir))
		if *noQUIC {
			childArgs = append(childArgs, "--no-quic")
		}

		cmd := osexec.Command(execPath, childArgs...)
		cmd.Stdout = lf
		cmd.Stderr = lf
		cmd.Dir = *workDir
		// Detach from parent
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

		if err := cmd.Start(); err != nil {
			log.Fatalf("failed to start agent: %v", err)
		}

		// Write PID file
		if err := os.WriteFile(pidFilePath(), []byte(fmt.Sprintf("%d", cmd.Process.Pid)), 0644); err != nil {
			log.Printf("warning: could not write PID file: %v", err)
		}

		lf.Close()

		fmt.Printf("Yaver agent started (PID %d).\n", cmd.Process.Pid)
		fmt.Println()
		fmt.Println("  yaver logs      View agent logs")
		fmt.Println("  yaver stop      Stop the agent")
		fmt.Println("  yaver status    Check agent status")
		return
	}

	// Debug mode: run in foreground with full logging
	log.Println("Yaver agent starting...")
	log.Printf("  Work dir: %s", *workDir)
	log.Printf("  HTTP port: %d", *httpPort)
	if !*noQUIC {
		log.Printf("  QUIC port: %d", *quicPort)
	}

	// Ensure stable device ID
	if cfg.DeviceID == "" {
		cfg.DeviceID = uuid.New().String()
		log.Printf("Generated device ID: %s", cfg.DeviceID)
	}
	if err := SaveConfig(cfg); err != nil {
		log.Fatalf("save config: %v", err)
	}

	log.Println("Token validated.")

	// Register device
	hostname, _ := os.Hostname()
	platform := runtime.GOOS
	if platform == "darwin" {
		platform = "macos"
	}
	log.Printf("Registering device %s (%s)...", hostname, cfg.DeviceID)
	if err := RegisterDevice(cfg.ConvexSiteURL, RegisterDeviceRequest{
		Token:    cfg.AuthToken,
		DeviceID: cfg.DeviceID,
		Name:     hostname,
		Platform: platform,
		QuicHost: "0.0.0.0",
		QuicPort: *quicPort,
	}); err != nil {
		log.Fatalf("device registration failed: %v", err)
	}
	log.Println("Device registered.")

	// Write PID file (for debug mode too, so stop/status work)
	if err := os.WriteFile(pidFilePath(), []byte(fmt.Sprintf("%d", os.Getpid())), 0644); err != nil {
		log.Printf("warning: could not write PID file: %v", err)
	}

	// Task store and manager
	taskStore, err := NewTaskStore()
	if err != nil {
		log.Fatalf("failed to create task store: %v", err)
	}
	taskMgr := NewTaskManager(*workDir, taskStore)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go heartbeatLoop(ctx, cfg.ConvexSiteURL, cfg.AuthToken, cfg.DeviceID)

	// Start HTTP server (V1 — primary, also serves MCP)
	httpServer := NewHTTPServer(*httpPort, cfg.AuthToken, hostname, taskMgr)
	go func() {
		if err := httpServer.Start(ctx); err != nil {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	// Start QUIC server (legacy, can be disabled)
	if !*noQUIC {
		quicServer := NewQUICServer(*quicPort, cfg.AuthToken, hostname, taskMgr)
		go func() {
			if err := quicServer.Start(ctx); err != nil {
				log.Printf("QUIC server error: %v", err)
			}
		}()
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	sig := <-sigCh
	log.Printf("Received signal %s, shutting down...", sig)
	if err := MarkOffline(cfg.ConvexSiteURL, cfg.AuthToken, cfg.DeviceID); err != nil {
		log.Printf("failed to mark offline: %v", err)
	}
	cancel()
	os.Remove(pidFilePath())

	time.Sleep(1 * time.Second)
	log.Println("Agent stopped.")
}

// ---------------------------------------------------------------------------
// logs — show agent log output
// ---------------------------------------------------------------------------

func runLogs(args []string) {
	fs := flag.NewFlagSet("logs", flag.ExitOnError)
	follow := fs.Bool("f", false, "Follow log output (like tail -f)")
	lines := fs.Int("n", 50, "Number of lines to show")
	fs.Parse(args)

	logFile := logFilePath()
	if _, err := os.Stat(logFile); os.IsNotExist(err) {
		fmt.Println("No logs found. Start the agent with 'yaver serve'.")
		return
	}

	if *follow {
		// Use tail -f for following
		cmd := osexec.Command("tail", "-f", "-n", fmt.Sprintf("%d", *lines), logFile)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr

		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		go func() {
			<-sigCh
			if cmd.Process != nil {
				cmd.Process.Kill()
			}
		}()

		cmd.Run()
	} else {
		cmd := osexec.Command("tail", "-n", fmt.Sprintf("%d", *lines), logFile)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Run()
	}
}

// ---------------------------------------------------------------------------
// stop — stop the running agent
// ---------------------------------------------------------------------------

func runStop() {
	pid, running := isAgentRunning()
	if !running {
		fmt.Println("Yaver agent is not running.")
		return
	}

	proc, err := os.FindProcess(pid)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error finding process %d: %v\n", pid, err)
		os.Exit(1)
	}

	if err := proc.Signal(syscall.SIGTERM); err != nil {
		fmt.Fprintf(os.Stderr, "Error stopping agent: %v\n", err)
		os.Exit(1)
	}

	// Wait for process to exit
	for i := 0; i < 30; i++ {
		time.Sleep(100 * time.Millisecond)
		if err := proc.Signal(syscall.Signal(0)); err != nil {
			break
		}
	}

	os.Remove(pidFilePath())
	fmt.Printf("Yaver agent stopped (was PID %d).\n", pid)
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

	// Check agent
	agentStatus := "stopped"
	if pid, running := isAgentRunning(); running {
		agentStatus = fmt.Sprintf("running (PID %d)", pid)
	}

	fmt.Printf("Auth:     %s\n", authStatus)
	fmt.Printf("Agent:    %s\n", agentStatus)
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
