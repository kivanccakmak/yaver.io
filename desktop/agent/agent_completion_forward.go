package main

// agent_completion_forward.go implements the runner-only yaver_report_complete
// MCP tool. A clean process exit is merely a finished turn; this explicit call
// is the evidence required before a conversational task can enter Review.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func forwardYaverReportComplete(rawArgs json.RawMessage) interface{} {
	var args struct {
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal(rawArgs, &args); err != nil {
		return mcpToolError("invalid arguments: " + err.Error())
	}
	taskID := strings.TrimSpace(os.Getenv("YAVER_TASK_ID"))
	if taskID == "" {
		return mcpToolError("yaver_report_complete is only available inside a Yaver task (YAVER_TASK_ID not set)")
	}
	cfg, err := LoadConfig()
	if err != nil || cfg == nil || strings.TrimSpace(cfg.AuthToken) == "" {
		return mcpToolError("yaver_report_complete: not authenticated (run `yaver auth`)")
	}
	body, _ := json.Marshal(map[string]string{"summary": strings.TrimSpace(args.Summary)})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, localAgentBaseURL()+"/tasks/"+taskID+"/review-request", bytes.NewReader(body))
	if err != nil {
		return mcpToolError("build request: " + err.Error())
	}
	req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return mcpToolError(fmt.Sprintf("forward completion claim to daemon: %v", err))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return mcpToolError(fmt.Sprintf("daemon returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw))))
	}
	return mcpToolJSON(map[string]interface{}{
		"recorded": true,
		"taskId":   taskID,
		"hint":     "finish the current turn normally; Yaver will enter Review only if it exits successfully",
	})
}
