// Example: Basic client — connect to agent, create task, stream output.
package main

import (
	"fmt"
	"log"
	"os"

	yaver "github.com/kivanccakmak/yaver.io/sdk/go/yaver"
)

func main() {
	url := os.Getenv("YAVER_URL")
	token := os.Getenv("YAVER_TOKEN")
	if url == "" || token == "" {
		log.Fatal("Set YAVER_URL and YAVER_TOKEN env vars")
	}

	client := yaver.NewClient(url, token)

	// Health check
	if err := client.Health(); err != nil {
		log.Fatalf("Agent unreachable: %v", err)
	}
	fmt.Println("Agent is healthy")

	// Agent info
	info, _ := client.Info()
	fmt.Printf("Connected to %s (v%s)\n", info.Hostname, info.Version)

	// Create task
	task, err := client.CreateTask("List all Go files in the current directory", nil)
	if err != nil {
		log.Fatalf("Create task failed: %v", err)
	}
	fmt.Printf("Task %s created (status: %s)\n\n", task.ID, task.Status)

	// Stream output
	for chunk := range client.StreamOutput(task.ID, 0) {
		fmt.Print(chunk)
	}

	// Get final result
	final, _ := client.GetTask(task.ID)
	fmt.Printf("\n\nTask %s finished (status: %s)\n", final.ID, final.Status)
}
