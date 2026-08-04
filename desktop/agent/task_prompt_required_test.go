package main

// task_prompt_required_test.go — a task with no instruction must be REFUSED,
// never run.
//
// FOUND BY THE LOOP, 2026-08-04. The sfmg vibe arc dispatched
//
//	POST /tasks {"title":"…","input":"change the background to black", …}
//
// and `input` is a key this handler does not read — the prompt lives in
// `description` (or `userPrompt`). The request was accepted anyway, a REAL
// runner turn was spawned on an empty prompt, the model answered "Ready. What
// would you like me to do with sfmg?", and the task settled on **review** with
// the working tree untouched.
//
// `review` is a terminal state every surface polls for as "done", so the false
// green propagated everywhere at once — and it cost a metered LLM turn that the
// agent could have refused for free before starting anything.
//
// Two rules, both in CLAUDE.md, broken by one missing check:
//   * never report success for an operation that did not happen;
//   * never spend the user's compute on a request you can already see is empty.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func postTask(t *testing.T, srv *httptest.Server, body map[string]interface{}) (*http.Response, map[string]interface{}) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", srv.URL+"/tasks", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post task: %v", err)
	}
	var parsed map[string]interface{}
	_ = json.NewDecoder(res.Body).Decode(&parsed)
	res.Body.Close()
	return res, parsed
}

func startTaskTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	hs := NewHTTPServer(0, "test-token", "test-user", "test-device", "", "test-host", tm)
	mux := http.NewServeMux()
	mux.HandleFunc("/tasks", hs.auth(hs.handleTasks))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// TestCreateTask_RefusesAPromptlessBody is the regression. The body below is
// EXACTLY the one that burned a turn: a title, and the instruction under a key
// nothing reads.
func TestCreateTask_RefusesAPromptlessBody(t *testing.T) {
	srv := startTaskTestServer(t)

	res, body := postTask(t, srv, map[string]interface{}{
		"title":       "vibe loop: background to black",
		"input":       "change the background to black", // the key that is NOT read
		"projectName": "sfmg",
	})

	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 — accepting this spawns a runner turn on an empty prompt and then reports `review`", res.StatusCode)
	}
	if got := body["code"]; got != ReasonTaskPromptMissing {
		t.Errorf("code = %v, want %q", got, ReasonTaskPromptMissing)
	}
	// The refusal must NAME the keys the agent actually reads. A 400 saying only
	// "bad request" leaves the caller to guess, and guessing is what produced
	// the burnt turn in the first place.
	msg, _ := body["error"].(string)
	for _, want := range []string{"description", "userPrompt", "customCommand"} {
		if !bytesContains(msg, want) {
			t.Errorf("error message must name %q so the caller can fix it; got: %s", want, msg)
		}
	}
	gap, ok := body["capabilityGap"].(map[string]interface{})
	if !ok {
		t.Fatal("refusal carries no capabilityGap")
	}
	// CONSTRAINED, not fixable: only the caller has the missing text, so
	// offering a button here would be a button that cannot work.
	if gap["fix"] != nil {
		t.Error("a missing prompt has no route the surface could press — it must be a constraint, not a fix")
	}
	if c, _ := gap["constraint"].(string); c == "" {
		t.Error("a gap with no fix MUST carry a constraint, or it is a dead end with a sentence")
	}
}

// TestCreateTask_AcceptsEveryLegitimatePromptShape — the guard must not break
// the three bodies that are genuinely valid, or it trades one broken lane for
// three.
func TestCreateTask_AcceptsEveryLegitimatePromptShape(t *testing.T) {
	for _, tc := range []struct {
		name string
		body map[string]interface{}
	}{
		{"description", map[string]interface{}{"title": "t", "description": "make it black"}},
		{"userPrompt", map[string]interface{}{"title": "t", "userPrompt": "make it black"}},
		// customCommand runs a command, not a model — promptless by nature.
		{"customCommand", map[string]interface{}{"title": "t", "customCommand": "echo hi"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := startTaskTestServer(t)
			res, body := postTask(t, srv, tc.body)
			if res.StatusCode == http.StatusBadRequest {
				if got := body["code"]; got == ReasonTaskPromptMissing {
					t.Fatalf("%s is a valid prompt shape and must not be refused as promptless: %v", tc.name, body["error"])
				}
			}
		})
	}
}

// TestCreateTask_WhitespaceIsNotAPrompt — a body whose instruction is spaces or
// a newline is empty in every way that matters, and must not reach a runner.
func TestCreateTask_WhitespaceIsNotAPrompt(t *testing.T) {
	srv := startTaskTestServer(t)
	res, body := postTask(t, srv, map[string]interface{}{
		"title":       "t",
		"description": "   \n\t ",
	})
	if res.StatusCode != http.StatusBadRequest || body["code"] != ReasonTaskPromptMissing {
		t.Errorf("whitespace-only description must be refused, got %d %v", res.StatusCode, body["code"])
	}
}

func bytesContains(haystack, needle string) bool {
	return bytes.Contains([]byte(haystack), []byte(needle))
}
