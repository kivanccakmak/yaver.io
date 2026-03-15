package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// runAttach connects to the running yaver agent and provides an interactive
// terminal UI. Shows Claude output from all tasks (mobile or local), and
// accepts keyboard input to create new tasks. Like Claude Code's terminal
// but multiplexed with mobile input.
func runAttach(args []string) {
	cfg, err := LoadConfig()
	if err != nil || cfg.AuthToken == "" {
		fmt.Fprintln(os.Stderr, "Not signed in. Run 'yaver auth' first.")
		os.Exit(1)
	}

	// Check if agent is running
	pid, running := isAgentRunning()
	if !running {
		fmt.Fprintln(os.Stderr, "Agent is not running. Run 'yaver serve' or 'yaver auth' first.")
		os.Exit(1)
	}

	baseURL := "http://127.0.0.1:18080"

	// Verify connection
	info, err := attachGetInfo(baseURL, cfg.AuthToken)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Cannot connect to agent (PID %d): %v\n", pid, err)
		os.Exit(1)
	}

	// Header
	fmt.Printf("\033[1;35m╭─ Yaver Attach ─────────────────────────────────╮\033[0m\n")
	fmt.Printf("\033[1;35m│\033[0m  Host: %-40s\033[1;35m│\033[0m\n", info.Hostname)
	fmt.Printf("\033[1;35m│\033[0m  Dir:  %-40s\033[1;35m│\033[0m\n", truncateStr(info.WorkDir, 40))
	fmt.Printf("\033[1;35m│\033[0m  Ver:  %-40s\033[1;35m│\033[0m\n", info.Version)
	fmt.Printf("\033[1;35m╰────────────────────────────────────────────────╯\033[0m\n")
	fmt.Println()
	fmt.Println("  Type a prompt and press Enter to run a task.")
	fmt.Println("  Mobile tasks will appear here automatically.")
	fmt.Println("  Press Ctrl+C to detach.")
	fmt.Println()

	// Track known tasks to detect new ones
	knownTasks := make(map[string]bool)
	lastOutputLen := make(map[string]int)

	// Initial task fetch — populate known tasks
	if tasks, err := attachListTasks(baseURL, cfg.AuthToken); err == nil {
		for _, t := range tasks {
			knownTasks[t.ID] = true
			lastOutputLen[t.ID] = len(t.Output)
		}
	}

	// Signal handler
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// Input channel — read lines from stdin
	inputCh := make(chan string)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line != "" {
				inputCh <- line
			}
		}
	}()

	// Poll ticker
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	// Track which task we're actively streaming
	activeTask := ""

	printPrompt := func() {
		if activeTask == "" {
			fmt.Print("\033[1;35myaver>\033[0m ")
		}
	}

	printPrompt()

	for {
		select {
		case <-sigCh:
			fmt.Println("\n\nDetached from agent. Agent continues running in background.")
			return

		case input := <-inputCh:
			// Create a new task from keyboard input
			fmt.Printf("\n\033[1;36m⟩ %s\033[0m\n\n", input)
			taskID, err := attachCreateTask(baseURL, cfg.AuthToken, input)
			if err != nil {
				fmt.Printf("\033[31mError: %v\033[0m\n", err)
				printPrompt()
				continue
			}
			knownTasks[taskID] = true
			lastOutputLen[taskID] = 0
			activeTask = taskID

		case <-ticker.C:
			// Poll for task updates
			tasks, err := attachListTasks(baseURL, cfg.AuthToken)
			if err != nil {
				continue
			}

			for _, t := range tasks {
				// Detect new tasks from mobile
				if !knownTasks[t.ID] {
					knownTasks[t.ID] = true
					lastOutputLen[t.ID] = 0
					fmt.Printf("\n\033[1;33m📱 [mobile] %s\033[0m\n\n", t.Title)
					activeTask = t.ID
				}

				// Stream new output
				prevLen := lastOutputLen[t.ID]
				if len(t.Output) > prevLen {
					newOutput := t.Output[prevLen:]
					fmt.Print(newOutput)
					lastOutputLen[t.ID] = len(t.Output)
				}

				// Task finished
				if (t.Status == "completed" || t.Status == "failed" || t.Status == "stopped") && activeTask == t.ID {
					// Show result if we haven't already via output
					if t.ResultText != "" && len(t.Output) == 0 {
						fmt.Printf("\n%s\n", t.ResultText)
					}
					if t.Status == "failed" {
						fmt.Printf("\n\033[31m✗ Task failed\033[0m\n")
					} else if t.Status == "completed" {
						if t.CostUSD > 0 {
							fmt.Printf("\n\033[2m($%.4f)\033[0m\n", t.CostUSD)
						}
					}
					fmt.Println()
					activeTask = ""
					printPrompt()
				}
			}
		}
	}
}

// --- HTTP helpers for attach mode ---

type attachInfo struct {
	Hostname string `json:"hostname"`
	Version  string `json:"version"`
	WorkDir  string `json:"workDir"`
}

func attachGetInfo(baseURL, token string) (*attachInfo, error) {
	req, _ := http.NewRequest("GET", baseURL+"/info", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	var info attachInfo
	json.NewDecoder(resp.Body).Decode(&info)
	return &info, nil
}

func attachListTasks(baseURL, token string) ([]TaskInfo, error) {
	req, _ := http.NewRequest("GET", baseURL+"/tasks", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	var data struct {
		Tasks []TaskInfo `json:"tasks"`
	}
	body, _ := io.ReadAll(resp.Body)
	json.Unmarshal(body, &data)
	return data.Tasks, nil
}

func attachCreateTask(baseURL, token, prompt string) (string, error) {
	body := fmt.Sprintf(`{"title":%q,"description":""}`, prompt)
	req, _ := http.NewRequest("POST", baseURL+"/tasks", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		var errData struct{ Error string `json:"error"` }
		json.Unmarshal(respBody, &errData)
		if errData.Error != "" {
			return "", fmt.Errorf("%s", errData.Error)
		}
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}
	var data struct {
		TaskID string `json:"taskId"`
	}
	json.NewDecoder(resp.Body).Decode(&data)
	return data.TaskID, nil
}

func truncateStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return "..." + s[len(s)-max+3:]
}
