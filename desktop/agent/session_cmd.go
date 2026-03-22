package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func runSession(args []string) {
	if len(args) == 0 {
		fmt.Println("Usage:")
		fmt.Println("  yaver session list                         List transferable sessions")
		fmt.Println("  yaver session transfer <taskId> --to <device>  Transfer to another device")
		fmt.Println("  yaver session export <taskId> [--output file]  Export to file")
		fmt.Println("  yaver session import [--input file]            Import from file")
		os.Exit(0)
	}

	switch args[0] {
	case "list":
		sessionList()
	case "transfer":
		sessionTransfer(args[1:])
	case "export":
		sessionExport(args[1:])
	case "import":
		sessionImportCmd(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "Unknown session subcommand: %s\n", args[0])
		os.Exit(1)
	}
}

func sessionList() {
	resp, err := localAgentRequest("GET", "/session/list", nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	sessions, _ := resp["sessions"].([]interface{})
	if len(sessions) == 0 {
		fmt.Println("No transferable sessions found.")
		return
	}

	fmt.Printf("%-10s %-10s %-40s %-10s %-6s %s\n", "TASK ID", "AGENT", "TITLE", "STATUS", "TURNS", "RESUMABLE")
	fmt.Println(strings.Repeat("-", 90))
	for _, s := range sessions {
		sess := s.(map[string]interface{})
		taskID := sess["taskId"].(string)
		if len(taskID) > 8 {
			taskID = taskID[:8]
		}
		title := sess["title"].(string)
		if len(title) > 38 {
			title = title[:38] + ".."
		}
		resumable := "no"
		if r, ok := sess["resumable"].(bool); ok && r {
			resumable = "yes"
		}
		turns := 0
		if t, ok := sess["turns"].(float64); ok {
			turns = int(t)
		}
		fmt.Printf("%-10s %-10s %-40s %-10s %-6d %s\n",
			taskID, sess["agentType"], title, sess["status"], turns, resumable)
	}
}

func sessionTransfer(args []string) {
	fs := flag.NewFlagSet("transfer", flag.ExitOnError)
	toDevice := fs.String("to", "", "Target device ID or hostname prefix")
	includeWorkspace := fs.Bool("workspace", false, "Include workspace files")
	workspaceMode := fs.String("mode", "git", "Workspace mode: none, git, tar")
	fs.Parse(args)

	if fs.NArg() == 0 || *toDevice == "" {
		fmt.Fprintln(os.Stderr, "Usage: yaver session transfer <taskId> --to <device> [--workspace] [--mode git|tar|none]")
		os.Exit(1)
	}
	taskID := fs.Arg(0)

	cfg := mustLoadAuthConfig()

	// Export from local agent
	fmt.Println("Exporting session...")
	exportResp, err := localAgentRequest("POST", "/session/export", map[string]interface{}{
		"taskId":           taskID,
		"includeWorkspace": *includeWorkspace,
		"workspaceMode":    *workspaceMode,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Export failed: %v\n", err)
		os.Exit(1)
	}
	if exportResp["ok"] != true {
		fmt.Fprintf(os.Stderr, "Export failed: %v\n", exportResp["error"])
		os.Exit(1)
	}

	bundle := exportResp["bundle"]
	bundleJSON, _ := json.Marshal(bundle)
	fmt.Printf("Exported session (%d bytes)\n", len(bundleJSON))

	// Resolve target device
	targetURL := resolveDeviceURL(cfg, *toDevice, true)

	// Import to target
	fmt.Printf("Transferring to %s...\n", *toDevice)
	importBody, _ := json.Marshal(map[string]interface{}{
		"bundle":   bundle,
		"gitClone": *workspaceMode == "git",
	})

	req, _ := http.NewRequest("POST", targetURL+"/session/import", strings.NewReader(string(importBody)))
	req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Transfer failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	var importResp map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&importResp)

	if importResp["ok"] != true {
		fmt.Fprintf(os.Stderr, "Import failed: %v\n", importResp["error"])
		os.Exit(1)
	}

	fmt.Printf("Transfer complete! Task ID on target: %s\n", importResp["taskId"])
	if warnings, ok := importResp["warnings"].([]interface{}); ok && len(warnings) > 0 {
		fmt.Println("Warnings:")
		for _, w := range warnings {
			fmt.Printf("  - %s\n", w)
		}
	}
}

func sessionExport(args []string) {
	fs := flag.NewFlagSet("export", flag.ExitOnError)
	output := fs.String("output", "", "Output file (default: stdout)")
	includeWorkspace := fs.Bool("workspace", false, "Include workspace files")
	workspaceMode := fs.String("mode", "git", "Workspace mode: none, git, tar")
	fs.Parse(args)

	if fs.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "Usage: yaver session export <taskId> [--output file] [--workspace] [--mode git|tar|none]")
		os.Exit(1)
	}
	taskID := fs.Arg(0)

	resp, err := localAgentRequest("POST", "/session/export", map[string]interface{}{
		"taskId":           taskID,
		"includeWorkspace": *includeWorkspace,
		"workspaceMode":    *workspaceMode,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if resp["ok"] != true {
		fmt.Fprintf(os.Stderr, "Export failed: %v\n", resp["error"])
		os.Exit(1)
	}

	data, _ := json.MarshalIndent(resp["bundle"], "", "  ")

	if *output != "" {
		if err := os.WriteFile(*output, data, 0600); err != nil {
			fmt.Fprintf(os.Stderr, "Write error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Exported to %s (%d bytes)\n", *output, len(data))
	} else {
		fmt.Println(string(data))
	}
}

func sessionImportCmd(args []string) {
	fs := flag.NewFlagSet("import", flag.ExitOnError)
	input := fs.String("input", "", "Input file (default: stdin)")
	workDir := fs.String("work-dir", "", "Target working directory")
	gitClone := fs.Bool("git-clone", false, "Clone git repo from bundle")
	fs.Parse(args)

	var data []byte
	var err error
	if *input != "" {
		data, err = os.ReadFile(*input)
	} else {
		data, err = io.ReadAll(os.Stdin)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "Read error: %v\n", err)
		os.Exit(1)
	}

	var bundle interface{}
	if err := json.Unmarshal(data, &bundle); err != nil {
		fmt.Fprintf(os.Stderr, "Invalid JSON: %v\n", err)
		os.Exit(1)
	}

	resp, err := localAgentRequest("POST", "/session/import", map[string]interface{}{
		"bundle":   bundle,
		"workDir":  *workDir,
		"gitClone": *gitClone,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Import error: %v\n", err)
		os.Exit(1)
	}
	if resp["ok"] != true {
		fmt.Fprintf(os.Stderr, "Import failed: %v\n", resp["error"])
		os.Exit(1)
	}

	fmt.Printf("Imported! Task ID: %s\n", resp["taskId"])
	if warnings, ok := resp["warnings"].([]interface{}); ok && len(warnings) > 0 {
		fmt.Println("Warnings:")
		for _, w := range warnings {
			fmt.Printf("  - %s\n", w)
		}
	}
}

// localAgentRequest makes an HTTP request to the local agent.
func localAgentRequest(method, path string, body map[string]interface{}) (map[string]interface{}, error) {
	cfg, err := LoadConfig()
	if err != nil || cfg.AuthToken == "" {
		return nil, fmt.Errorf("not authenticated — run 'yaver auth'")
	}

	var bodyReader io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		bodyReader = strings.NewReader(string(data))
	}
	req, err := http.NewRequest(method, "http://127.0.0.1:18080"+path, bodyReader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("agent not reachable: %v", err)
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	return result, nil
}
