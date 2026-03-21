// Package yaver provides a Go SDK for embedding Yaver's P2P connectivity
// into your own applications. Supports connecting to Yaver agents, creating
// tasks, streaming output, speech-to-text, and device management.
//
// Quick start:
//
//	client := yaver.NewClient("http://localhost:18080", "your-auth-token")
//	task, _ := client.CreateTask("Fix the login bug", nil)
//	for line := range client.StreamOutput(task.ID) {
//	    fmt.Println(line)
//	}
package yaver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client connects to a Yaver agent's HTTP API.
type Client struct {
	BaseURL    string
	AuthToken  string
	HTTPClient *http.Client
}

// NewClient creates a new Yaver client.
func NewClient(baseURL, authToken string) *Client {
	return &Client{
		BaseURL:   baseURL,
		AuthToken: authToken,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Task represents a task on the remote agent.
type Task struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Status      string     `json:"status"` // "queued", "running", "completed", "failed", "stopped"
	RunnerID    string     `json:"runnerId,omitempty"`
	SessionID   string     `json:"sessionId,omitempty"`
	Output      string     `json:"output,omitempty"`
	ResultText  string     `json:"resultText,omitempty"`
	CostUSD     float64    `json:"costUsd,omitempty"`
	Turns       []Turn     `json:"turns,omitempty"`
	Source      string     `json:"source,omitempty"`
	TmuxSession string     `json:"tmuxSession,omitempty"`
	IsAdopted   bool       `json:"isAdopted,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	StartedAt   *time.Time `json:"startedAt,omitempty"`
	FinishedAt  *time.Time `json:"finishedAt,omitempty"`
}

// Turn represents a conversation turn.
type Turn struct {
	Role      string    `json:"role"` // "user" or "assistant"
	Content   string    `json:"content"`
	Timestamp time.Time `json:"timestamp,omitempty"`
}

// ImageAttachment represents a base64-encoded image to attach to a task.
type ImageAttachment struct {
	Base64   string `json:"base64"`
	MimeType string `json:"mimeType"`
	Filename string `json:"filename"`
}

// CreateTaskOptions configures task creation.
type CreateTaskOptions struct {
	Model         string            `json:"model,omitempty"`
	Runner        string            `json:"runner,omitempty"`
	CustomCommand string            `json:"customCommand,omitempty"`
	SpeechContext *SpeechContext     `json:"speechContext,omitempty"`
	Images        []ImageAttachment `json:"images,omitempty"`
}

// SpeechContext carries voice input/output preferences.
type SpeechContext struct {
	InputFromSpeech bool   `json:"inputFromSpeech"`
	STTProvider     string `json:"sttProvider,omitempty"`
	TTSEnabled      bool   `json:"ttsEnabled"`
	Verbosity       *int   `json:"verbosity,omitempty"`
}

// AgentInfo contains status information about the remote agent.
type AgentInfo struct {
	OK           bool   `json:"ok"`
	Hostname     string `json:"hostname"`
	Version      string `json:"version"`
	WorkDir      string `json:"workDir,omitempty"`
	Platform     string `json:"platform,omitempty"`
	RunningTasks int    `json:"runningTasks,omitempty"`
	TotalTasks   int    `json:"totalTasks,omitempty"`
}

// CreateTask creates a new task on the remote agent.
func (c *Client) CreateTask(prompt string, opts *CreateTaskOptions) (*Task, error) {
	body := map[string]interface{}{
		"title": prompt,
	}
	if opts != nil {
		if opts.Model != "" {
			body["model"] = opts.Model
		}
		if opts.Runner != "" {
			body["runner"] = opts.Runner
		}
		if opts.CustomCommand != "" {
			body["customCommand"] = opts.CustomCommand
		}
		if opts.SpeechContext != nil {
			body["speechContext"] = opts.SpeechContext
		}
		if len(opts.Images) > 0 {
			body["images"] = opts.Images
		}
	}

	var result struct {
		OK       bool   `json:"ok"`
		TaskID   string `json:"taskId"`
		Status   string `json:"status"`
		RunnerID string `json:"runnerId"`
		Error    string `json:"error"`
	}

	if err := c.post("/tasks", body, &result); err != nil {
		return nil, err
	}
	if !result.OK {
		return nil, fmt.Errorf("create task failed: %s", result.Error)
	}

	return &Task{
		ID:       result.TaskID,
		Title:    prompt,
		Status:   result.Status,
		RunnerID: result.RunnerID,
	}, nil
}

// GetTask retrieves a task by ID.
func (c *Client) GetTask(taskID string) (*Task, error) {
	var result struct {
		OK   bool `json:"ok"`
		Task Task `json:"task"`
	}
	if err := c.get("/tasks/"+taskID, &result); err != nil {
		return nil, err
	}
	return &result.Task, nil
}

// ListTasks returns all tasks.
func (c *Client) ListTasks() ([]Task, error) {
	var result struct {
		OK    bool   `json:"ok"`
		Tasks []Task `json:"tasks"`
	}
	if err := c.get("/tasks", &result); err != nil {
		return nil, err
	}
	return result.Tasks, nil
}

// StopTask stops a running task.
func (c *Client) StopTask(taskID string) error {
	var result struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := c.post("/tasks/"+taskID+"/stop", nil, &result); err != nil {
		return err
	}
	if !result.OK {
		return fmt.Errorf("stop task failed: %s", result.Error)
	}
	return nil
}

// DeleteTask deletes a task.
func (c *Client) DeleteTask(taskID string) error {
	return c.delete("/tasks/" + taskID)
}

// ContinueTask sends a follow-up message to a running task.
func (c *Client) ContinueTask(taskID, message string, images []ImageAttachment) error {
	var result struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	body := map[string]interface{}{"input": message}
	if len(images) > 0 {
		body["images"] = images
	}
	if err := c.post("/tasks/"+taskID+"/continue", body, &result); err != nil {
		return err
	}
	if !result.OK {
		return fmt.Errorf("continue task failed: %s", result.Error)
	}
	return nil
}

// CleanResult contains the outcome of a cleanup operation.
type CleanResult struct {
	TasksRemoved  int   `json:"tasksRemoved"`
	ImagesRemoved int   `json:"imagesRemoved"`
	BytesFreed    int64 `json:"bytesFreed"`
}

// Clean removes old tasks, images, and logs from the agent.
func (c *Client) Clean(days int) (*CleanResult, error) {
	var result struct {
		OK     bool        `json:"ok"`
		Result CleanResult `json:"result"`
	}
	if err := c.post("/agent/clean", map[string]interface{}{"days": days}, &result); err != nil {
		return nil, err
	}
	return &result.Result, nil
}

// StreamOutput polls a task's output and sends lines to the returned channel.
// The channel is closed when the task completes.
func (c *Client) StreamOutput(taskID string, pollInterval time.Duration) <-chan string {
	if pollInterval == 0 {
		pollInterval = 500 * time.Millisecond
	}
	ch := make(chan string, 64)
	go func() {
		defer close(ch)
		lastLen := 0
		for {
			task, err := c.GetTask(taskID)
			if err != nil {
				return
			}
			output := task.Output
			if len(output) > lastLen {
				ch <- output[lastLen:]
				lastLen = len(output)
			}
			if task.Status == "completed" || task.Status == "failed" || task.Status == "stopped" {
				return
			}
			time.Sleep(pollInterval)
		}
	}()
	return ch
}

// Health checks if the agent is reachable.
func (c *Client) Health() error {
	var result struct {
		Status string `json:"status"`
	}
	return c.get("/health", &result)
}

// Info returns agent status information.
func (c *Client) Info() (*AgentInfo, error) {
	var result AgentInfo
	if err := c.get("/info", &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// AgentInfoRaw is the raw response from /info for advanced use.
type AgentInfoRaw = map[string]interface{}

// Ping measures round-trip time to the agent.
func (c *Client) Ping() (time.Duration, error) {
	start := time.Now()
	if err := c.Health(); err != nil {
		return 0, err
	}
	return time.Since(start), nil
}

// ── HTTP helpers ─────────────────────────────────────────────────────

func (c *Client) get(path string, result interface{}) error {
	req, err := http.NewRequest("GET", c.BaseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.AuthToken)
	return c.doRequest(req, result)
}

func (c *Client) post(path string, body interface{}, result interface{}) error {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(data)
	}
	req, err := http.NewRequest("POST", c.BaseURL+path, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.AuthToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.doRequest(req, result)
}

func (c *Client) delete(path string) error {
	req, err := http.NewRequest("DELETE", c.BaseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.AuthToken)
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func (c *Client) doRequest(req *http.Request, result interface{}) error {
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}

	if result != nil {
		if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}
