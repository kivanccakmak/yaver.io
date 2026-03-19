package main

import (
	"bufio"
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

const version = "1.31.0"

// Default hosted Convex instance (public endpoint). Override with --convex-url flag or convex_site_url in config.json.
const defaultConvexSiteURL = "https://shocking-echidna-394.eu-west-1.convex.site"

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
	case "shutdown":
		runShutdown()
	case "ping":
		runPing(os.Args[2:])
	case "attach":
		runAttach(os.Args[2:])
	case "status":
		runStatus()
	case "devices":
		runDevices()
	case "config":
		runConfig(os.Args[2:])
	case "relay":
		runRelay(os.Args[2:])
	case "tunnel":
		runTunnel(os.Args[2:])
	case "set-runner":
		runSetRunner(os.Args[2:])
	case "mcp":
		runMCP(os.Args[2:])
	case "email":
		runEmail(os.Args[2:])
	case "acl":
		runACL(os.Args[2:])
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
		checkLatestVersion()
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
  yaver ping        Ping a device (direct or via relay)
  yaver stop        Stop the running agent
  yaver restart     Restart the agent
  yaver attach      Interactive terminal — see tasks, type prompts (like Claude Code)
  yaver serve       Start the agent manually (advanced)
  yaver logs        Show agent logs
  yaver clear-logs  Clear agent log file
  yaver config      Show current configuration
  yaver config set <key> <value>  Set a config value (auto-start, auto-update)
  yaver relay add <url> [--password <pass>] [--label <name>]  Add a relay server
  yaver relay list   List configured relay servers
  yaver relay remove <id-or-url>  Remove a relay server
  yaver relay test [url]  Test relay server health
  yaver relay set-password <pass>  Set default relay password
  yaver relay clear-password  Remove default relay password
  yaver tunnel add <url> [--cf-client-id <id>] [--cf-client-secret <secret>] [--label <name>]
  yaver tunnel list   List configured Cloudflare Tunnels
  yaver tunnel remove <id-or-url>  Remove a tunnel
  yaver tunnel test [url]  Test tunnel connectivity
  yaver tunnel setup  Show Cloudflare Tunnel setup guide
  yaver set-runner  Set default AI agent (also settable from mobile app, per task)
  yaver mcp         Start MCP server (local stdio or network HTTP)
  yaver email       Email connector setup and management (Office 365 / Gmail)
  yaver acl         Agent Communication Layer — connect to other MCP servers
  yaver status      Show auth, relay, and connection status
  yaver devices     List your registered devices
  yaver purge       Remove all local data (auth, sessions, tasks, logs)
  yaver uninstall   Remove config, certs, and stop the agent
  yaver help        Show this help message
  yaver version     Print version

Flags for auth:
  --headless        Use device code flow (for SSH/headless servers, auto-detected)
  --token           Provide token directly (skip browser)

Flags for serve:
  --debug           Run in foreground with verbose logging
  --port            HTTP server port (default 18080)
  --quic-port       QUIC server port (default 4433)
  --no-relay        Disable relay tunnels (direct connections only)
  --wait-for-session Wait for other Claude Code sessions to finish before starting tasks
  --dummy           Use dummy runner (fake responses for network testing)
  --work-dir        Working directory for tasks (default .)

Flags for connect:
  --host            Agent host (auto-discovers if not set)
  --port            Agent QUIC port (default 4433)
  --device          Device ID to connect to
  --relay           Connect through relay server (default: true)
  --direct          Connect directly via QUIC (skip relay)
  --relay-server    Relay server URL (auto-fetched from Convex if not set)

Examples:
  yaver set-runner claude           Use Claude Code (default)
  yaver set-runner codex            Use OpenAI Codex
  yaver set-runner aider            Use Aider
  yaver set-runner custom "my-ai --auto {prompt}"   Use a custom command
  yaver set-runner                  List available runners
  (Agent is also selectable per task from the mobile app)
  yaver config set auto-start true  Start Yaver on login
  yaver config set auto-update true Check for updates on startup

Run 'yaver <command> -h' for command-specific options.
`)
}

// ---------------------------------------------------------------------------
// auth — sign in via browser OAuth (like claude auth)
// ---------------------------------------------------------------------------

func runAuth(args []string) {
	fs := flag.NewFlagSet("auth", flag.ExitOnError)
	convexURL := fs.String("convex-url", defaultConvexSiteURL, "Convex site URL")
	token := fs.String("token", "", "Provide token directly (skip browser)")
	headless := fs.Bool("headless", false, "Use device code flow (for headless/SSH servers)")
	fs.Parse(args)

	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	// Check if already logged in
	if cfg.AuthToken != "" && cfg.ConvexSiteURL != "" {
		if err := ValidateToken(cfg.ConvexSiteURL, cfg.AuthToken); err == nil {
			fmt.Println("Already signed in.")
			fmt.Println()
			fmt.Println("Run 'yaver serve' to start the agent.")
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
		fmt.Println()
		fmt.Println("Run 'yaver serve' to start the agent.")
		return
	}

	// Device code flow for headless machines (SSH, no display)
	if *headless || isHeadless() {
		if *headless {
			fmt.Println("Using device code flow (--headless)...")
		} else {
			fmt.Println("Headless environment detected. Using device code flow...")
		}

		t, err := runDeviceCodeAuth(*convexURL)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

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
		fmt.Println("Signed in successfully.")
		fmt.Println()
		fmt.Println("Run 'yaver serve' to start the agent.")
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
		// Give the browser time to receive the HTML response before shutting down servers.
		time.Sleep(500 * time.Millisecond)
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
		fmt.Println("Signed in successfully.")
		fmt.Println()
		fmt.Println("Run 'yaver serve' to start the agent.")

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

	// Mark device offline and report event before clearing credentials
	if cfg.DeviceID != "" && cfg.ConvexSiteURL != "" {
		_ = ReportDeviceEvent(cfg.ConvexSiteURL, cfg.AuthToken, cfg.DeviceID, "stopped", "signout")
		if err := MarkOffline(cfg.ConvexSiteURL, cfg.AuthToken, cfg.DeviceID); err != nil {
			fmt.Printf("Warning: could not mark device offline: %v\n", err)
		}
	}

	// Stop running agent if any (it will lose auth after signout)
	if pid, running := isAgentRunning(); running {
		if proc, err := os.FindProcess(pid); err == nil {
			terminateProcess(proc)
		}
	}

	cfg.AuthToken = ""
	cfg.DeviceID = ""
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

func runPing(args []string) {
	fs := flag.NewFlagSet("ping", flag.ExitOnError)
	deviceID := fs.String("device", "", "Device ID to ping")
	useRelay := fs.Bool("relay", true, "Ping through relay server (default: true)")
	relayURL := fs.String("relay-server", "", "Relay server URL (auto-fetched if not set)")
	count := fs.Int("c", 5, "Number of pings")
	fs.Parse(args)

	cfg := mustLoadAuthConfig()

	// Auto-discover device
	devices, err := listDevices(cfg.ConvexSiteURL, cfg.AuthToken)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error listing devices: %v\n", err)
		os.Exit(1)
	}
	if len(devices) == 0 {
		fmt.Fprintln(os.Stderr, "No devices found.")
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
		fmt.Fprintln(os.Stderr, "No matching online device.")
		os.Exit(1)
	}

	authHeader := "Bearer " + cfg.AuthToken
	client := &http.Client{Timeout: 10 * time.Second}

	// Determine base URL
	var baseURL string
	var mode string

	if *useRelay || *relayURL != "" {
		if *relayURL == "" {
			relays, err := FetchRelayServers(cfg.ConvexSiteURL)
			if err != nil || len(relays) == 0 {
				fmt.Fprintln(os.Stderr, "No relay servers available.")
				os.Exit(1)
			}
			*relayURL = relays[0].HttpURL
		}
		baseURL = fmt.Sprintf("%s/d/%s", strings.TrimRight(*relayURL, "/"), target.DeviceID)
		mode = "relay"
	} else {
		baseURL = fmt.Sprintf("http://%s:%d", target.QuicHost, target.QuicPort)
		mode = "direct"
	}

	fmt.Printf("PING %s (%s) via %s\n", target.Name, target.DeviceID[:8], mode)

	var totalMs float64
	var minMs, maxMs float64
	success := 0
	minMs = 999999

	for i := 0; i < *count; i++ {
		start := time.Now()
		req, _ := http.NewRequest("GET", baseURL+"/health", nil)
		req.Header.Set("Authorization", authHeader)
		resp, err := client.Do(req)
		rtt := time.Since(start)
		rttMs := float64(rtt.Microseconds()) / 1000.0

		if err != nil {
			fmt.Printf("ping %d: error — %v\n", i+1, err)
		} else {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				fmt.Printf("pong from %s: time=%.1fms via=%s\n", target.Name, rttMs, mode)
				totalMs += rttMs
				if rttMs < minMs {
					minMs = rttMs
				}
				if rttMs > maxMs {
					maxMs = rttMs
				}
				success++
			} else {
				fmt.Printf("ping %d: HTTP %d\n", i+1, resp.StatusCode)
			}
		}

		if i < *count-1 {
			time.Sleep(1 * time.Second)
		}
	}

	fmt.Printf("\n--- %s ping statistics ---\n", target.Name)
	fmt.Printf("%d packets transmitted, %d received, %.0f%% loss\n",
		*count, success, float64(*count-success)/float64(*count)*100)
	if success > 0 {
		fmt.Printf("rtt min/avg/max = %.1f/%.1f/%.1f ms\n",
			minMs, totalMs/float64(success), maxMs)
	}
}

func runConnect(args []string) {
	fs := flag.NewFlagSet("connect", flag.ExitOnError)
	host := fs.String("host", "", "Agent host (auto-discovers if not set)")
	port := fs.Int("port", 4433, "Agent QUIC port")
	deviceID := fs.String("device", "", "Device ID to connect to")
	useRelay := fs.Bool("relay", true, "Connect through relay server (default: true)")
	direct := fs.Bool("direct", false, "Connect directly via QUIC (skip relay)")
	relayURL := fs.String("relay-server", "", "Relay server URL (e.g. https://connect.yaver.io). Auto-fetched if not set")
	fs.Parse(args)

	// --direct overrides --relay
	if *direct {
		*useRelay = false
	}

	cfg := mustLoadAuthConfig()

	// Auto-discover device
	var targetDeviceID string
	if *host == "" || *useRelay {
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

		if *host == "" {
			*host = target.QuicHost
			*port = target.QuicPort
		}
		targetDeviceID = target.DeviceID
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

	if *useRelay || *relayURL != "" {
		// Connect via relay HTTP proxy
		if *relayURL == "" {
			// Auto-fetch relay servers from Convex
			relays, err := FetchRelayServers(cfg.ConvexSiteURL)
			if err != nil || len(relays) == 0 {
				fmt.Fprintln(os.Stderr, "No relay servers available. Check your Convex config.")
				os.Exit(1)
			}
			*relayURL = relays[0].HttpURL
			fmt.Printf("Using relay: %s (%s)\n", relays[0].ID, relays[0].Region)
		}

		if targetDeviceID == "" {
			fmt.Fprintln(os.Stderr, "Device ID required for relay connection. Use --device flag.")
			os.Exit(1)
		}

		baseURL := fmt.Sprintf("%s/d/%s", strings.TrimRight(*relayURL, "/"), targetDeviceID)
		if err := RunClientHTTP(ctx, baseURL, cfg.AuthToken); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	} else {
		if err := RunClient(ctx, *host, *port, cfg.AuthToken); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
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
	waitForSession := fs.Bool("wait-for-session", false, "Wait for other Claude Code sessions to finish before starting tasks")
	debug := fs.Bool("debug", false, "Run in foreground with verbose logging")
	dummy := fs.Bool("dummy", false, "Use dummy runner (fake responses for network testing)")
	relayPassword := fs.String("relay-password", "", "Password for relay server authentication")
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

	// Check for auto-update before forking
	checkAutoUpdate(cfg)

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
		if *waitForSession {
			childArgs = append(childArgs, "--wait-for-session")
		}
		if *dummy {
			childArgs = append(childArgs, "--dummy")
		}
		if *relayPassword != "" {
			childArgs = append(childArgs, fmt.Sprintf("--relay-password=%s", *relayPassword))
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

	// Note: we no longer kill other Claude processes on startup.
	// Users may have active Claude Code sessions we shouldn't disrupt.

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

	// Get owner userId and email for multi-token auth and dev logging
	ownerInfo, err := ValidateTokenInfo(cfg.ConvexSiteURL, cfg.AuthToken)
	if err != nil {
		log.Fatalf("failed to get owner info: %v", err)
	}
	ownerUserID := ownerInfo.UserID
	ownerEmail := ownerInfo.Email
	log.Printf("Token validated. Owner: %s (%s)", ownerUserID, ownerEmail)

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
		if strings.Contains(err.Error(), "belongs to another user") {
			log.Printf("Device ID conflict — generating new device ID")
			cfg.DeviceID = uuid.New().String()
			if saveErr := SaveConfig(cfg); saveErr != nil {
				log.Fatalf("save config after device ID reset: %v", saveErr)
			}
			if err2 := RegisterDevice(cfg.ConvexSiteURL, RegisterDeviceRequest{
				Token:    cfg.AuthToken,
				DeviceID: cfg.DeviceID,
				Name:     hostname,
				Platform: platform,
				QuicHost: localIP,
				QuicPort: *httpPort,
			}); err2 != nil {
				log.Fatalf("device registration failed after reset: %v", err2)
			}
		} else {
			log.Fatalf("device registration failed: %v", err)
		}
	}
	log.Println("Device registered.")

	// Fetch platform config (relay servers, runners, models) from Convex
	var relayServers []RelayServerInfo
	// relayPasswords maps relay QuicAddr to password for per-relay auth
	relayPasswords := make(map[string]string)

	// Determine relay password: --relay-password flag > config.relay_password
	effectiveRelayPassword := *relayPassword
	if effectiveRelayPassword == "" {
		effectiveRelayPassword = cfg.RelayPassword
	}

	if !*noRelay && len(cfg.RelayServers) > 0 {
		// Use relay servers from config.json (highest priority)
		log.Printf("Using %d relay server(s) from config.json:", len(cfg.RelayServers))
		for _, rs := range cfg.RelayServers {
			relayServers = append(relayServers, RelayServerInfo{
				ID:       rs.ID,
				QuicAddr: rs.QuicAddr,
				HttpURL:  rs.HttpURL,
				Region:   rs.Region,
				Priority: rs.Priority,
			})
			// Per-relay password takes priority over global relay password
			if rs.Password != "" {
				relayPasswords[rs.QuicAddr] = rs.Password
			}
			log.Printf("  [%s] %s (%s)", rs.ID, rs.QuicAddr, rs.Region)
		}
	}

	platformCfg, platformErr := FetchPlatformConfig(cfg.ConvexSiteURL)
	if platformErr != nil {
		log.Printf("Warning: could not fetch platform config: %v", platformErr)
	} else {
		// Populate relay servers from Convex if not already set from config.json
		if !*noRelay && len(relayServers) == 0 {
			relayServers = platformCfg.RelayServers
			if len(relayServers) > 0 {
				log.Printf("Found %d relay server(s) from Convex:", len(relayServers))
				for _, rs := range relayServers {
					log.Printf("  [%s] %s (%s)", rs.ID, rs.QuicAddr, rs.Region)
				}
			} else {
				log.Println("No relay servers configured.")
			}
		}
		// Populate runners from Convex (overrides hardcoded builtinRunners)
		if len(platformCfg.Runners) > 0 {
			log.Printf("Loaded %d runner(s) from Convex", len(platformCfg.Runners))
			LoadRunnersFromBackend(platformCfg.Runners)
		}
		// Cache models for the /agent/runners endpoint
		if len(platformCfg.Models) > 0 {
			log.Printf("Loaded %d model(s) from Convex", len(platformCfg.Models))
			LoadModelsFromBackend(platformCfg.Models)
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
		// Scan all known agents to find what's installed
		agentSearch := []struct{ id, cmd, name string }{
			{"claude", "claude", "Claude Code"},
			{"codex", "codex", "OpenAI Codex"},
			{"aider", "aider", "Aider"},
			{"ollama", "ollama", "Ollama"},
			{"opencode", "opencode", "OpenCode"},
			{"goose", "goose", "Goose"},
			{"amp", "amp", "Amp"},
			{"continue", "continue", "Continue"},
		}

		type detectedAgent struct {
			id, cmd, name, path string
		}
		var available []detectedAgent
		for _, a := range agentSearch {
			var agentPath string
			if p, err := osexec.LookPath(a.cmd); err == nil {
				agentPath = p
			} else if p := findInExpandedPath(a.cmd); p != "" {
				agentPath = p
			}
			if agentPath != "" {
				available = append(available, detectedAgent{a.id, a.cmd, a.name, agentPath})
			}
		}

		if len(available) == 0 {
			log.Printf("WARNING: No AI agent found. Install one to run tasks.")
			log.Printf("  Claude Code: https://docs.anthropic.com/en/docs/claude-code")
			log.Printf("  OpenAI Codex: https://github.com/openai/codex")
			log.Printf("  Aider: https://aider.chat")
			log.Printf("  Ollama: https://ollama.com")
			log.Printf("  Or set a custom command: yaver set-runner custom \"your-command {prompt}\"")
			log.Printf("Agent will start but tasks will fail until an AI agent is available.")
		} else if len(available) == 1 {
			// Only one agent found — use it automatically
			a := available[0]
			log.Printf("Runner: auto-detected %s at %s", a.name, a.path)
			if r, err := fetchRunner(&http.Client{Timeout: 5 * time.Second}, cfg.ConvexSiteURL, a.id); err == nil {
				runner = r
			}
		} else {
			// Multiple agents found — ask user to pick (interactive, like Vercel)
			fmt.Println()
			fmt.Println("Multiple AI agents detected on your machine:")
			fmt.Println()
			for i, a := range available {
				fmt.Printf("  %d. %s  (%s)\n", i+1, a.name, a.path)
			}
			fmt.Println()
			fmt.Printf("Select your default agent [1-%d]: ", len(available))

			reader := bufio.NewReader(os.Stdin)
			input, _ := reader.ReadString('\n')
			input = strings.TrimSpace(input)
			choice := 0
			if n, err := fmt.Sscanf(input, "%d", &choice); n == 1 && err == nil && choice >= 1 && choice <= len(available) {
				a := available[choice-1]
				log.Printf("Runner: selected %s at %s", a.name, a.path)
				if r, err := fetchRunner(&http.Client{Timeout: 5 * time.Second}, cfg.ConvexSiteURL, a.id); err == nil {
					runner = r
				}
				// Save choice to Convex so it persists
				go func() {
					payload := map[string]string{"runnerId": a.id}
					body, _ := json.Marshal(payload)
					req, _ := http.NewRequest("POST", cfg.ConvexSiteURL+"/settings", bytes.NewReader(body))
					req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)
					req.Header.Set("Content-Type", "application/json")
					resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
					if err == nil {
						resp.Body.Close()
						log.Printf("Runner preference saved to account: %s", a.id)
					}
				}()
			} else {
				// Invalid input — use first detected
				a := available[0]
				log.Printf("Runner: defaulting to %s at %s", a.name, a.path)
				if r, err := fetchRunner(&http.Client{Timeout: 5 * time.Second}, cfg.ConvexSiteURL, a.id); err == nil {
					runner = r
				}
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
	taskMgr.WaitForSlot = *waitForSession
	taskMgr.DummyMode = *dummy
	if *dummy {
		log.Println("DUMMY MODE enabled — tasks will return fake responses (no real runner)")
	}
	taskMgr.ConvexURL = cfg.ConvexSiteURL
	taskMgr.AuthToken = cfg.AuthToken
	taskMgr.DeviceID = cfg.DeviceID
	taskMgr.OwnerEmail = ownerEmail

	// Configure sandbox — defaults to enabled with secure settings
	if cfg.Sandbox != nil {
		taskMgr.Sandbox = *cfg.Sandbox
	} else {
		taskMgr.Sandbox = DefaultSandboxConfig()
	}
	log.Printf("Sandbox: enabled=%v, allow_sudo=%v", taskMgr.Sandbox.Enabled, taskMgr.Sandbox.AllowSudo)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go heartbeatLoop(ctx, cfg.ConvexSiteURL, cfg.AuthToken, cfg.DeviceID, taskMgr)
	go metricsLoop(ctx, cfg.ConvexSiteURL, cfg.AuthToken, cfg.DeviceID)

	// Warm up the runner — fork Claude at startup to establish a session
	go taskMgr.WarmUp()

	// Initialize ACL manager for MCP peer communication
	var aclMgr *ACLManager
	if len(cfg.ACLPeers) > 0 {
		aclMgr = NewACLManager(cfg.ACLPeers)
		log.Printf("ACL: %d peer(s) configured", len(cfg.ACLPeers))
	} else {
		aclMgr = NewACLManager(nil)
	}

	// Initialize email manager if configured
	var emailMgr *EmailManager
	if cfg.Email != nil && cfg.Email.Provider != "" {
		var err error
		emailMgr, err = NewEmailManager(cfg.Email)
		if err != nil {
			log.Printf("Warning: email setup failed: %v", err)
		} else {
			log.Printf("Email: %s (%s) configured", cfg.Email.Provider, cfg.Email.SenderEmail)
		}
	}

	// Report agent started event
	go func() {
		if err := ReportDeviceEvent(cfg.ConvexSiteURL, cfg.AuthToken, cfg.DeviceID, "started", fmt.Sprintf("yaver %s", version)); err != nil {
			log.Printf("[event] Failed to report start: %v", err)
		}
	}()

	// Start HTTP server (V1 — primary, also serves MCP)
	httpServer := NewHTTPServer(*httpPort, cfg.AuthToken, ownerUserID, cfg.ConvexSiteURL, hostname, taskMgr)
	httpServer.aclMgr = aclMgr
	httpServer.emailMgr = emailMgr
	httpServer.onShutdown = func() {
		log.Println("Shutdown requested via API — stopping agent")
		cancel() // cancel the main context, triggers graceful shutdown
	}
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

	// Start LAN discovery beacon (UDP broadcast for same-network mobile discovery)
	go startBeacon(ctx, cfg.DeviceID, *httpPort, hostname, ownerUserID)

	// Start relay tunnels (connect to all relay servers for redundancy)
	for _, rs := range relayServers {
		rs := rs // capture loop variable
		// Resolve password: per-relay password > global relay password
		pw := relayPasswords[rs.QuicAddr]
		if pw == "" {
			pw = effectiveRelayPassword
		}
		log.Printf("Starting relay tunnel to %s (%s)...", rs.QuicAddr, rs.ID)
		go runRelayTunnel(ctx, rs.QuicAddr, fmt.Sprintf("127.0.0.1:%d", *httpPort), cfg.DeviceID, cfg.AuthToken, pw)
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	sig := <-sigCh
	log.Printf("Received signal %s, shutting down...", sig)
	taskMgr.Shutdown()
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
// shutdown — gracefully stop the agent via its HTTP API (same as mobile)
// ---------------------------------------------------------------------------

func runShutdown() {
	pid, running := isAgentRunning()
	if !running {
		fmt.Println("Yaver agent is not running.")
		return
	}

	cfg, err := LoadConfig()
	if err != nil || cfg.AuthToken == "" {
		fmt.Println("Not signed in — using kill instead.")
		runStop()
		return
	}

	// Call the agent's HTTP shutdown endpoint
	url := fmt.Sprintf("http://127.0.0.1:%d/agent/shutdown", 18080) // default port
	req, _ := http.NewRequest("POST", url, nil)
	req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("Could not reach agent API — falling back to kill (PID %d)\n", pid)
		runStop()
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == 200 {
		fmt.Printf("Shutdown signal sent to agent (PID %d) — stopping gracefully.\n", pid)
		// Wait for process to exit
		for i := 0; i < 50; i++ {
			time.Sleep(100 * time.Millisecond)
			if !isProcessAlive(pid) {
				break
			}
		}
		os.Remove(pidFilePath())
		fmt.Println("Agent stopped.")
	} else {
		fmt.Printf("Shutdown API returned %d — falling back to kill\n", resp.StatusCode)
		runStop()
	}
}

// ---------------------------------------------------------------------------
// config — dump current CLI configuration
// ---------------------------------------------------------------------------

func runConfig(args []string) {
	// Handle "yaver config set <key> <value>"
	if len(args) >= 3 && args[0] == "set" {
		runConfigSet(args[1], args[2])
		return
	}

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
	fmt.Printf("auto_start:      %v\n", cfg.AutoStart)
	fmt.Printf("auto_update:     %v\n", cfg.AutoUpdate)
}

func runConfigSet(key, value string) {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	switch key {
	case "auto-start":
		enabled := value == "true" || value == "1" || value == "yes"
		cfg.AutoStart = enabled
		if err := SaveConfig(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "Error saving config: %v\n", err)
			os.Exit(1)
		}
		if enabled {
			exePath, err := os.Executable()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error finding executable: %v\n", err)
				os.Exit(1)
			}
			workDir, _ := os.Getwd()
			if err := installAutoStart(exePath, workDir); err != nil {
				fmt.Fprintf(os.Stderr, "Error installing auto-start: %v\n", err)
				os.Exit(1)
			}
		} else {
			removeAutoStart()
			fmt.Println("Auto-start disabled. Yaver will no longer start on login.")
		}

	case "auto-update":
		enabled := value == "true" || value == "1" || value == "yes"
		cfg.AutoUpdate = enabled
		if err := SaveConfig(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "Error saving config: %v\n", err)
			os.Exit(1)
		}
		if enabled {
			fmt.Println("Auto-update enabled. Yaver will check for updates on startup.")
		} else {
			fmt.Println("Auto-update disabled.")
		}

	default:
		fmt.Fprintf(os.Stderr, "Unknown config key: %s\n", key)
		fmt.Fprintf(os.Stderr, "Supported keys: auto-start, auto-update\n")
		os.Exit(1)
	}
}

// ---------------------------------------------------------------------------
// relay — manage custom relay servers
// ---------------------------------------------------------------------------

func runRelay(args []string) {
	if len(args) == 0 {
		fmt.Println("Usage:")
		fmt.Println("  yaver relay add <url> [--password <pass>] [--label <name>]")
		fmt.Println("  yaver relay list")
		fmt.Println("  yaver relay remove <id-or-url>")
		fmt.Println("  yaver relay test [url]")
		fmt.Println("  yaver relay set-password <password>")
		fmt.Println("  yaver relay clear-password")
		os.Exit(0)
	}

	switch args[0] {
	case "add":
		runRelayAdd(args[1:])
	case "list", "ls":
		runRelayList()
	case "remove", "rm":
		runRelayRemove(args[1:])
	case "test":
		runRelayTest(args[1:])
	case "set-password":
		runRelaySetPassword(args[1:])
	case "clear-password":
		runRelayClearPassword()
	default:
		fmt.Fprintf(os.Stderr, "Unknown relay subcommand: %s\n", args[0])
		os.Exit(1)
	}
}

func runRelayAdd(args []string) {
	fs := flag.NewFlagSet("relay add", flag.ExitOnError)
	password := fs.String("password", "", "Relay server password")
	label := fs.String("label", "", "Human-readable label (e.g. 'My VPS')")
	fs.Parse(args)

	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "Usage: yaver relay add <url> [--password <pass>] [--label <name>]")
		os.Exit(1)
	}

	rawURL := fs.Arg(0)
	// Normalize: strip trailing slash
	rawURL = strings.TrimRight(rawURL, "/")

	// Generate ID from URL: first 8 hex chars of a simple hash
	id := fmt.Sprintf("%x", func() uint32 {
		var h uint32
		for _, c := range rawURL {
			h = h*31 + uint32(c)
		}
		return h
	}())
	if len(id) > 8 {
		id = id[:8]
	}

	// Infer QUIC address from URL (same host, port 4433)
	host := rawURL
	// Remove scheme
	for _, prefix := range []string{"https://", "http://"} {
		host = strings.TrimPrefix(host, prefix)
	}
	// Remove port if present
	if idx := strings.LastIndex(host, ":"); idx != -1 {
		host = host[:idx]
	}
	// Remove path
	if idx := strings.Index(host, "/"); idx != -1 {
		host = host[:idx]
	}
	quicAddr := host + ":4433"

	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	// Check for duplicate URL
	for _, rs := range cfg.RelayServers {
		if rs.HttpURL == rawURL {
			fmt.Fprintf(os.Stderr, "Relay server already configured: %s (id: %s)\n", rawURL, rs.ID)
			os.Exit(1)
		}
	}

	relay := RelayServerConfig{
		ID:       id,
		QuicAddr: quicAddr,
		HttpURL:  rawURL,
		Password: *password,
		Label:    *label,
		Priority: len(cfg.RelayServers) + 1,
	}

	cfg.RelayServers = append(cfg.RelayServers, relay)
	if err := SaveConfig(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Error saving config: %v\n", err)
		os.Exit(1)
	}

	displayLabel := relay.Label
	if displayLabel == "" {
		displayLabel = relay.HttpURL
	}
	fmt.Printf("Added relay server: %s\n", displayLabel)
	fmt.Printf("  ID:       %s\n", relay.ID)
	fmt.Printf("  URL:      %s\n", relay.HttpURL)
	fmt.Printf("  QUIC:     %s\n", relay.QuicAddr)
	if relay.Password != "" {
		fmt.Printf("  Password: ****\n")
	}
	fmt.Println("\nRestart 'yaver serve' to use the new relay server.")
}

func runRelayList() {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	if len(cfg.RelayServers) == 0 {
		fmt.Println("No custom relay servers configured.")
		fmt.Println("Relay servers from Convex platform config will be used.")
		fmt.Println()
		fmt.Println("Add one with: yaver relay add <url>")
		return
	}

	fmt.Printf("%-10s %-35s %-12s %-10s\n", "ID", "URL", "Password", "Label")
	fmt.Printf("%-10s %-35s %-12s %-10s\n", "------", "---", "--------", "-----")
	for _, rs := range cfg.RelayServers {
		pw := "(none)"
		if rs.Password != "" {
			pw = "****"
		}
		lbl := rs.Label
		if lbl == "" {
			lbl = "-"
		}
		fmt.Printf("%-10s %-35s %-12s %-10s\n", rs.ID, rs.HttpURL, pw, lbl)
	}
}

func runRelayRemove(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: yaver relay remove <id-or-url>")
		os.Exit(1)
	}
	target := args[0]

	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	found := false
	var remaining []RelayServerConfig
	for _, rs := range cfg.RelayServers {
		if rs.ID == target || rs.HttpURL == target {
			found = true
			fmt.Printf("Removed relay server: %s (%s)\n", rs.HttpURL, rs.ID)
		} else {
			remaining = append(remaining, rs)
		}
	}

	if !found {
		fmt.Fprintf(os.Stderr, "Relay server not found: %s\n", target)
		os.Exit(1)
	}

	cfg.RelayServers = remaining
	if err := SaveConfig(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Error saving config: %v\n", err)
		os.Exit(1)
	}
}

func runRelayTest(args []string) {
	var urls []string

	if len(args) > 0 {
		urls = []string{strings.TrimRight(args[0], "/")}
	} else {
		// Test all configured relays
		cfg, err := LoadConfig()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
			os.Exit(1)
		}
		for _, rs := range cfg.RelayServers {
			urls = append(urls, rs.HttpURL)
		}
		if len(urls) == 0 {
			fmt.Println("No relay servers configured. Pass a URL: yaver relay test <url>")
			os.Exit(0)
		}
	}

	client := &http.Client{Timeout: 10 * time.Second}
	for _, u := range urls {
		healthURL := u + "/health"
		start := time.Now()
		resp, err := client.Get(healthURL)
		rtt := time.Since(start)
		if err != nil {
			fmt.Printf("FAIL  %s  error: %v\n", u, err)
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == 200 {
			fmt.Printf("OK    %s  %dms  %s\n", u, rtt.Milliseconds(), strings.TrimSpace(string(body)))
		} else {
			fmt.Printf("FAIL  %s  status: %d  %s\n", u, resp.StatusCode, strings.TrimSpace(string(body)))
		}
	}
}

func runRelaySetPassword(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: yaver relay set-password <password>")
		os.Exit(1)
	}
	password := args[0]

	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	cfg.RelayPassword = password
	if err := SaveConfig(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Error saving config: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Relay password saved.")
	fmt.Println("Restart 'yaver serve' for the change to take effect.")
}

func runRelayClearPassword() {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	if cfg.RelayPassword == "" {
		fmt.Println("No relay password was set.")
		return
	}

	cfg.RelayPassword = ""
	if err := SaveConfig(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Error saving config: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Relay password cleared.")
	fmt.Println("Restart 'yaver serve' for the change to take effect.")
}

func runTunnel(args []string) {
	if len(args) == 0 {
		fmt.Print(`Yaver Tunnel — Cloudflare Tunnel configuration

Usage:
  yaver tunnel add <url> [--cf-client-id <id>] [--cf-client-secret <secret>] [--label <name>]
  yaver tunnel list
  yaver tunnel remove <id-or-url>
  yaver tunnel test [url]
  yaver tunnel setup

Cloudflare Tunnel exposes your agent's HTTP server via a public HTTPS URL.
This works through any firewall that allows HTTPS traffic.

Connection priority: LAN direct → Cloudflare Tunnel → Relay Server
`)
		os.Exit(0)
	}

	switch args[0] {
	case "add":
		runTunnelAdd(args[1:])
	case "list", "ls":
		runTunnelList()
	case "remove", "rm":
		runTunnelRemove(args[1:])
	case "test":
		runTunnelTest(args[1:])
	case "setup":
		runTunnelSetup()
	default:
		fmt.Fprintf(os.Stderr, "Unknown tunnel subcommand: %s\n", args[0])
		os.Exit(1)
	}
}

func runTunnelAdd(args []string) {
	fs := flag.NewFlagSet("tunnel add", flag.ExitOnError)
	cfClientId := fs.String("cf-client-id", "", "CF Access Service Token Client ID")
	cfClientSecret := fs.String("cf-client-secret", "", "CF Access Service Token Client Secret")
	label := fs.String("label", "", "Human-readable label")
	fs.Parse(args)

	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "Usage: yaver tunnel add <url> [--cf-client-id <id>] [--cf-client-secret <secret>] [--label <name>]")
		os.Exit(1)
	}

	rawURL := strings.TrimRight(fs.Arg(0), "/")

	// Generate ID from URL hash
	id := fmt.Sprintf("%x", func() uint32 {
		var h uint32
		for _, c := range rawURL {
			h = h*31 + uint32(c)
		}
		return h
	}())
	if len(id) > 8 {
		id = id[:8]
	}

	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	// Check duplicate
	for _, t := range cfg.CloudflareTunnels {
		if t.URL == rawURL {
			fmt.Fprintf(os.Stderr, "Tunnel already configured: %s (id: %s)\n", rawURL, t.ID)
			os.Exit(1)
		}
	}

	tunnel := CloudflareTunnelConfig{
		ID:                   id,
		URL:                  rawURL,
		CFAccessClientId:     *cfClientId,
		CFAccessClientSecret: *cfClientSecret,
		Label:                *label,
		Priority:             len(cfg.CloudflareTunnels) + 1,
	}

	cfg.CloudflareTunnels = append(cfg.CloudflareTunnels, tunnel)
	if err := SaveConfig(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Error saving config: %v\n", err)
		os.Exit(1)
	}

	displayLabel := tunnel.Label
	if displayLabel == "" {
		displayLabel = tunnel.URL
	}
	fmt.Printf("Added Cloudflare Tunnel: %s\n", displayLabel)
	fmt.Printf("  ID:  %s\n", tunnel.ID)
	fmt.Printf("  URL: %s\n", tunnel.URL)
	if tunnel.CFAccessClientId != "" {
		fmt.Printf("  CF Access: configured\n")
	}
	fmt.Println("\nThe mobile app will try this tunnel when connecting to your machine.")
}

func runTunnelList() {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	if len(cfg.CloudflareTunnels) == 0 {
		fmt.Println("No Cloudflare Tunnels configured.")
		fmt.Println()
		fmt.Println("Add one with: yaver tunnel add <url>")
		fmt.Println("Or run: yaver tunnel setup  for a setup guide")
		return
	}

	fmt.Printf("%-10s %-40s %-12s %-10s\n", "ID", "URL", "CF Access", "Label")
	fmt.Printf("%-10s %-40s %-12s %-10s\n", "------", "---", "---------", "-----")
	for _, t := range cfg.CloudflareTunnels {
		cfAccess := "(none)"
		if t.CFAccessClientId != "" {
			cfAccess = "configured"
		}
		lbl := t.Label
		if lbl == "" {
			lbl = "-"
		}
		fmt.Printf("%-10s %-40s %-12s %-10s\n", t.ID, t.URL, cfAccess, lbl)
	}
}

func runTunnelRemove(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: yaver tunnel remove <id-or-url>")
		os.Exit(1)
	}
	target := args[0]

	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	found := false
	var remaining []CloudflareTunnelConfig
	for _, t := range cfg.CloudflareTunnels {
		if t.ID == target || t.URL == target {
			found = true
			fmt.Printf("Removed Cloudflare Tunnel: %s (%s)\n", t.URL, t.ID)
		} else {
			remaining = append(remaining, t)
		}
	}

	if !found {
		fmt.Fprintf(os.Stderr, "Tunnel not found: %s\n", target)
		os.Exit(1)
	}

	cfg.CloudflareTunnels = remaining
	if err := SaveConfig(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Error saving config: %v\n", err)
		os.Exit(1)
	}
}

func runTunnelTest(args []string) {
	var tunnels []CloudflareTunnelConfig

	if len(args) > 0 {
		tunnels = []CloudflareTunnelConfig{{URL: strings.TrimRight(args[0], "/")}}
	} else {
		cfg, err := LoadConfig()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
			os.Exit(1)
		}
		tunnels = cfg.CloudflareTunnels
		if len(tunnels) == 0 {
			fmt.Println("No tunnels configured. Pass a URL: yaver tunnel test <url>")
			os.Exit(0)
		}
	}

	client := &http.Client{Timeout: 10 * time.Second}
	for _, t := range tunnels {
		healthURL := t.URL + "/health"
		req, _ := http.NewRequest("GET", healthURL, nil)
		if t.CFAccessClientId != "" {
			req.Header.Set("CF-Access-Client-Id", t.CFAccessClientId)
			req.Header.Set("CF-Access-Client-Secret", t.CFAccessClientSecret)
		}
		start := time.Now()
		resp, err := client.Do(req)
		rtt := time.Since(start)
		if err != nil {
			fmt.Printf("FAIL  %s  error: %v\n", t.URL, err)
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == 200 {
			fmt.Printf("OK    %s  %dms  %s\n", t.URL, rtt.Milliseconds(), strings.TrimSpace(string(body)))
		} else {
			fmt.Printf("FAIL  %s  status: %d  %s\n", t.URL, resp.StatusCode, strings.TrimSpace(string(body)))
		}
	}
}

func runTunnelSetup() {
	fmt.Print(`Cloudflare Tunnel Setup Guide
═════════════════════════════

Cloudflare Tunnel creates a secure HTTPS connection from Cloudflare's edge
to your machine. No port forwarding, works through any firewall.

── Prerequisites ─────────────────────────────────────────────────

  1. A Cloudflare account (free tier works)
  2. A domain on Cloudflare (or use quick tunnels for testing)
  3. cloudflared CLI installed

── Install cloudflared ───────────────────────────────────────────

  macOS:   brew install cloudflared
  Linux:   See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  Windows: winget install Cloudflare.cloudflared

── Option A: Quick Tunnel (testing) ──────────────────────────────

  # Start yaver agent first
  $ yaver serve

  # In another terminal, create a quick tunnel
  $ cloudflared tunnel --url http://localhost:18080

  # You'll see a URL like: https://abc123.trycloudflare.com
  # Add it to yaver:
  $ yaver tunnel add https://abc123.trycloudflare.com

  Note: Quick tunnel URLs change each time. Use named tunnels for
  a permanent setup.

── Option B: Named Tunnel (production) ───────────────────────────

  # 1. Login to Cloudflare
  $ cloudflared tunnel login

  # 2. Create a tunnel
  $ cloudflared tunnel create yaver

  # 3. Route DNS
  $ cloudflared tunnel route dns yaver tunnel.yourdomain.com

  # 4. Create config file (~/.cloudflared/config.yml):
  tunnel: <tunnel-id>
  credentials-file: ~/.cloudflared/tunnel-id.json
  ingress:
    - hostname: tunnel.yourdomain.com
      service: http://localhost:18080
    - service: http_status:404

  # 5. Run the tunnel
  $ cloudflared tunnel run yaver

  # 6. Register in yaver
  $ yaver tunnel add https://tunnel.yourdomain.com

── Option C: Named Tunnel + CF Access (extra security) ───────────

  If you want to restrict access with a service token:

  1. Create a CF Access application for tunnel.yourdomain.com
  2. Create a Service Token in Zero Trust → Access → Service Auth
  3. Create a policy allowing the service token

  $ yaver tunnel add https://tunnel.yourdomain.com \
      --cf-client-id <service-token-client-id> \
      --cf-client-secret <service-token-client-secret>

── Mobile App ────────────────────────────────────────────────────

  In the Yaver mobile app:
    Settings → Cloudflare Tunnel → + Add
    Enter the same tunnel URL (and CF Access credentials if used).

  The app will try: LAN direct → Cloudflare Tunnel → Relay Server

── Run on startup (systemd) ──────────────────────────────────────

  $ sudo cloudflared service install
  $ sudo systemctl enable cloudflared
  $ sudo systemctl start cloudflared

For more: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
`)
}

func valueOrEmpty(s string) string {
	if s == "" {
		return "(not set)"
	}
	return s
}

// checkAutoUpdate checks for a newer release on GitHub and self-updates the binary.
// Returns silently if auto-update is disabled or if already up-to-date.
func checkAutoUpdate(cfg *Config) {
	if !cfg.AutoUpdate {
		return
	}

	log.Println("[auto-update] Checking for updates...")

	type ghRelease struct {
		TagName string `json:"tag_name"`
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get("https://api.github.com/repos/kivanccakmak/yaver-cli/releases/latest")
	if err != nil {
		log.Printf("[auto-update] Failed to check for updates: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		log.Printf("[auto-update] GitHub API returned %d", resp.StatusCode)
		return
	}

	var release ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		log.Printf("[auto-update] Failed to parse release: %v", err)
		return
	}

	latestVersion := strings.TrimPrefix(release.TagName, "v")
	if latestVersion == "" || latestVersion == version {
		log.Printf("[auto-update] Already up-to-date (v%s)", version)
		return
	}

	// Simple semver comparison: if latest == current, skip
	// For a proper comparison we just check inequality since GitHub returns the latest
	log.Printf("[auto-update] New version available: v%s (current: v%s)", latestVersion, version)

	goos := runtime.GOOS
	goarch := runtime.GOARCH
	binaryName := fmt.Sprintf("yaver-%s-%s", goos, goarch)
	downloadURL := fmt.Sprintf("https://github.com/kivanccakmak/yaver-cli/releases/download/v%s/%s", latestVersion, binaryName)

	log.Printf("[auto-update] Downloading %s", downloadURL)
	dlResp, err := client.Get(downloadURL)
	if err != nil {
		log.Printf("[auto-update] Download failed: %v", err)
		return
	}
	defer dlResp.Body.Close()

	if dlResp.StatusCode != 200 {
		log.Printf("[auto-update] Download returned %d", dlResp.StatusCode)
		return
	}

	// Write to a temp file next to the current binary
	exePath, err := os.Executable()
	if err != nil {
		log.Printf("[auto-update] Cannot find executable path: %v", err)
		return
	}

	tmpPath := exePath + ".update"
	tmpFile, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		log.Printf("[auto-update] Cannot create temp file: %v", err)
		return
	}

	if _, err := io.Copy(tmpFile, dlResp.Body); err != nil {
		tmpFile.Close()
		os.Remove(tmpPath)
		log.Printf("[auto-update] Failed to write update: %v", err)
		return
	}
	tmpFile.Close()

	// Replace the current binary with the new one
	if err := os.Rename(tmpPath, exePath); err != nil {
		os.Remove(tmpPath)
		log.Printf("[auto-update] Failed to replace binary: %v", err)
		return
	}

	log.Printf("[auto-update] Updated to v%s. The new version will take effect on next restart.", latestVersion)
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
		fmt.Println("Tip: You can also pick the AI agent from the Yaver mobile app when")
		fmt.Println("creating a task. Each task can use a different agent — this command")
		fmt.Println("sets the default for new tasks.")
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
	fmt.Printf("Yaver:    v%s\n", version)

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

	// Check runner binary
	runnerCmd := runnerID
	if path, lookErr := osexec.LookPath(runnerCmd); lookErr != nil {
		fmt.Printf("  Status: not installed (%s not found in PATH)\n", runnerCmd)
	} else {
		fmt.Printf("  Binary: %s\n", path)
	}

	// Query the running agent's API for forked processes
	if pid, running := isAgentRunning(); running {
		agentURL := fmt.Sprintf("http://127.0.0.1:%d/agent/status", 18080)
		req, _ := http.NewRequest("GET", agentURL, nil)
		req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)
		statusResp, err := statusClient.Do(req)
		if err == nil {
			defer statusResp.Body.Close()
			if statusResp.StatusCode == 200 {
				var statusBody struct {
					Status AgentStatus `json:"status"`
				}
				if json.NewDecoder(statusResp.Body).Decode(&statusBody) == nil {
					procs := statusBody.Status.RunnerProcesses
					if len(procs) > 0 {
						for _, p := range procs {
							cmdPreview := p.Command
							if len(cmdPreview) > 60 {
								cmdPreview = cmdPreview[:60] + "..."
							}
							fmt.Printf("  Forked: PID %d (%s)\n", p.PID, cmdPreview)
						}
					} else {
						fmt.Printf("  Forked: idle\n")
					}

					// Show running tasks only
					runningCount := int(statusBody.Status.RunningTasks)
					if runningCount > 0 {
						fmt.Printf("  Tasks:  %d running\n", runningCount)
					}
				}
			}
		}
		_ = pid
	}

	// Relay server status
	fmt.Println()
	fmt.Println("Relay:")
	if cfg.RelayPassword != "" {
		fmt.Println("  Password: set")
	} else {
		fmt.Println("  Password: not set")
	}

	if len(cfg.RelayServers) == 0 {
		fmt.Println("  Servers:  none configured (will fetch from Convex on serve)")
	} else {
		fmt.Println("  Servers:")
		relayClient := &http.Client{Timeout: 5 * time.Second}
		for _, rs := range cfg.RelayServers {
			label := rs.ID
			if label == "" {
				label = rs.HttpURL
			}
			healthURL := rs.HttpURL + "/health"
			start := time.Now()
			resp, err := relayClient.Get(healthURL)
			rtt := time.Since(start)
			if err != nil {
				fmt.Printf("    %-10s %-30s FAIL (timeout)\n", label, rs.HttpURL)
			} else {
				resp.Body.Close()
				if resp.StatusCode == 200 {
					fmt.Printf("    %-10s %-30s OK (%dms)\n", label, rs.HttpURL, rtt.Milliseconds())
				} else {
					fmt.Printf("    %-10s %-30s FAIL (status %d)\n", label, rs.HttpURL, resp.StatusCode)
				}
			}
		}
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

	// Known runner ID — use builtinRunners (populated from Convex) or default
	if r, ok := builtinRunners[settings.RunnerID]; ok {
		return r
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

func heartbeatLoop(ctx context.Context, baseURL, token, deviceID string, taskMgr *TaskManager) {
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()

	lastIP := getLocalIP()

	// Send first heartbeat immediately (don't wait 2 min for ticker)
	runners := taskMgr.GetRunnerInfos()
	if err := SendHeartbeat(baseURL, token, deviceID, runners, lastIP); err != nil {
		log.Printf("initial heartbeat failed: %v", err)
	} else {
		log.Println("Initial heartbeat sent.")
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			currentIP := getLocalIP()
			runners := taskMgr.GetRunnerInfos()

			if currentIP != lastIP {
				log.Printf("[heartbeat] Local IP changed: %s → %s", lastIP, currentIP)
				lastIP = currentIP
			}

			if err := SendHeartbeat(baseURL, token, deviceID, runners, currentIP); err != nil {
				log.Printf("heartbeat failed: %v", err)
			} else {
				log.Println("Heartbeat sent.")
			}
		}
	}
}

// metricsLoop collects CPU/RAM every 60s and reports to Convex.
func metricsLoop(ctx context.Context, baseURL, token, deviceID string) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cpuPct, cpuErr := getCPUPercent()
			if cpuErr != nil {
				log.Printf("[metrics] CPU error: %v", cpuErr)
				cpuPct = 0
			}

			memUsed, memErr := getMemoryUsedMB()
			if memErr != nil {
				log.Printf("[metrics] Memory used error: %v", memErr)
				memUsed = 0
			}

			memTotal, totalErr := getSystemMemoryMB()
			if totalErr != nil {
				log.Printf("[metrics] Memory total error: %v", totalErr)
				memTotal = 0
			}

			log.Printf("[metrics] CPU=%.1f%% RAM=%dMB/%dMB", cpuPct, memUsed, memTotal)

			if err := ReportMetrics(baseURL, token, deviceID, cpuPct, float64(memUsed), float64(memTotal)); err != nil {
				log.Printf("[metrics] Report failed: %v", err)
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
	Password string `json:"password,omitempty"`
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
func runRelayTunnel(ctx context.Context, relayAddr, agentAddr, deviceID, token, password string) {
	backoff := time.Second

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		log.Printf("[RELAY] Connecting to relay %s...", relayAddr)
		err := relayConnectAndServe(ctx, relayAddr, agentAddr, deviceID, token, password)
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

func relayConnectAndServe(ctx context.Context, relayAddr, agentAddr, deviceID, token, password string) error {
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

	regMsg := relayRegisterMsg{Type: "register", DeviceID: deviceID, Token: token, Password: password}
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

// ---------------------------------------------------------------------------
// mcp — Start MCP server (local stdio or network HTTP)
// ---------------------------------------------------------------------------

func runMCP(args []string) {
	fs := flag.NewFlagSet("mcp", flag.ExitOnError)
	mode := fs.String("mode", "stdio", "MCP transport: stdio (for Claude Desktop) or http (network)")
	httpPort := fs.Int("port", 18090, "HTTP port for network MCP mode")
	workDir := fs.String("work-dir", ".", "Working directory for tasks")
	fs.Parse(args)

	if *workDir == "." {
		wd, _ := os.Getwd()
		*workDir = wd
	}

	cfg, _ := LoadConfig()
	if cfg == nil {
		cfg = &Config{}
	}

	// Build a minimal task manager for MCP
	taskStore, _ := NewTaskStore()
	runner := defaultRunner
	if r, ok := builtinRunners["claude"]; ok {
		runner = r
	}
	taskMgr := NewTaskManager(*workDir, taskStore, runner)
	if cfg.Sandbox != nil {
		taskMgr.Sandbox = *cfg.Sandbox
	} else {
		taskMgr.Sandbox = DefaultSandboxConfig()
	}

	// Init ACL
	aclMgr := NewACLManager(cfg.ACLPeers)

	// Init email
	var emailMgr *EmailManager
	if cfg.Email != nil && cfg.Email.Provider != "" {
		emailMgr, _ = NewEmailManager(cfg.Email)
	}

	switch *mode {
	case "stdio":
		fmt.Fprintf(os.Stderr, "Yaver MCP server (stdio) v%s — work dir: %s\n", version, *workDir)
		runMCPStdio(taskMgr, aclMgr, emailMgr)
	case "http":
		fmt.Printf("Yaver MCP server (HTTP) v%s on port %d — work dir: %s\n", version, *httpPort, *workDir)
		hostname, _ := os.Hostname()
		srv := NewHTTPServer(*httpPort, "", "", "", hostname, taskMgr)
		srv.aclMgr = aclMgr
		srv.emailMgr = emailMgr
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		go func() {
			<-sigCh
			cancel()
		}()

		if err := srv.Start(ctx); err != nil {
			log.Fatalf("MCP HTTP server error: %v", err)
		}
	default:
		fmt.Fprintf(os.Stderr, "Unknown MCP mode: %s (use 'stdio' or 'http')\n", *mode)
		os.Exit(1)
	}
}

// runMCPStdio runs MCP over stdin/stdout (JSON-RPC 2.0, one request per line).
func runMCPStdio(taskMgr *TaskManager, aclMgr *ACLManager, emailMgr *EmailManager) {
	hostname, _ := os.Hostname()
	srv := &HTTPServer{
		hostname: hostname,
		taskMgr:  taskMgr,
		aclMgr:   aclMgr,
		emailMgr: emailMgr,
	}

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req mcpRequest
		if err := json.Unmarshal(line, &req); err != nil {
			resp := mcpResponse{JSONRPC: "2.0", Error: &mcpError{Code: -32700, Message: "Parse error"}}
			data, _ := json.Marshal(resp)
			fmt.Println(string(data))
			continue
		}

		var resp mcpResponse
		resp.JSONRPC = "2.0"
		resp.ID = req.ID

		switch req.Method {
		case "initialize":
			resp.Result = map[string]interface{}{
				"protocolVersion": "2024-11-05",
				"capabilities":   map[string]interface{}{"tools": map[string]interface{}{}},
				"serverInfo":     map[string]interface{}{"name": "yaver", "version": version},
			}
		case "tools/list":
			// Reuse the same tool list from the HTTP handler
			resp.Result = srv.getMCPToolsList()
		case "tools/call":
			resp.Result = srv.handleMCPToolCall(req.Params)
		case "notifications/initialized":
			resp.Result = map[string]interface{}{}
		default:
			resp.Error = &mcpError{Code: -32601, Message: "Method not found: " + req.Method}
		}

		data, _ := json.Marshal(resp)
		fmt.Println(string(data))
	}
}

// ---------------------------------------------------------------------------
// email — Email connector setup and management
// ---------------------------------------------------------------------------

func runEmail(args []string) {
	if len(args) == 0 {
		fmt.Print(`Yaver Email — connect Office 365 or Gmail

Usage:
  yaver email setup     Interactive email setup
  yaver email test      Send a test email
  yaver email sync      Sync emails from provider to local database
  yaver email status    Show email configuration status
`)
		return
	}

	switch args[0] {
	case "setup":
		runEmailSetup()
	case "test":
		runEmailTest()
	case "sync":
		runEmailSync()
	case "status":
		runEmailStatus()
	default:
		fmt.Fprintf(os.Stderr, "Unknown email command: %s\n", args[0])
		os.Exit(1)
	}
}

func runEmailSetup() {
	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	fmt.Println("Email Provider Setup")
	fmt.Println()
	fmt.Println("  1. Office 365 (Microsoft Graph API)")
	fmt.Println("  2. Gmail (Google API)")
	fmt.Print("\nSelect provider (1 or 2): ")

	var choice string
	fmt.Scanln(&choice)

	if cfg.Email == nil {
		cfg.Email = &EmailConfig{}
	}

	switch choice {
	case "1":
		cfg.Email.Provider = "office365"
		fmt.Print("Azure Tenant ID: ")
		fmt.Scanln(&cfg.Email.AzureTenantID)
		fmt.Print("Azure Client ID: ")
		fmt.Scanln(&cfg.Email.AzureClientID)
		fmt.Print("Azure Client Secret: ")
		fmt.Scanln(&cfg.Email.AzureClientSecret)
		fmt.Print("Sender Email: ")
		fmt.Scanln(&cfg.Email.SenderEmail)
	case "2":
		cfg.Email.Provider = "gmail"
		fmt.Print("Google Client ID: ")
		fmt.Scanln(&cfg.Email.GoogleClientID)
		fmt.Print("Google Client Secret: ")
		fmt.Scanln(&cfg.Email.GoogleClientSecret)
		fmt.Print("Google Refresh Token: ")
		fmt.Scanln(&cfg.Email.GoogleRefreshToken)
		fmt.Print("Sender Email: ")
		fmt.Scanln(&cfg.Email.SenderEmail)
	default:
		fmt.Fprintln(os.Stderr, "Invalid choice.")
		os.Exit(1)
	}

	if err := SaveConfig(cfg); err != nil {
		log.Fatalf("save config: %v", err)
	}
	fmt.Printf("\nEmail configured: %s (%s)\n", cfg.Email.Provider, cfg.Email.SenderEmail)
	fmt.Println("Run 'yaver email test' to verify.")
}

func runEmailTest() {
	cfg, err := LoadConfig()
	if err != nil || cfg.Email == nil || cfg.Email.Provider == "" {
		fmt.Fprintln(os.Stderr, "Email not configured. Run 'yaver email setup' first.")
		os.Exit(1)
	}
	mgr, err := NewEmailManager(cfg.Email)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Email init failed: %v\n", err)
		os.Exit(1)
	}
	defer mgr.Close()

	fmt.Printf("Sending test email to %s...\n", cfg.Email.SenderEmail)
	if err := mgr.SendEmail(cfg.Email.SenderEmail, "Yaver Email Test", "This is a test email from Yaver.io email connector.", ""); err != nil {
		fmt.Fprintf(os.Stderr, "Send failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Test email sent successfully!")
}

func runEmailSync() {
	cfg, err := LoadConfig()
	if err != nil || cfg.Email == nil || cfg.Email.Provider == "" {
		fmt.Fprintln(os.Stderr, "Email not configured. Run 'yaver email setup' first.")
		os.Exit(1)
	}
	mgr, err := NewEmailManager(cfg.Email)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Email init failed: %v\n", err)
		os.Exit(1)
	}
	defer mgr.Close()

	fmt.Println("Syncing emails...")
	count, err := mgr.SyncEmails()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Sync failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Synced %d emails to local database.\n", count)
}

func runEmailStatus() {
	cfg, err := LoadConfig()
	if err != nil || cfg.Email == nil || cfg.Email.Provider == "" {
		fmt.Println("Email: not configured")
		fmt.Println("Run 'yaver email setup' to configure.")
		return
	}
	fmt.Printf("Email Provider: %s\n", cfg.Email.Provider)
	fmt.Printf("Sender: %s\n", cfg.Email.SenderEmail)
}

// ---------------------------------------------------------------------------
// acl — Agent Communication Layer
// ---------------------------------------------------------------------------

func runACL(args []string) {
	if len(args) == 0 {
		fmt.Print(`Yaver ACL — Agent Communication Layer

Connect to other MCP servers (local or remote) to extend Yaver's capabilities.

Usage:
  yaver acl add <name> <url> [--auth <token>]     Add HTTP MCP peer
  yaver acl add <name> --stdio "<command>"         Add stdio MCP peer
  yaver acl list                                    List connected peers
  yaver acl remove <id>                             Remove a peer
  yaver acl tools <id>                              List peer's available tools
  yaver acl health                                  Health check all peers

Examples:
  yaver acl add ollama http://localhost:11434/mcp
  yaver acl add filesystem --stdio "npx -y @modelcontextprotocol/server-filesystem /home"
  yaver acl add remote-db https://db.example.com/mcp --auth mytoken123
`)
		return
	}

	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	switch args[0] {
	case "add":
		if len(args) < 3 {
			fmt.Fprintln(os.Stderr, "Usage: yaver acl add <name> <url> [--auth <token>]")
			fmt.Fprintln(os.Stderr, "       yaver acl add <name> --stdio \"<command>\"")
			os.Exit(1)
		}
		name := args[1]
		peer := ACLPeerConfig{
			ID:   strings.ToLower(strings.ReplaceAll(name, " ", "-")),
			Name: name,
			Type: "http",
		}

		// Parse remaining args
		for i := 2; i < len(args); i++ {
			switch args[i] {
			case "--stdio":
				peer.Type = "stdio"
				if i+1 < len(args) {
					i++
					peer.Command = args[i]
				}
			case "--auth":
				if i+1 < len(args) {
					i++
					peer.Auth = args[i]
				}
			default:
				if peer.URL == "" && peer.Type == "http" {
					peer.URL = args[i]
				}
			}
		}

		cfg.ACLPeers = append(cfg.ACLPeers, peer)
		if err := SaveConfig(cfg); err != nil {
			log.Fatalf("save config: %v", err)
		}
		fmt.Printf("Added MCP peer: %s (%s)\n", name, func() string {
			if peer.Type == "stdio" {
				return "stdio: " + peer.Command
			}
			return peer.URL
		}())

	case "list":
		if len(cfg.ACLPeers) == 0 {
			fmt.Println("No MCP peers configured.")
			fmt.Println("Use 'yaver acl add' to connect to an MCP server.")
			return
		}
		for _, p := range cfg.ACLPeers {
			target := p.URL
			if p.Type == "stdio" {
				target = "stdio: " + p.Command
			}
			fmt.Printf("  [%s] %s — %s\n", p.ID, p.Name, target)
		}

	case "remove":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: yaver acl remove <id>")
			os.Exit(1)
		}
		id := args[1]
		var remaining []ACLPeerConfig
		found := false
		for _, p := range cfg.ACLPeers {
			if p.ID == id {
				found = true
				continue
			}
			remaining = append(remaining, p)
		}
		if !found {
			fmt.Fprintf(os.Stderr, "Peer not found: %s\n", id)
			os.Exit(1)
		}
		cfg.ACLPeers = remaining
		if err := SaveConfig(cfg); err != nil {
			log.Fatalf("save config: %v", err)
		}
		fmt.Printf("Removed peer: %s\n", id)

	case "tools":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: yaver acl tools <peer-id>")
			os.Exit(1)
		}
		aclMgr := NewACLManager(cfg.ACLPeers)
		defer aclMgr.Shutdown()
		tools, err := aclMgr.ListPeerTools(args[1])
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		for _, t := range tools {
			name, _ := t["name"].(string)
			desc, _ := t["description"].(string)
			fmt.Printf("  %s — %s\n", name, desc)
		}

	case "health":
		aclMgr := NewACLManager(cfg.ACLPeers)
		defer aclMgr.Shutdown()
		health := aclMgr.HealthCheck()
		for id, ok := range health {
			status := "healthy"
			if !ok {
				status = "unreachable"
			}
			fmt.Printf("  %s: %s\n", id, status)
		}

	default:
		fmt.Fprintf(os.Stderr, "Unknown ACL command: %s\n", args[0])
		os.Exit(1)
	}
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

// checkLatestVersion fetches the latest CLI version from Convex /config
// and prints an upgrade notice if a newer version is available.
func checkLatestVersion() {
	convexURL := defaultConvexSiteURL
	if cfg, err := LoadConfig(); err == nil && cfg.ConvexSiteURL != "" {
		convexURL = cfg.ConvexSiteURL
	}

	client := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequest("GET", convexURL+"/config", nil)
	if err != nil {
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return
	}

	var result struct {
		CliVersion    string `json:"cliVersion"`
		MobileVersion string `json:"mobileVersion"`
		RelayVersion  string `json:"relayVersion"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return
	}

	if result.CliVersion != "" && result.CliVersion != version {
		fmt.Printf("\nUpdate available: %s → %s\n", version, result.CliVersion)
		if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
			fmt.Println("  brew upgrade yaver")
		} else {
			fmt.Println("  scoop update yaver")
		}
	}
}
