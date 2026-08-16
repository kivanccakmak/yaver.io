package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
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
	case "deploy":
		runDeploy(os.Args[2:])
	case "list":
		runList(os.Args[2:])
	case "remove":
		runRemove(os.Args[2:])
	case "status":
		runStatus(os.Args[2:])
	case "set-password":
		runSetPassword(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Printf("yaver-mcp %s\n", version)
	case "help", "--help", "-h":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Print(`yaver-mcp — Open-source MCP server for Yaver

Usage:
  yaver-mcp serve          Start the MCP server
  yaver-mcp deploy <dir>   Deploy a plugin from a directory
  yaver-mcp list           List deployed plugins and their tools
  yaver-mcp remove <name>  Remove a deployed plugin
  yaver-mcp status         Show server status
  yaver-mcp set-password   Update the server password
  yaver-mcp version        Print version
  yaver-mcp help           Show this help

Serve flags:
  --http-port     HTTP port for MCP clients (default 18100)
  --password      Auth password (env: MCP_PASSWORD)
  --plugins-dir   Directory for deployed plugins (default ~/.yaver/mcp-plugins/)
  --work-dir      Working directory for file/git tools (default .)
  --mode          Transport mode: "http" or "stdio" (default "http")

Deploy flags:
  --server        Remote MCP server URL (default: http://localhost:18100)
  --password      Server password (env: MCP_PASSWORD)

The MCP server provides built-in tools (file ops, git, exec, web fetch, system info)
and supports user-deployed plugins for custom tools.

Plugins are MCP servers that communicate via stdio JSON-RPC. Any language works:
Go, Python, Node.js, Rust, etc. See plugins/example-hello/ for a template.
`)
}

func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	httpPort := fs.Int("http-port", 18100, "HTTP port for MCP clients")
	password := fs.String("password", "", "Auth password (env: MCP_PASSWORD)")
	pluginsDir := fs.String("plugins-dir", "", "Directory for plugins (default ~/.yaver/mcp-plugins/)")
	workDir := fs.String("work-dir", ".", "Working directory for file/git tools")
	mode := fs.String("mode", "http", "Transport mode: http or stdio")
	fs.Parse(args)

	pw := *password
	if pw == "" {
		pw = os.Getenv("MCP_PASSWORD")
	}
	if pw == "" {
		if data, err := os.ReadFile(".mcp-password"); err == nil {
			pw = strings.TrimSpace(string(data))
		}
	}

	pDir := *pluginsDir
	if pDir == "" {
		home, _ := os.UserHomeDir()
		pDir = home + "/.yaver/mcp-plugins"
	}
	os.MkdirAll(pDir, 0755)

	log.Printf("yaver-mcp %s starting...", version)
	log.Printf("  HTTP port:    %d", *httpPort)
	log.Printf("  Plugins dir:  %s", pDir)
	log.Printf("  Work dir:     %s", *workDir)
	if pw != "" {
		log.Printf("  Password:     enabled")
	} else {
		log.Printf("  Password:     disabled (open)")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		log.Printf("Received %s, shutting down...", sig)
		cancel()
	}()

	server := NewMCPServer(*httpPort, pw, pDir, *workDir)

	if *mode == "stdio" {
		if err := server.RunStdio(ctx); err != nil {
			log.Fatalf("stdio error: %v", err)
		}
	} else {
		if err := server.RunHTTP(ctx); err != nil {
			log.Fatalf("server error: %v", err)
		}
	}
}

func runDeploy(args []string) {
	fs := flag.NewFlagSet("deploy", flag.ExitOnError)
	serverURL := fs.String("server", "http://localhost:18100", "MCP server URL")
	password := fs.String("password", "", "Server password (env: MCP_PASSWORD)")
	fs.Parse(args)

	remaining := fs.Args()
	if len(remaining) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: yaver-mcp deploy <plugin-dir> [--server URL] [--password PW]")
		os.Exit(1)
	}

	pw := *password
	if pw == "" {
		pw = os.Getenv("MCP_PASSWORD")
	}

	if err := deployPlugin(remaining[0], *serverURL, pw); err != nil {
		fmt.Fprintf(os.Stderr, "Deploy failed: %v\n", err)
		os.Exit(1)
	}
}

func runList(args []string) {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	serverURL := fs.String("server", "http://localhost:18100", "MCP server URL")
	password := fs.String("password", "", "Server password (env: MCP_PASSWORD)")
	fs.Parse(args)

	pw := *password
	if pw == "" {
		pw = os.Getenv("MCP_PASSWORD")
	}

	if err := listPlugins(*serverURL, pw); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func runRemove(args []string) {
	fs := flag.NewFlagSet("remove", flag.ExitOnError)
	serverURL := fs.String("server", "http://localhost:18100", "MCP server URL")
	password := fs.String("password", "", "Server password (env: MCP_PASSWORD)")
	fs.Parse(args)

	remaining := fs.Args()
	if len(remaining) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: yaver-mcp remove <plugin-name>")
		os.Exit(1)
	}

	pw := *password
	if pw == "" {
		pw = os.Getenv("MCP_PASSWORD")
	}

	if err := removePlugin(remaining[0], *serverURL, pw); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func runStatus(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	port := fs.Int("port", 18100, "HTTP port to query")
	fs.Parse(args)

	if err := showStatus(*port); err != nil {
		fmt.Fprintf(os.Stderr, "MCP server is DOWN: %v\n", err)
		os.Exit(1)
	}
}

func runSetPassword(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: yaver-mcp set-password <new-password>")
		os.Exit(1)
	}
	if err := os.WriteFile(".mcp-password", []byte(args[0]+"\n"), 0600); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Password saved. Restart the server for the change to take effect.")
}
