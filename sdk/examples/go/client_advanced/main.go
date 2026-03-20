// Example: Advanced client — auth, device discovery, task management, callbacks.
package main

import (
	"fmt"
	"log"
	"os"
	"time"

	yaver "github.com/kivanccakmak/yaver.io/sdk/go/yaver"
)

func main() {
	token := os.Getenv("YAVER_TOKEN")
	if token == "" {
		log.Fatal("Set YAVER_TOKEN env var")
	}

	// ── Auth: validate token, discover devices ──────────────────────
	auth := yaver.NewAuthClient("", token) // uses default Convex URL
	user, err := auth.ValidateToken()
	if err != nil {
		log.Fatalf("Token invalid: %v", err)
	}
	fmt.Printf("Authenticated as %s (%s)\n", user.Email, user.Provider)

	// List devices
	devices, err := auth.ListDevices()
	if err != nil {
		log.Fatalf("List devices failed: %v", err)
	}
	fmt.Printf("Found %d device(s):\n", len(devices))
	for _, d := range devices {
		status := "offline"
		if d.IsOnline {
			status = "online"
		}
		fmt.Printf("  %s — %s (%s) [%s]\n", d.DeviceID[:8], d.Name, d.Platform, status)
	}

	// Find first online device
	var target *yaver.Device
	for i := range devices {
		if devices[i].IsOnline {
			target = &devices[i]
			break
		}
	}
	if target == nil {
		log.Fatal("No online devices found")
	}

	// ── Connect to device ───────────────────────────────────────────
	// In a real app, you'd try direct connection first (LAN),
	// then fall back to relay. The SDK client uses HTTP, so it works
	// with any transport the agent is reachable through.
	agentURL := fmt.Sprintf("http://%s:%d", target.Host, target.Port)
	fmt.Printf("\nConnecting to %s at %s...\n", target.Name, agentURL)

	client := yaver.NewClient(agentURL, token)
	rtt, err := client.Ping()
	if err != nil {
		log.Fatalf("Cannot reach agent: %v", err)
	}
	fmt.Printf("Connected (RTT: %v)\n", rtt)

	// ── User settings ───────────────────────────────────────────────
	settings, _ := auth.GetSettings()
	fmt.Printf("Runner: %s, Verbosity: %v, TTS: %v\n",
		settings.RunnerID, settings.Verbosity, settings.TTSEnabled)

	// ── Task management ─────────────────────────────────────────────
	// Create task with verbosity
	v := 3
	task, err := client.CreateTask("What is the current git branch?", &yaver.CreateTaskOptions{
		SpeechContext: &yaver.SpeechContext{Verbosity: &v},
	})
	if err != nil {
		log.Fatalf("Create task failed: %v", err)
	}
	fmt.Printf("\nTask %s created\n", task.ID)

	// Poll with callback pattern
	pollWithCallback(client, task.ID, func(t *yaver.Task) {
		// Called on each poll — use for progress UI
		fmt.Printf("  [%s] output: %d chars\n", t.Status, len(t.Output))
	})

	// List all tasks
	tasks, _ := client.ListTasks()
	fmt.Printf("\nAll tasks (%d):\n", len(tasks))
	for _, t := range tasks {
		fmt.Printf("  %s — %s (%s)\n", t.ID, t.Title[:min(40, len(t.Title))], t.Status)
	}

	// Clean up
	client.DeleteTask(task.ID)
	fmt.Println("\nDone.")
}

// pollWithCallback demonstrates a callback-based polling pattern.
// In a real app, you'd use channels or event emitters.
func pollWithCallback(client *yaver.Client, taskID string, onUpdate func(*yaver.Task)) {
	for i := 0; i < 120; i++ {
		task, err := client.GetTask(taskID)
		if err != nil {
			break
		}
		onUpdate(task)
		if task.Status == "completed" || task.Status == "failed" || task.Status == "stopped" {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
