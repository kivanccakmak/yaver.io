package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/quic-go/quic-go"
)

// RunClient connects to a remote Yaver agent over QUIC and provides an
// interactive terminal to submit tasks and stream output.
func RunClient(ctx context.Context, host string, port int, token string) error {
	addr := fmt.Sprintf("%s:%d", host, port)
	log.Printf("Connecting to %s...", addr)

	tlsCfg := &tls.Config{
		InsecureSkipVerify: true, // Self-signed cert on agent
		NextProtos:         []string{"yaver-p2p"},
	}

	conn, err := quic.DialAddr(ctx, addr, tlsCfg, &quic.Config{
		MaxIdleTimeout:  60 * time.Second,
		KeepAlivePeriod: 15 * time.Second,
	})
	if err != nil {
		return fmt.Errorf("connect to %s: %w", addr, err)
	}
	defer conn.CloseWithError(0, "bye")

	// Authenticate
	deviceName, err := clientAuth(ctx, conn, token)
	if err != nil {
		return fmt.Errorf("authentication failed: %w", err)
	}
	fmt.Printf("Connected to %s\n\n", deviceName)

	// Load speech config for voice commands
	clientCfg, _ := LoadConfig()
	var speechCfg *SpeechConfig
	if clientCfg != nil {
		speechCfg = clientCfg.Speech
	}

	// Interactive loop
	reader := bufio.NewReader(os.Stdin)

	for {
		fmt.Print("yaver> ")
		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				fmt.Println()
				return nil
			}
			return fmt.Errorf("read input: %w", err)
		}

		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		// Built-in commands
		switch {
		case line == "exit" || line == "quit":
			return nil
		case line == "help":
			printHelp()
			continue
		case line == "tasks" || line == "list":
			if err := clientListTasks(ctx, conn); err != nil {
				fmt.Printf("error: %v\n", err)
			}
			continue
		case line == "voice" || line == "/voice":
			// Record and transcribe voice input
			if speechCfg == nil || speechCfg.Provider == "" {
				fmt.Println("Speech not configured. Run: yaver config set speech.provider <whisper|openai|deepgram|assemblyai>")
				continue
			}
			audioPath, err := RecordAudio("")
			if err != nil {
				fmt.Printf("Recording error: %v\n", err)
				continue
			}
			defer os.Remove(audioPath)
			fmt.Print("Transcribing... ")
			text, err := TranscribeAudio(audioPath, speechCfg)
			if err != nil {
				fmt.Printf("\nTranscription error: %v\n", err)
				continue
			}
			fmt.Printf("\n> %s\n", text)
			os.Remove(audioPath)
			if text == "" {
				fmt.Println("(empty transcription, skipping)")
				continue
			}
			if err := clientCreateTask(ctx, conn, text); err != nil {
				fmt.Printf("error: %v\n", err)
			}
			continue
		case strings.HasPrefix(line, "stop "):
			taskID := strings.TrimPrefix(line, "stop ")
			if err := clientStopTask(ctx, conn, strings.TrimSpace(taskID)); err != nil {
				fmt.Printf("error: %v\n", err)
			}
			continue
		case strings.HasPrefix(line, "continue "):
			parts := strings.SplitN(line, " ", 3)
			if len(parts) < 3 {
				fmt.Println("usage: continue <taskId> <message>")
				continue
			}
			if err := clientContinueTask(ctx, conn, parts[1], parts[2]); err != nil {
				fmt.Printf("error: %v\n", err)
			}
			continue
		}

		// Default: create a new task
		if err := clientCreateTask(ctx, conn, line); err != nil {
			fmt.Printf("error: %v\n", err)
		}
	}
}

func printHelp() {
	fmt.Println(`Commands:
  <prompt>                Submit a task to Claude
  voice / /voice          Record voice and submit as task
  tasks / list            List all tasks
  stop <taskId>           Stop a running task
  continue <id> <msg>     Continue a task with a follow-up
  help                    Show this help
  exit / quit             Disconnect`)
}

// clientAuth sends an auth message and waits for auth_ok.
func clientAuth(ctx context.Context, conn quic.Connection, token string) (string, error) {
	msg := IncomingMessage{Type: "auth", Token: token}
	resp, err := clientRPC(ctx, conn, msg)
	if err != nil {
		return "", err
	}
	if resp.Type == "error" {
		return "", fmt.Errorf("%s", resp.Message)
	}
	return resp.DeviceName, nil
}

// clientCreateTask sends a task and streams the output.
func clientCreateTask(ctx context.Context, conn quic.Connection, prompt string) error {
	stream, err := conn.OpenStreamSync(ctx)
	if err != nil {
		return fmt.Errorf("open stream: %w", err)
	}

	msg := IncomingMessage{
		Type:        "task_create",
		Title:       prompt,
		Description: prompt,
		Source:      "cli",
	}

	data, _ := json.Marshal(msg)
	stream.Write(data)
	stream.Close() // signal we're done writing

	// Read streamed output
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)

	for scanner.Scan() {
		var resp OutgoingMessage
		if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
			continue
		}

		switch resp.Type {
		case "task_created":
			fmt.Printf("[task %s] created\n", resp.TaskID)
		case "task_output":
			if resp.Text != "" {
				fmt.Print(resp.Text)
			}
			if resp.Final {
				fmt.Println()
				return nil
			}
		case "error":
			return fmt.Errorf("%s", resp.Message)
		}
	}

	return scanner.Err()
}

// clientListTasks lists all tasks on the remote agent.
func clientListTasks(ctx context.Context, conn quic.Connection) error {
	resp, err := clientRPC(ctx, conn, IncomingMessage{Type: "task_list"})
	if err != nil {
		return err
	}
	if resp.Type == "error" {
		return fmt.Errorf("%s", resp.Message)
	}
	if len(resp.Tasks) == 0 {
		fmt.Println("No tasks.")
		return nil
	}
	for _, t := range resp.Tasks {
		fmt.Printf("  %s  %-10s  %s\n", t.ID, t.Status, t.Title)
	}
	return nil
}

// clientStopTask stops a task by ID.
func clientStopTask(ctx context.Context, conn quic.Connection, taskID string) error {
	resp, err := clientRPC(ctx, conn, IncomingMessage{Type: "task_stop", TaskID: taskID})
	if err != nil {
		return err
	}
	if resp.Type == "error" {
		return fmt.Errorf("%s", resp.Message)
	}
	fmt.Printf("Task %s stopped.\n", taskID)
	return nil
}

// clientContinueTask continues a task with follow-up input.
func clientContinueTask(ctx context.Context, conn quic.Connection, taskID, input string) error {
	stream, err := conn.OpenStreamSync(ctx)
	if err != nil {
		return fmt.Errorf("open stream: %w", err)
	}

	msg := IncomingMessage{
		Type:   "task_continue",
		TaskID: taskID,
		Input:  input,
	}

	data, _ := json.Marshal(msg)
	stream.Write(data)
	stream.Close()

	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)

	for scanner.Scan() {
		var resp OutgoingMessage
		if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
			continue
		}

		switch resp.Type {
		case "task_created":
			fmt.Printf("[task %s] resumed\n", resp.TaskID)
		case "task_output":
			if resp.Text != "" {
				fmt.Print(resp.Text)
			}
			if resp.Final {
				fmt.Println()
				return nil
			}
		case "error":
			return fmt.Errorf("%s", resp.Message)
		}
	}

	return scanner.Err()
}

// RunClientHTTP connects to a remote Yaver agent over HTTP (via relay or direct)
// and provides the same interactive terminal as RunClient.
func RunClientHTTP(ctx context.Context, baseURL string, token string) error {
	log.Printf("Connecting via HTTP to %s...", baseURL)

	client := &http.Client{Timeout: 30 * time.Second}
	authHeader := "Bearer " + token

	// Health check to verify connectivity
	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/health", nil)
	if err != nil {
		return fmt.Errorf("build health request: %w", err)
	}
	req.Header.Set("Authorization", authHeader)
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("agent unreachable at %s: %w", baseURL, err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("agent health check failed: HTTP %d", resp.StatusCode)
	}

	// Get agent info
	req, _ = http.NewRequestWithContext(ctx, "GET", baseURL+"/info", nil)
	req.Header.Set("Authorization", authHeader)
	resp, err = client.Do(req)
	if err == nil && resp.StatusCode == 200 {
		var info struct {
			Hostname string `json:"hostname"`
			Version  string `json:"version"`
			WorkDir  string `json:"workDir"`
		}
		json.NewDecoder(resp.Body).Decode(&info)
		resp.Body.Close()
		fmt.Printf("Connected to %s (v%s) via relay\n\n", info.Hostname, info.Version)
	} else {
		if resp != nil {
			resp.Body.Close()
		}
		fmt.Printf("Connected via relay\n\n")
	}

	// Interactive loop
	reader := bufio.NewReader(os.Stdin)

	for {
		fmt.Print("yaver> ")
		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				fmt.Println()
				return nil
			}
			return fmt.Errorf("read input: %w", err)
		}

		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		switch {
		case line == "exit" || line == "quit":
			return nil
		case line == "help":
			printHelp()
			continue
		case line == "tasks" || line == "list":
			if err := httpListTasks(ctx, client, baseURL, authHeader); err != nil {
				fmt.Printf("error: %v\n", err)
			}
			continue
		case strings.HasPrefix(line, "stop "):
			taskID := strings.TrimSpace(strings.TrimPrefix(line, "stop "))
			if err := httpStopTask(ctx, client, baseURL, authHeader, taskID); err != nil {
				fmt.Printf("error: %v\n", err)
			}
			continue
		case strings.HasPrefix(line, "continue "):
			parts := strings.SplitN(line, " ", 3)
			if len(parts) < 3 {
				fmt.Println("usage: continue <taskId> <message>")
				continue
			}
			if err := httpContinueTask(ctx, client, baseURL, authHeader, parts[1], parts[2]); err != nil {
				fmt.Printf("error: %v\n", err)
			}
			continue
		}

		// Default: create a new task
		if err := httpCreateTask(ctx, client, baseURL, authHeader, line); err != nil {
			fmt.Printf("error: %v\n", err)
		}
	}
}

func httpCreateTask(ctx context.Context, client *http.Client, baseURL, authHeader, prompt string) error {
	body, _ := json.Marshal(map[string]string{
		"title":       prompt,
		"description": prompt,
	})
	req, _ := http.NewRequestWithContext(ctx, "POST", baseURL+"/tasks", bytes.NewReader(body))
	req.Header.Set("Authorization", authHeader)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("create task: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		OK     bool   `json:"ok"`
		TaskID string `json:"taskId"`
		Error  string `json:"error"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	if !result.OK {
		return fmt.Errorf("create task: %s", result.Error)
	}

	fmt.Printf("[task %s] created\n", result.TaskID)

	// Stream output via SSE
	sseClient := &http.Client{Timeout: 10 * time.Minute}
	sseReq, _ := http.NewRequestWithContext(ctx, "GET", baseURL+"/tasks/"+result.TaskID+"/output", nil)
	sseReq.Header.Set("Authorization", authHeader)

	sseResp, err := sseClient.Do(sseReq)
	if err != nil {
		return fmt.Errorf("stream output: %w", err)
	}
	defer sseResp.Body.Close()

	scanner := bufio.NewScanner(sseResp.Body)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		var event struct {
			Type   string `json:"type"`
			Text   string `json:"text"`
			Status string `json:"status"`
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		switch event.Type {
		case "output":
			fmt.Print(event.Text)
		case "done":
			fmt.Println()
			return nil
		}
	}
	return scanner.Err()
}

func httpListTasks(ctx context.Context, client *http.Client, baseURL, authHeader string) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", baseURL+"/tasks", nil)
	req.Header.Set("Authorization", authHeader)

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var result struct {
		Tasks []struct {
			ID     string `json:"id"`
			Title  string `json:"title"`
			Status string `json:"status"`
		} `json:"tasks"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	if len(result.Tasks) == 0 {
		fmt.Println("No tasks.")
		return nil
	}
	for _, t := range result.Tasks {
		fmt.Printf("  %s  %-10s  %s\n", t.ID, t.Status, t.Title)
	}
	return nil
}

func httpStopTask(ctx context.Context, client *http.Client, baseURL, authHeader, taskID string) error {
	req, _ := http.NewRequestWithContext(ctx, "POST", baseURL+"/tasks/"+taskID+"/stop", nil)
	req.Header.Set("Authorization", authHeader)

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("stop failed: HTTP %d", resp.StatusCode)
	}
	fmt.Printf("Task %s stopped.\n", taskID)
	return nil
}

func httpContinueTask(ctx context.Context, client *http.Client, baseURL, authHeader, taskID, input string) error {
	body, _ := json.Marshal(map[string]string{"input": input})
	req, _ := http.NewRequestWithContext(ctx, "POST", baseURL+"/tasks/"+taskID+"/continue", bytes.NewReader(body))
	req.Header.Set("Authorization", authHeader)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var result struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	json.NewDecoder(resp.Body).Decode(&result)
	if !result.OK {
		return fmt.Errorf("continue: %s", result.Error)
	}

	fmt.Printf("[task %s] resumed\n", taskID)

	// Stream output
	sseClient := &http.Client{Timeout: 10 * time.Minute}
	sseReq, _ := http.NewRequestWithContext(ctx, "GET", baseURL+"/tasks/"+taskID+"/output", nil)
	sseReq.Header.Set("Authorization", authHeader)

	sseResp, err := sseClient.Do(sseReq)
	if err != nil {
		return fmt.Errorf("stream output: %w", err)
	}
	defer sseResp.Body.Close()

	scanner := bufio.NewScanner(sseResp.Body)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		var event struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		switch event.Type {
		case "output":
			fmt.Print(event.Text)
		case "done":
			fmt.Println()
			return nil
		}
	}
	return scanner.Err()
}

// clientRPC sends a single message and reads one response (non-streaming).
func clientRPC(ctx context.Context, conn quic.Connection, msg IncomingMessage) (OutgoingMessage, error) {
	stream, err := conn.OpenStreamSync(ctx)
	if err != nil {
		return OutgoingMessage{}, fmt.Errorf("open stream: %w", err)
	}
	defer stream.Close()

	data, _ := json.Marshal(msg)
	if _, err := stream.Write(data); err != nil {
		return OutgoingMessage{}, fmt.Errorf("write: %w", err)
	}
	// Close write side to signal we're done
	stream.Close()

	respData, err := io.ReadAll(io.LimitReader(stream, 1<<20))
	if err != nil {
		return OutgoingMessage{}, fmt.Errorf("read response: %w", err)
	}

	// Response may contain multiple newline-delimited JSON objects; take the first
	lines := strings.SplitN(string(respData), "\n", 2)
	if len(lines) == 0 || lines[0] == "" {
		return OutgoingMessage{}, fmt.Errorf("empty response")
	}

	var resp OutgoingMessage
	if err := json.Unmarshal([]byte(lines[0]), &resp); err != nil {
		return OutgoingMessage{}, fmt.Errorf("parse response: %w", err)
	}
	return resp, nil
}
