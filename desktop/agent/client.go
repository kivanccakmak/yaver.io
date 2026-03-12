package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
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
