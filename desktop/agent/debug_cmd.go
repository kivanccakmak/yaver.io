package main

import (
	"flag"
	"fmt"
	"os"
)

func runDebug(args []string) {
	if len(args) == 0 {
		printDebugUsage()
		os.Exit(0)
	}

	switch args[0] {
	case "flutter":
		runDebugFlutter(args[1:])
	case "rn":
		runDebugRN(args[1:])
	default:
		// Check for --port flag for generic port expose
		fs := flag.NewFlagSet("debug", flag.ExitOnError)
		port := fs.Int("port", 0, "Local TCP port to expose")
		dir := fs.String("dir", "", "Working directory")
		fs.Parse(args)

		if *port > 0 {
			runDebugGeneric(*port, *dir)
			return
		}

		fmt.Fprintf(os.Stderr, "Unknown debug target: %s\n\n", args[0])
		printDebugUsage()
		os.Exit(1)
	}
}

func printDebugUsage() {
	fmt.Print(`Usage:
  yaver debug flutter [--dir <path>]     Start Flutter debug session (exposes :9100)
  yaver debug rn [--dir <path>]          Start React Native/Metro (exposes :8081)
  yaver debug --port <N> [--dir <path>]  Expose any local TCP port for remote access

This starts your build tool, streams output, and creates a P2P tunnel
so your phone can connect to the debug port for hot reload.

On your phone, the installed dev build connects to localhost:<port>
which tunnels through Yaver to your dev machine — hot reload just works.
`)
}

func runDebugFlutter(args []string) {
	fs := flag.NewFlagSet("debug flutter", flag.ExitOnError)
	dir := fs.String("dir", "", "Flutter project directory")
	fs.Parse(args)

	// Start flutter run via build system
	body := map[string]interface{}{
		"platform": "custom",
		"workDir":  *dir,
		"args":     []string{"flutter run --machine"},
	}
	resp, err := localAgentRequest("POST", "/builds", body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error starting Flutter: %v\n", err)
		os.Exit(1)
	}

	var build Build
	remarshal(resp, &build)
	fmt.Printf("Flutter debug started (build %s)\n", build.ID)

	// Create tunnel for VM service port
	createTunnel(9100, "flutter")
	createTunnel(9101, "flutter") // fallback port

	fmt.Println()
	fmt.Println("Debug session active:")
	fmt.Printf("  Build output: yaver build status %s\n", build.ID)
	fmt.Println("  Tunnels: localhost:9100, localhost:9101 → your phone")
	fmt.Println("  Hot reload: phone sends 'r' via tunnel")
	fmt.Println()
	fmt.Println("Connect from Yaver mobile to see output and control the session.")
}

func runDebugRN(args []string) {
	fs := flag.NewFlagSet("debug rn", flag.ExitOnError)
	dir := fs.String("dir", "", "React Native project directory")
	fs.Parse(args)

	body := map[string]interface{}{
		"platform": "custom",
		"workDir":  *dir,
		"args":     []string{"npx react-native start"},
	}
	resp, err := localAgentRequest("POST", "/builds", body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error starting Metro: %v\n", err)
		os.Exit(1)
	}

	var build Build
	remarshal(resp, &build)
	fmt.Printf("Metro bundler started (build %s)\n", build.ID)

	// Create tunnel for Metro port
	createTunnel(8081, "rn-metro")

	fmt.Println()
	fmt.Println("Debug session active:")
	fmt.Printf("  Build output: yaver build status %s\n", build.ID)
	fmt.Println("  Tunnel: localhost:8081 → your phone")
	fmt.Println()
	fmt.Println("Connect from Yaver mobile to see output and control the session.")
}

func runDebugGeneric(port int, dir string) {
	createTunnel(port, "custom")
	fmt.Printf("Tunnel created: localhost:%d → your phone\n", port)
	fmt.Println("Connect from Yaver mobile to use this tunnel.")
}

func createTunnel(port int, protocol string) {
	body := map[string]interface{}{
		"port":     port,
		"protocol": protocol,
	}
	resp, err := localAgentRequest("POST", "/tunnels", body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not create tunnel for port %d: %v\n", port, err)
		return
	}

	var tunnel TunnelSession
	remarshal(resp, &tunnel)
	fmt.Printf("Tunnel %s: localhost:%d (%s)\n", tunnel.ID, port, protocol)
}
