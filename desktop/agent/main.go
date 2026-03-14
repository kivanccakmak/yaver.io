package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	osexec "os/exec"

	"github.com/google/uuid"
	"github.com/quic-go/quic-go"
)

const version = "1.8.0"

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
	case "clear-logs":
		runClearLogs()
	case "restart":
		runRestart(os.Args[2:])
	case "status":
		runStatus()
	case "devices":
		runDevices()
	case "config":
		runConfig()
	case "set-runner":
		runSetRunner(os.Args[2:])
	case "discover":
		discoverProjects()
		fp, _ := projectsFilePath()
		fmt.Printf("Project discovery complete: %s\n", fp)
	case "purge":
		runPurge()
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
	fmt.Print(`Yaver — your AI coding agent, on your phone

Usage:
  yaver auth        Sign in and start agent (opens browser)
  yaver signout     Sign out and clear credentials
  yaver connect     Connect to your dev machine
  yaver stop        Stop the running agent
  yaver restart     Restart the agent
  yaver serve       Start the agent manually (advanced)
  yaver logs        Show agent logs
  yaver clear-logs  Clear agent log file
  yaver config      Show current configuration
  yaver set-runner  Set which AI agent to use (claude, codex, aider, custom)
  yaver status      Show auth and connection status
  yaver devices     List your registered devices
  yaver purge       Remove all local data (auth, sessions, tasks, logs)
  yaver uninstall   Remove config, certs, and stop the agent
  yaver help        Show this help message
  yaver version     Print version

Flags for serve:
  --debug           Run in foreground with verbose logging
  --port            HTTP server port (default 18080)
  --quic-port       QUIC server port (default 4433)
  --no-relay        Disable relay tunnels (direct connections only)
  --work-dir        Working directory for tasks (default .)

Examples:
  yaver set-runner claude           Use Claude Code (default)
  yaver set-runner codex            Use OpenAI Codex
  yaver set-runner aider            Use Aider
  yaver set-runner custom "my-ai --auto {prompt}"   Use a custom command
  yaver set-runner                  List available runners

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
			fmt.Println("Already signed in. Starting agent...")
			fmt.Println()
			runServe([]string{})
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
		fmt.Println("Signed in successfully. Starting agent...")
		fmt.Println()
		runServe([]string{})
		return
	}

	// Browser-based OAuth — opens yaver.io auth page with provider choice
	fmt.Println("Opening browser to sign in...")
	fmt.Println()

	authPageURL := "https://yaver.io/auth?client=desktop"
	fmt.Printf("If your browser doesn't open, visit:\n  %s\n\n", authPageURL)

	// Start local callback server — try multiple addresses for compatibility
	callbackToken := make(chan string, 1)

	callbackHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Printf("  Callback received: %s %s\n", r.Method, r.URL.String())
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

	// Listen on both 127.0.0.1 and localhost for maximum compatibility
	srv1 := &http.Server{Addr: "127.0.0.1:19836", Handler: callbackHandler}
	srv2 := &http.Server{Addr: "localhost:19836", Handler: callbackHandler}

	listenErr := make(chan error, 1)
	go func() { listenErr <- srv1.ListenAndServe() }()

	// Give first server a moment to start.
	time.Sleep(100 * time.Millisecond)
	select {
	case err := <-listenErr:
		fmt.Fprintf(os.Stderr, "Error: could not start callback server on 127.0.0.1:19836: %v\n", err)
		fmt.Fprintln(os.Stderr, "Is another 'yaver auth' running?")
		os.Exit(1)
	default:
	}

	// Also try localhost (ignore errors — 127.0.0.1 may already cover it)
	go func() { srv2.ListenAndServe() }()

	openBrowser(authPageURL)

	fmt.Println("Waiting for authentication...")

	select {
	case t := <-callbackToken:
		srv1.Close()
		srv2.Close()
		fmt.Printf("  Token received (%d chars)\n", len(t))
		cfg.AuthToken = t
		cfg.ConvexSiteURL = *convexURL
		// Retry validation — session may not be committed in Convex yet.
		var validationErr error
		for attempt := 0; attempt < 8; attempt++ {
			if attempt > 0 {
				delay := time.Duration(attempt) * time.Second
				fmt.Printf("  Retrying validation (attempt %d/8, wait %s)...\n", attempt+1, delay)
				time.Sleep(delay)
			}
			validationErr = ValidateToken(cfg.ConvexSiteURL, cfg.AuthToken)
			if validationErr == nil {
				break
			}
			fmt.Printf("  Validation attempt %d failed: %v\n", attempt+1, validationErr)
		}
		if validationErr != nil {
			fmt.Fprintf(os.Stderr, "Error: token validation failed after retries: %v\n", validationErr)
			fmt.Fprintln(os.Stderr, "The token was received but could not be validated against Convex.")
			fmt.Fprintln(os.Stderr, "Try again with: yaver auth")
			os.Exit(1)
		}
		if cfg.DeviceID == "" {
			cfg.DeviceID = uuid.New().String()
		}
		if err := SaveConfig(cfg); err != nil {
			log.Fatalf("save config: %v", err)
		}
		fmt.Println()
		fmt.Println("Signed in successfully. Starting agent...")
		fmt.Println()
		runServe([]string{})

	case <-time.After(5 * time.Minute):
		srv1.Close()
		srv2.Close()
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
// purge — wipe all local data (auth, sessions, tasks, projects, certs, logs)
// ---------------------------------------------------------------------------

func runPurge() {
	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatalf("cannot find home dir: %v", err)
	}
	yaverDir := filepath.Join(home, ".yaver")

	// Check if directory exists
	if _, err := os.Stat(yaverDir); os.IsNotExist(err) {
		fmt.Println("Nothing to purge — ~/.yaver does not exist.")
		return
	}

	// List what will be removed
	fmt.Println("This will remove ALL local Yaver data:")
	fmt.Println()
	entries, _ := os.ReadDir(yaverDir)
	for _, e := range entries {
		info, _ := e.Info()
		if info != nil && info.IsDir() {
			fmt.Printf("  %s/\n", e.Name())
		} else {
			fmt.Printf("  %s\n", e.Name())
		}
	}
	fmt.Println()
	fmt.Print("Are you sure? (y/N): ")

	var confirm string
	fmt.Scanln(&confirm)
	if confirm != "y" && confirm != "Y" {
		fmt.Println("Aborted.")
		return
	}

	if err := os.RemoveAll(yaverDir); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Purged. All local data removed from ~/.yaver/")
	fmt.Println("Run 'yaver auth' to sign in again.")
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
	if !isProcessAlive(pid) {
		os.Remove(pidFile)
		return 0, false
	}
	return pid, true
}

func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	httpPort := fs.Int("port", 18080, "HTTP server port")
	quicPort := fs.Int("quic-port", 4433, "QUIC server port (legacy)")
	workDir := fs.String("work-dir", ".", "Working directory for tasks")
	noQUIC := fs.Bool("no-quic", false, "Disable QUIC server (HTTP only)")
	noRelay := fs.Bool("no-relay", false, "Disable relay tunnel (direct only)")
	debug := fs.Bool("debug", false, "Run in foreground with verbose logging")
	fs.Parse(args)

	if *workDir == "." {
		wd, err := os.Getwd()
		if err != nil {
			log.Fatalf("get working directory: %v", err)
		}
		*workDir = wd
	}

	// Check if already running (skip in debug mode — the forked child runs with --debug)
	if !*debug {
		if pid, running := isAgentRunning(); running {
			fmt.Printf("Yaver agent is already running (PID %d).\n", pid)
			fmt.Println("Use 'yaver stop' to stop it, or 'yaver logs' to view logs.")
			return
		}
	}

	cfg := mustLoadAuthConfig()

	// Validate token before forking
	if _, err := ValidateTokenUser(cfg.ConvexSiteURL, cfg.AuthToken); err != nil {
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
		if *noRelay {
			childArgs = append(childArgs, "--no-relay")
		}

		cmd := osexec.Command(execPath, childArgs...)
		cmd.Stdout = lf
		cmd.Stderr = lf
		cmd.Dir = *workDir
		// Detach from parent (platform-specific)
		detachProcess(cmd)

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

	// Get owner userId for multi-token auth
	ownerUserID, err := ValidateTokenUser(cfg.ConvexSiteURL, cfg.AuthToken)
	if err != nil {
		log.Fatalf("failed to get owner userId: %v", err)
	}
	log.Printf("Token validated. Owner: %s", ownerUserID)

	// Register device
	hostname, _ := os.Hostname()
	platform := runtime.GOOS
	if platform == "darwin" {
		platform = "macos"
	}
	localIP := getLocalIP()

	log.Printf("Registering device %s (%s) at %s:%d...", hostname, cfg.DeviceID, localIP, *httpPort)
	if err := RegisterDevice(cfg.ConvexSiteURL, RegisterDeviceRequest{
		Token:    cfg.AuthToken,
		DeviceID: cfg.DeviceID,
		Name:     hostname,
		Platform: platform,
		QuicHost: localIP,
		QuicPort: *httpPort,
	}); err != nil {
		log.Fatalf("device registration failed: %v", err)
	}
	log.Println("Device registered.")

	// Fetch relay servers from platform config
	var relayServers []RelayServerInfo
	if !*noRelay {
		var err error
		relayServers, err = FetchRelayServers(cfg.ConvexSiteURL)
		if err != nil {
			log.Printf("Warning: could not fetch relay servers: %v", err)
		} else if len(relayServers) > 0 {
			log.Printf("Found %d relay server(s):", len(relayServers))
			for _, rs := range relayServers {
				log.Printf("  [%s] %s (%s)", rs.ID, rs.QuicAddr, rs.Region)
			}
		} else {
			log.Println("No relay servers configured.")
		}
	}

	// Write PID file (for debug mode too, so stop/status work)
	if err := os.WriteFile(pidFilePath(), []byte(fmt.Sprintf("%d", os.Getpid())), 0644); err != nil {
		log.Printf("warning: could not write PID file: %v", err)
	}

	// Resolve runner config (fetch user settings, fall back to auto-detect)
	runner := resolveRunner(cfg.ConvexSiteURL, cfg.AuthToken)

	// If no runner was explicitly set by user, auto-detect available agents
	if runner.AutoDetected {
		// Check if the resolved runner's binary actually exists
		if _, err := osexec.LookPath(runner.Command); err != nil {
			// Claude not found — try codex, then aider
			if codexPath, err := osexec.LookPath("codex"); err == nil {
				log.Printf("Runner: claude not found, detected codex at %s", codexPath)
				if r, err := fetchRunner(&http.Client{Timeout: 5 * time.Second}, cfg.ConvexSiteURL, "codex"); err == nil {
					runner = r
				}
			} else if aiderPath, err := osexec.LookPath("aider"); err == nil {
				log.Printf("Runner: claude not found, detected aider at %s", aiderPath)
				if r, err := fetchRunner(&http.Client{Timeout: 5 * time.Second}, cfg.ConvexSiteURL, "aider"); err == nil {
					runner = r
				}
			} else {
				log.Printf("WARNING: No AI agent found (claude, codex, aider). Install one to run tasks.")
				log.Printf("  Claude Code: https://docs.anthropic.com/en/docs/claude-code")
				log.Printf("  OpenAI Codex: https://github.com/openai/codex")
				log.Printf("  Aider: https://aider.chat")
				log.Printf("  Or set a custom command: yaver set-runner custom \"your-command {prompt}\"")
				log.Printf("Agent will start but tasks will fail until an AI agent is available.")
			}
		}
	}
	log.Printf("Runner: %s (command=%s, mode=%s)", runner.Name, runner.Command, runner.OutputMode)

	// Discover local projects in background (scans home dir for git repos, system info, tools)
	log.Printf("Scanning for local projects (stored in ~/.yaver/PROJECTS.md, never uploaded)...")
	go ensureProjectDiscovery()

	// Clean old session files (>7 days)
	go cleanOldSessions()

	// Task store and manager
	taskStore, err := NewTaskStore()
	if err != nil {
		log.Fatalf("failed to create task store: %v", err)
	}
	taskMgr := NewTaskManager(*workDir, taskStore, runner)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go heartbeatLoop(ctx, cfg.ConvexSiteURL, cfg.AuthToken, cfg.DeviceID)

	// Start HTTP server (V1 — primary, also serves MCP)
	httpServer := NewHTTPServer(*httpPort, cfg.AuthToken, ownerUserID, cfg.ConvexSiteURL, hostname, taskMgr)
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

	// Start relay tunnels (connect to all relay servers for redundancy)
	for _, rs := range relayServers {
		rs := rs // capture loop variable
		log.Printf("Starting relay tunnel to %s (%s)...", rs.QuicAddr, rs.ID)
		go runRelayTunnel(ctx, rs.QuicAddr, fmt.Sprintf("127.0.0.1:%d", *httpPort), cfg.DeviceID, cfg.AuthToken)
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

	if err := terminateProcess(proc); err != nil {
		fmt.Fprintf(os.Stderr, "Error stopping agent: %v\n", err)
		os.Exit(1)
	}

	// Wait for process to exit
	for i := 0; i < 30; i++ {
		time.Sleep(100 * time.Millisecond)
		if !isProcessAlive(pid) {
			break
		}
	}

	os.Remove(pidFilePath())
	fmt.Printf("Yaver agent stopped (was PID %d).\n", pid)
}

// ---------------------------------------------------------------------------
// config — dump current CLI configuration
// ---------------------------------------------------------------------------

func runConfig() {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	cfgPath, _ := ConfigPath()
	fmt.Printf("Config file: %s\n\n", cfgPath)

	token := cfg.AuthToken
	if len(token) > 8 {
		token = token[:4] + "..." + token[len(token)-4:]
	} else if token != "" {
		token = "***"
	} else {
		token = "(not set)"
	}

	// Show user info if token is valid
	if cfg.AuthToken != "" && cfg.ConvexSiteURL != "" {
		if info, err := ValidateTokenInfo(cfg.ConvexSiteURL, cfg.AuthToken); err == nil {
			fmt.Printf("user:            %s (%s)\n", info.Email, info.Provider)
			if info.FullName != "" && info.FullName != info.Email {
				fmt.Printf("name:            %s\n", info.FullName)
			}
		}
	}

	// Show current runner
	if cfg.AuthToken != "" && cfg.ConvexSiteURL != "" {
		client := &http.Client{Timeout: 5 * time.Second}
		runnerID := getCurrentRunner(client, cfg.ConvexSiteURL, cfg.AuthToken)
		if runnerID == "" {
			runnerID = "claude"
		}
		fmt.Printf("runner:          %s\n", runnerID)
	}

	fmt.Printf("auth_token:      %s\n", token)
	fmt.Printf("device_id:       %s\n", valueOrEmpty(cfg.DeviceID))
	fmt.Printf("convex_site_url: %s\n", valueOrEmpty(cfg.ConvexSiteURL))
}

func valueOrEmpty(s string) string {
	if s == "" {
		return "(not set)"
	}
	return s
}

// ---------------------------------------------------------------------------
// set-runner — set which AI agent to use
// ---------------------------------------------------------------------------

func runSetRunner(args []string) {
	cfg, err := LoadConfig()
	if err != nil || cfg.AuthToken == "" {
		fmt.Fprintln(os.Stderr, "Not signed in. Run 'yaver auth' first.")
		os.Exit(1)
	}

	client := &http.Client{Timeout: 5 * time.Second}

	// Fetch available runners from Convex
	runners, err := fetchRunnersFromBackend(client, cfg.ConvexSiteURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not fetch runners: %v\n", err)
		os.Exit(1)
	}

	// No args: list available runners and show current selection
	if len(args) == 0 {
		// Fetch current settings
		currentRunner := getCurrentRunner(client, cfg.ConvexSiteURL, cfg.AuthToken)
		fmt.Println("Available AI runners:")
		fmt.Println()
		for _, r := range runners {
			marker := "  "
			if r.RunnerID == currentRunner {
				marker = "* "
			}
			fmt.Printf("  %s%-12s %s\n", marker, r.RunnerID, r.Name)
			if r.Description != "" {
				fmt.Printf("    %s%s\n", strings.Repeat(" ", 12), r.Description)
			}
		}
		fmt.Println()
		fmt.Println("Usage:")
		fmt.Println("  yaver set-runner claude           Use Claude Code (default)")
		fmt.Println("  yaver set-runner codex            Use OpenAI Codex")
		fmt.Println("  yaver set-runner aider            Use Aider")
		fmt.Printf("  yaver set-runner custom \"cmd\"      Use a custom command\n")
		fmt.Println()
		if currentRunner != "" {
			fmt.Printf("Current runner: %s\n", currentRunner)
		}
		return
	}

	runnerID := args[0]

	// Validate runner ID
	if runnerID != "custom" {
		found := false
		for _, r := range runners {
			if r.RunnerID == runnerID {
				found = true
				break
			}
		}
		if !found {
			fmt.Fprintf(os.Stderr, "Unknown runner: %s\n", runnerID)
			fmt.Fprintln(os.Stderr, "Run 'yaver set-runner' to see available runners.")
			os.Exit(1)
		}
	}

	// Build settings payload
	payload := map[string]string{"runnerId": runnerID}
	if runnerID == "custom" {
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Custom runner requires a command.")
			fmt.Fprintln(os.Stderr, "Example: yaver set-runner custom \"my-ai --auto {prompt}\"")
			os.Exit(1)
		}
		payload["customRunnerCommand"] = args[1]
	}

	payloadBytes, _ := json.Marshal(payload)
	req, err := newBearerRequest("POST", cfg.ConvexSiteURL+"/settings", cfg.AuthToken, bytes.NewReader(payloadBytes))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not save settings: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Server returned %d\n", resp.StatusCode)
		os.Exit(1)
	}

	if runnerID == "custom" {
		fmt.Printf("Runner set to: custom (%s)\n", args[1])
	} else {
		// Find name
		name := runnerID
		for _, r := range runners {
			if r.RunnerID == runnerID {
				name = r.Name
				break
			}
		}
		fmt.Printf("Runner set to: %s\n", name)
	}
	fmt.Println("Restart the agent for changes to take effect: yaver restart")
}

type backendRunner struct {
	RunnerID    string `json:"runnerId"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func fetchRunnersFromBackend(client *http.Client, convexSiteURL string) ([]backendRunner, error) {
	req, err := http.NewRequest("GET", convexSiteURL+"/runners", nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("runners endpoint returned %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	// Response is {"runners": [...]}
	var parsed struct {
		Runners []backendRunner `json:"runners"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	return parsed.Runners, nil
}

func getCurrentRunner(client *http.Client, convexSiteURL, token string) string {
	req, err := newBearerRequest("GET", convexSiteURL+"/settings", token, nil)
	if err != nil {
		return ""
	}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ""
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return ""
	}

	var settings struct {
		RunnerID string `json:"runnerId"`
	}
	if err := json.Unmarshal(body, &settings); err != nil {
		return ""
	}
	return settings.RunnerID
}

// ---------------------------------------------------------------------------
// clear-logs — truncate the agent log file
// ---------------------------------------------------------------------------

func runClearLogs() {
	lp := logFilePath()
	if lp == "" {
		fmt.Fprintln(os.Stderr, "Could not determine log file path.")
		os.Exit(1)
	}
	if err := os.Truncate(lp, 0); err != nil {
		if os.IsNotExist(err) {
			fmt.Println("No log file to clear.")
			return
		}
		fmt.Fprintf(os.Stderr, "Error clearing logs: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Agent logs cleared.")
}

// ---------------------------------------------------------------------------
// restart — stop and re-start the agent
// ---------------------------------------------------------------------------

func runRestart(args []string) {
	if pid, running := isAgentRunning(); running {
		proc, err := os.FindProcess(pid)
		if err == nil {
			terminateProcess(proc)
			for i := 0; i < 30; i++ {
				time.Sleep(100 * time.Millisecond)
				if !isProcessAlive(pid) {
					break
				}
			}
		}
		os.Remove(pidFilePath())
		fmt.Printf("Stopped previous agent (PID %d).\n", pid)
	}
	runServe(args)
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

	// Check agent first (local, instant)
	agentStatus := "stopped"
	if pid, running := isAgentRunning(); running {
		agentStatus = fmt.Sprintf("running (PID %d)", pid)
	}

	// Print local info immediately
	fmt.Printf("Agent:    %s\n", agentStatus)
	if cfg.DeviceID != "" {
		fmt.Printf("Device:   %s\n", cfg.DeviceID[:8]+"...")
	}
	fmt.Printf("Backend:  %s\n", cfg.ConvexSiteURL)

	// Validate token with a short timeout (3s) — don't block the user
	statusClient := &http.Client{Timeout: 3 * time.Second}
	req, reqErr := newBearerRequest("GET", cfg.ConvexSiteURL+"/auth/validate", cfg.AuthToken, nil)
	if reqErr != nil {
		fmt.Printf("Auth:     token present (validation skipped)\n")
		return
	}
	resp, respErr := statusClient.Do(req)
	if respErr != nil {
		fmt.Printf("Auth:     token present (could not reach server)\n")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Printf("Auth:     expired\n")
		fmt.Println()
		fmt.Println("Session expired. Run 'yaver auth' to re-authenticate.")
		return
	}

	var result struct {
		User UserInfo `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		fmt.Printf("Auth:     valid\n")
		return
	}

	fmt.Printf("Auth:     valid\n")
	fmt.Printf("User:     %s (%s)\n", result.User.Email, result.User.Provider)
	if result.User.FullName != "" && result.User.FullName != result.User.Email {
		fmt.Printf("Name:     %s\n", result.User.FullName)
	}

	// Show current runner
	runnerID := getCurrentRunner(statusClient, cfg.ConvexSiteURL, cfg.AuthToken)
	if runnerID == "" {
		runnerID = "claude"
	}
	runnerName := runnerID
	if runners, err := fetchRunnersFromBackend(statusClient, cfg.ConvexSiteURL); err == nil {
		for _, r := range runners {
			if r.RunnerID == runnerID {
				runnerName = r.Name
				break
			}
		}
	}
	fmt.Printf("Runner:   %s (%s)\n", runnerName, runnerID)
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
	case "windows":
		removeAutoStart()
		fmt.Println("  Removed scheduled task.")
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
// runner resolution — fetch user settings to determine which AI runner to use
// ---------------------------------------------------------------------------

// resolveRunner fetches user settings from the backend and returns the
// appropriate RunnerConfig. Falls back to defaultRunner on any error.
func resolveRunner(convexSiteURL, token string) RunnerConfig {
	client := &http.Client{Timeout: 5 * time.Second}

	// Step 1: Fetch user settings
	req, err := newBearerRequest("GET", convexSiteURL+"/settings", token, nil)
	if err != nil {
		log.Printf("Runner: could not build settings request: %v — using default", err)
		return defaultRunner
	}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("Runner: could not fetch settings: %v — using default", err)
		return defaultRunner
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Runner: settings endpoint returned %d — using default", resp.StatusCode)
		return defaultRunner
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("Runner: could not read settings response: %v — using default", err)
		return defaultRunner
	}

	var settings struct {
		RunnerID            string `json:"runnerId"`
		CustomRunnerCommand string `json:"customRunnerCommand"`
	}
	if err := json.Unmarshal(body, &settings); err != nil {
		log.Printf("Runner: could not parse settings: %v — using default", err)
		return defaultRunner
	}

	// No runner configured — use default but mark as auto-detected
	if settings.RunnerID == "" {
		r := defaultRunner
		r.AutoDetected = true
		return r
	}

	// Custom runner: wrap in sh -c with {prompt} placeholder
	if settings.RunnerID == "custom" && settings.CustomRunnerCommand != "" {
		log.Printf("Runner: using custom command: %s", settings.CustomRunnerCommand)
		return RunnerConfig{
			RunnerID:        "custom",
			Name:            "Custom Runner",
			Command:         "sh",
			Args:            []string{"-c", settings.CustomRunnerCommand},
			OutputMode:      "raw",
			ResumeSupported: false,
		}
	}

	// Known runner ID — try to fetch runner definitions from backend
	if settings.RunnerID == "claude" {
		return defaultRunner
	}

	runner, err := fetchRunner(client, convexSiteURL, settings.RunnerID)
	if err != nil {
		log.Printf("Runner: could not fetch runner %q: %v — using default", settings.RunnerID, err)
		return defaultRunner
	}
	return runner
}

// backendRunnerFull mirrors the Convex aiRunners table (args/resumeArgs are JSON strings).
type backendRunnerFull struct {
	RunnerID        string `json:"runnerId"`
	Name            string `json:"name"`
	Command         string `json:"command"`
	Args            string `json:"args"`            // JSON-encoded []string
	OutputMode      string `json:"outputMode"`
	ResumeSupported bool   `json:"resumeSupported"`
	ResumeArgs      string `json:"resumeArgs,omitempty"` // JSON-encoded []string
	ExitCommand     string `json:"exitCommand,omitempty"`
	Description     string `json:"description"`
}

// fetchRunner fetches the runner list from the backend and finds the one
// matching the given ID.
func fetchRunner(client *http.Client, convexSiteURL, runnerID string) (RunnerConfig, error) {
	req, err := http.NewRequest("GET", convexSiteURL+"/runners", nil)
	if err != nil {
		return RunnerConfig{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return RunnerConfig{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return RunnerConfig{}, fmt.Errorf("runners endpoint returned %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return RunnerConfig{}, err
	}

	// Response is {"runners": [...]}
	var wrapped struct {
		Runners []backendRunnerFull `json:"runners"`
	}
	if err := json.Unmarshal(body, &wrapped); err != nil {
		return RunnerConfig{}, fmt.Errorf("parse runners: %w", err)
	}

	for _, r := range wrapped.Runners {
		if r.RunnerID == runnerID {
			rc := RunnerConfig{
				RunnerID:        r.RunnerID,
				Name:            r.Name,
				Command:         r.Command,
				OutputMode:      r.OutputMode,
				ResumeSupported: r.ResumeSupported,
				ExitCommand:     r.ExitCommand,
			}
			// Parse JSON-encoded args
			if r.Args != "" {
				_ = json.Unmarshal([]byte(r.Args), &rc.Args)
			}
			if r.ResumeArgs != "" {
				_ = json.Unmarshal([]byte(r.ResumeArgs), &rc.ResumeArgs)
			}
			return rc, nil
		}
	}
	return RunnerConfig{}, fmt.Errorf("runner %q not found", runnerID)
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

// getLocalIP returns the preferred outbound local IP address.
func getLocalIP() string {
	// Use default outbound IP (LAN address when on local network)
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "0.0.0.0"
	}
	defer conn.Close()
	localAddr := conn.LocalAddr().(*net.UDPAddr)
	return localAddr.IP.String()
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

// ---------------------------------------------------------------------------
// Relay tunnel — connects agent to public relay server for P2P connectivity
// ---------------------------------------------------------------------------

// relayRegisterMsg is sent by the agent on the first QUIC stream.
type relayRegisterMsg struct {
	Type     string `json:"type"`
	DeviceID string `json:"deviceId"`
	Token    string `json:"token"`
}

type relayRegisterResp struct {
	Type    string `json:"type"`
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

type relayTunnelRequest struct {
	ID      string            `json:"id"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   string            `json:"query"`
	Headers map[string]string `json:"headers"`
	Body    []byte            `json:"body"`
}

type relayTunnelResponse struct {
	ID         string            `json:"id"`
	StatusCode int               `json:"statusCode"`
	Headers    map[string]string `json:"headers"`
	Body       []byte            `json:"body"`
}

// runRelayTunnel connects to the relay and handles incoming proxied requests.
// It reconnects automatically with exponential backoff.
func runRelayTunnel(ctx context.Context, relayAddr, agentAddr, deviceID, token string) {
	backoff := time.Second

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		log.Printf("[RELAY] Connecting to relay %s...", relayAddr)
		err := relayConnectAndServe(ctx, relayAddr, agentAddr, deviceID, token)
		if err != nil {
			log.Printf("[RELAY] Connection lost: %v", err)
		}

		if ctx.Err() != nil {
			return
		}

		log.Printf("[RELAY] Reconnecting in %s...", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}

		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func relayConnectAndServe(ctx context.Context, relayAddr, agentAddr, deviceID, token string) error {
	tlsCfg := &tls.Config{
		InsecureSkipVerify: true,
		NextProtos:         []string{"yaver-relay"},
	}

	conn, err := quic.DialAddr(ctx, relayAddr, tlsCfg, &quic.Config{
		MaxIdleTimeout:  120 * time.Second,
		KeepAlivePeriod: 20 * time.Second,
	})
	if err != nil {
		return fmt.Errorf("dial relay: %w", err)
	}
	defer conn.CloseWithError(0, "shutdown")

	// Register
	stream, err := conn.OpenStreamSync(ctx)
	if err != nil {
		return fmt.Errorf("open registration stream: %w", err)
	}

	regMsg := relayRegisterMsg{Type: "register", DeviceID: deviceID, Token: token}
	data, _ := json.Marshal(regMsg)
	stream.Write(data)
	stream.Close()

	respData, err := io.ReadAll(io.LimitReader(stream, 1<<16))
	if err != nil {
		return fmt.Errorf("read registration response: %w", err)
	}

	var regResp relayRegisterResp
	if err := json.Unmarshal(respData, &regResp); err != nil {
		return fmt.Errorf("parse registration response: %w", err)
	}
	if !regResp.OK {
		return fmt.Errorf("registration rejected: %s", regResp.Message)
	}

	log.Printf("[RELAY] Registered with relay as device %s", deviceID[:8])

	// Handle incoming proxied requests
	localClient := &http.Client{Timeout: 60 * time.Second}

	for {
		stream, err := conn.AcceptStream(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("accept stream: %w", err)
		}
		go relayHandleProxiedRequest(stream, agentAddr, localClient)
	}
}

func relayHandleProxiedRequest(stream quic.Stream, agentAddr string, client *http.Client) {
	defer stream.Close()

	data, err := io.ReadAll(io.LimitReader(stream, 10<<20))
	if err != nil {
		log.Printf("[RELAY] read request: %v", err)
		return
	}

	var req relayTunnelRequest
	if err := json.Unmarshal(data, &req); err != nil {
		log.Printf("[RELAY] parse request: %v", err)
		return
	}

	// Build local HTTP request
	url := fmt.Sprintf("http://%s%s", agentAddr, req.Path)
	if req.Query != "" {
		url += "?" + req.Query
	}

	httpReq, err := http.NewRequest(req.Method, url, bytes.NewReader(req.Body))
	if err != nil {
		log.Printf("[RELAY] build request: %v", err)
		relaySendError(stream, req.ID, 500, "failed to build request")
		return
	}

	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	// Check if SSE request
	isSSE := strings.HasSuffix(req.Path, "/output") && req.Method == "GET"

	if isSSE {
		sseClient := &http.Client{Timeout: 10 * time.Minute}
		resp, err := sseClient.Do(httpReq)
		if err != nil {
			relaySendError(stream, req.ID, 502, fmt.Sprintf("agent error: %v", err))
			return
		}
		defer resp.Body.Close()
		buf := make([]byte, 4096)
		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				if _, werr := stream.Write(buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}

	// Regular request
	resp, err := client.Do(httpReq)
	if err != nil {
		relaySendError(stream, req.ID, 502, fmt.Sprintf("agent error: %v", err))
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 10<<20))

	headers := make(map[string]string)
	for k, v := range resp.Header {
		if len(v) > 0 {
			headers[k] = v[0]
		}
	}

	tunnelResp := relayTunnelResponse{
		ID:         req.ID,
		StatusCode: resp.StatusCode,
		Headers:    headers,
		Body:       respBody,
	}

	respJSON, _ := json.Marshal(tunnelResp)
	stream.Write(respJSON)
}

func relaySendError(stream quic.Stream, id string, code int, msg string) {
	resp := relayTunnelResponse{
		ID:         id,
		StatusCode: code,
		Headers:    map[string]string{"Content-Type": "application/json"},
		Body:       []byte(fmt.Sprintf(`{"ok":false,"error":"%s"}`, msg)),
	}
	data, _ := json.Marshal(resp)
	stream.Write(data)
}
