package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestACPElicitationUsesExistingCrossSurfaceQuestionRoute(t *testing.T) {
	task := newACPTestTask("elicitation")
	tm := NewTaskManager(t.TempDir(), nil, task.runner)

	resultCh := make(chan json.RawMessage, 1)
	errCh := make(chan *acpJSONRPCError, 1)
	go func() {
		result, rpcErr := tm.answerACPElicitation(context.Background(), task, json.RawMessage(`{
			"mode":"form", "message":"Choose the implementation strategy",
			"requestedSchema":{"type":"object","properties":{
				"strategy":{"type":"string","title":"Strategy","enum":["safe","fast"]}
			}}
		}`))
		resultCh <- result
		errCh <- rpcErr
	}()

	select {
	case event := <-task.eventCh:
		question, ok := event["question"].(AgentQuestion)
		if !ok || question.Kind != "choice" || len(question.Choices) != 2 {
			t.Fatalf("ACP form did not become a normal choice question: %#v", event)
		}
		if err := globalQuestionRegistry.Answer(question.ID, "safe"); err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ACP form did not reach the task question stream")
	}

	select {
	case rpcErr := <-errCh:
		if rpcErr != nil {
			t.Fatalf("unexpected RPC error: %v", rpcErr)
		}
		var got map[string]any
		if err := json.Unmarshal(<-resultCh, &got); err != nil {
			t.Fatal(err)
		}
		content, _ := got["content"].(map[string]any)
		if got["action"] != "accept" || content["strategy"] != "safe" {
			t.Fatalf("ACP acceptance = %#v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ACP elicitation did not receive user answer")
	}
}
