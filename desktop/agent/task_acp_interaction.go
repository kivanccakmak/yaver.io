package main

// task_acp_interaction.go bridges ACP's structured human-input request to the
// existing Yaver question registry. The phone/web/CLI therefore keep one
// answer route regardless of whether a runner called yaver_ask_user over MCP
// or sent ACP elicitation directly.

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

type acpElicitationRequest struct {
	Mode            string `json:"mode"`
	Message         string `json:"message"`
	SessionID       string `json:"sessionId,omitempty"`
	RequestID       any    `json:"requestId,omitempty"`
	RequestedSchema struct {
		Type       string                            `json:"type"`
		Properties map[string]acpElicitationProperty `json:"properties"`
		Required   []string                          `json:"required,omitempty"`
	} `json:"requestedSchema"`
}

type acpElicitationProperty struct {
	Type        string                 `json:"type,omitempty"`
	Title       string                 `json:"title,omitempty"`
	Description string                 `json:"description,omitempty"`
	Enum        []json.RawMessage      `json:"enum,omitempty"`
	OneOf       []acpElicitationChoice `json:"oneOf,omitempty"`
	Default     json.RawMessage        `json:"default,omitempty"`
}

type acpElicitationChoice struct {
	Const       json.RawMessage `json:"const"`
	Title       string          `json:"title,omitempty"`
	Description string          `json:"description,omitempty"`
}

// acpTaskRequestHandler is installed only on a live task ACP client. Probe
// clients do not advertise elicitation support, so a runner cannot send a
// question to a connection that has no task/user to receive it.
func (tm *TaskManager) acpTaskRequestHandler(task *Task) acpRequestHandler {
	return func(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, *acpJSONRPCError) {
		switch method {
		case "elicitation/create":
			return tm.answerACPElicitation(ctx, task, params)
		default:
			return nil, &acpJSONRPCError{Code: -32601, Message: "unsupported ACP client request: " + method}
		}
	}
}

// answerACPElicitation supports ACP form mode. URL mode is intentionally not
// advertised: a coding runner must never make a phone open an arbitrary URL
// or carry a credential through model context. Runner OAuth continues through
// Yaver's dedicated, origin-checked headless login flow.
func (tm *TaskManager) answerACPElicitation(ctx context.Context, task *Task, raw json.RawMessage) (json.RawMessage, *acpJSONRPCError) {
	if tm == nil || task == nil || strings.TrimSpace(task.ID) == "" {
		return nil, &acpJSONRPCError{Code: -32602, Message: "task context is required for ACP elicitation"}
	}
	var request acpElicitationRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, &acpJSONRPCError{Code: -32602, Message: "invalid ACP elicitation request"}
	}
	if request.Mode != "form" {
		return nil, &acpJSONRPCError{Code: -32602, Message: "Yaver supports ACP form elicitation; runner OAuth uses Yaver sign-in"}
	}
	if request.RequestedSchema.Type != "object" || len(request.RequestedSchema.Properties) == 0 {
		return nil, &acpJSONRPCError{Code: -32602, Message: "ACP form must contain top-level object properties"}
	}

	// Map iteration is intentionally not UI order. Keep multi-field forms
	// stable across reconnects and platforms; one field is presented at a time
	// through the pre-existing single-question mobile sheet, so no TestFlight
	// release is needed to understand a future ACP form.
	keys := make([]string, 0, len(request.RequestedSchema.Properties))
	for key := range request.RequestedSchema.Properties {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	content := make(map[string]any, len(keys))
	for _, key := range keys {
		property := request.RequestedSchema.Properties[key]
		answer, cancelled, rpcErr := tm.askACPElicitationField(ctx, task, request.Message, key, property)
		if rpcErr != nil {
			return nil, rpcErr
		}
		if cancelled {
			return json.RawMessage(`{"action":"cancel"}`), nil
		}
		content[key] = answer
	}
	result, err := json.Marshal(map[string]any{"action": "accept", "content": content})
	if err != nil {
		return nil, &acpJSONRPCError{Code: -32603, Message: "encode ACP elicitation response"}
	}
	return result, nil
}

func (tm *TaskManager) askACPElicitationField(ctx context.Context, task *Task, message, key string, property acpElicitationProperty) (any, bool, *acpJSONRPCError) {
	prompt := strings.TrimSpace(message)
	title := strings.TrimSpace(property.Title)
	if title == "" {
		title = key
	}
	if prompt == "" {
		prompt = title
	} else if !strings.EqualFold(prompt, title) {
		prompt = title + "\n\n" + prompt
	}
	if description := strings.TrimSpace(property.Description); description != "" {
		prompt += "\n\n" + description
	}

	choices, choiceValues := acpElicitationChoices(property)
	kind := "text"
	if len(choices) > 0 {
		kind = "choice"
	}
	registered, answerCh, err := globalQuestionRegistry.Register(task.ID, AgentQuestion{
		Prompt: prompt, Header: "Runner input", Kind: kind, Choices: choices,
		TimeoutSec: maxQuestionTimeoutSec,
	})
	if err != nil {
		return nil, false, &acpJSONRPCError{Code: -32602, Message: err.Error()}
	}
	emitTaskEvent(task, map[string]interface{}{"type": "agent_question", "question": registered})

	select {
	case <-ctx.Done():
		globalQuestionRegistry.CancelTask(task.ID)
		return nil, true, nil
	case answer := <-answerCh:
		if IsCancelledAnswer(answer) {
			return nil, true, nil
		}
		return acpElicitationAnswer(answer, property, choiceValues), false, nil
	}
}

func acpElicitationChoices(property acpElicitationProperty) ([]string, map[string]any) {
	values := make(map[string]any)
	appendChoice := func(raw json.RawMessage) {
		if len(raw) == 0 {
			return
		}
		var value any
		if json.Unmarshal(raw, &value) != nil {
			return
		}
		label, ok := value.(string)
		if !ok {
			label = string(raw)
		}
		if _, exists := values[label]; !exists {
			values[label] = value
		}
	}
	for _, item := range property.Enum {
		appendChoice(item)
	}
	for _, item := range property.OneOf {
		appendChoice(item.Const)
	}
	choices := make([]string, 0, len(values))
	for label := range values {
		choices = append(choices, label)
	}
	sort.Strings(choices)
	return choices, values
}

func acpElicitationAnswer(answer string, property acpElicitationProperty, choices map[string]any) any {
	if value, ok := choices[answer]; ok {
		return value
	}
	if strings.TrimSpace(answer) == "" && len(property.Default) > 0 {
		var value any
		if json.Unmarshal(property.Default, &value) == nil {
			return value
		}
	}
	switch strings.ToLower(strings.TrimSpace(property.Type)) {
	case "boolean":
		return strings.EqualFold(strings.TrimSpace(answer), "true") || strings.EqualFold(strings.TrimSpace(answer), "yes")
	case "integer":
		if value, err := strconv.ParseInt(strings.TrimSpace(answer), 10, 64); err == nil {
			return value
		}
	case "number":
		if value, err := strconv.ParseFloat(strings.TrimSpace(answer), 64); err == nil {
			return value
		}
	}
	return answer
}
