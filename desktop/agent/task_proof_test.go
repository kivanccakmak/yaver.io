package main

// task_proof_test.go — guards for the proof package, each proven by its
// negative control (a guard nobody has seen fail is a guess):
//   - proof-required + no clip  ⇒ a NAMED failure record, never silence
//   - review counts as success  ⇒ mobile-sourced tasks get proofs (B1)
//   - persistence round-trip    ⇒ a restart no longer orphans clip/proof
//     links (B2)
//   - webm ingest routing       ⇒ web-SDK recordings link into the
//     report instead of orphaning on disk (B6)
//   - JSON data-URI ingest      ⇒ the kt/swift report shape stores media

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func testTaskForProof(status TaskStatus) *Task {
	now := time.Now()
	started := now.Add(-90 * time.Second)
	return &Task{
		ID:           "abcd1234",
		Title:        "Fix the login crash",
		Description:  "App crashes on login with empty password",
		Status:       status,
		ResultText:   "Fixed by guarding the empty-password path.",
		VideoEnabled: true,
		StartedAt:    &started,
		FinishedAt:   &now,
	}
}

func TestBuildTaskProof_NoClipIsNamedFailure(t *testing.T) {
	t.Setenv("YAVER_CONFIG_DIR", t.TempDir())
	task := testTaskForProof(TaskStatusFinished)

	BuildTaskProof(task, nil)

	proof, ok := loadTaskProof(task.ID)
	if !ok {
		t.Fatal("proof-enabled completed task produced no proof record")
	}
	if proof.Status != "failed" {
		t.Fatalf("no clip was captured, want status=failed, got %q", proof.Status)
	}
	if proof.FailedReason == "" || proof.FailedRoute == "" {
		t.Fatalf("proof failure must carry a named reason + route, got reason=%q route=%q",
			proof.FailedReason, proof.FailedRoute)
	}
	if proof.SummaryMarkdown == "" {
		t.Fatal("proof must carry the narrative markdown even on capture failure")
	}
}

func TestBuildTaskProof_ToggleOffMeansNoWork(t *testing.T) {
	t.Setenv("YAVER_CONFIG_DIR", t.TempDir())
	task := testTaskForProof(TaskStatusFinished)
	task.VideoEnabled = false // negative control

	BuildTaskProof(task, nil)

	if _, ok := loadTaskProof(task.ID); ok {
		t.Fatal("toggle OFF must mean zero proof work — a record was written anyway")
	}
}

func TestBuildTaskProof_ReviewCountsAsSuccess(t *testing.T) {
	t.Setenv("YAVER_CONFIG_DIR", t.TempDir())
	// Mobile-sourced tasks ALWAYS land in review (taskAwaitsManualCompletion).
	// Gating proofs on Finished alone excluded exactly the users the
	// toggle exists for.
	task := testTaskForProof(TaskStatusReview)
	BuildTaskProof(task, nil)
	if _, ok := loadTaskProof(task.ID); !ok {
		t.Fatal("review-status task produced no proof — mobile tasks are shut out again (B1 regressed)")
	}

	// Negative control: a genuinely failed task gets no proof.
	failed := testTaskForProof(TaskStatusFailed)
	failed.ID = "efgh5678"
	BuildTaskProof(failed, nil)
	if _, ok := loadTaskProof(failed.ID); ok {
		t.Fatal("failed task must not get a success proof")
	}
}

func TestPersistedTask_KeepsProofAndClipLink(t *testing.T) {
	task := testTaskForProof(TaskStatusFinished)
	task.VideoClipID = "c_deadbeef"
	task.VideoStatus = "ready"
	task.ProofStatus = "ready"
	task.WorkDir = "/tmp/somewhere"
	task.CommitSHA = "0123456789abcdef"
	task.FeedbackID = "fb123456"

	records := snapshotPersistedTasks(map[string]*Task{task.ID: task})
	data, err := json.Marshal(records)
	if err != nil {
		t.Fatal(err)
	}
	var back []persistedTask
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if len(back) != 1 {
		t.Fatalf("want 1 record, got %d", len(back))
	}
	r := back[0]
	if r.VideoClipID != "c_deadbeef" || r.VideoStatus != "ready" || r.ProofStatus != "ready" ||
		r.WorkDir != "/tmp/somewhere" || r.CommitSHA != "0123456789abcdef" || r.FeedbackID != "fb123456" {
		t.Fatalf("restart drops the proof/clip link again (B2 regressed): %+v", r)
	}
}

func TestReceiveFeedback_WebmRoutesIntoReport(t *testing.T) {
	t.Setenv("YAVER_CONFIG_DIR", t.TempDir())
	fm, err := NewFeedbackManager()
	if err != nil {
		t.Fatal(err)
	}
	meta := json.RawMessage(`{"source":"in-app-sdk","deviceInfo":{"platform":"web"}}`)
	report, err := fm.ReceiveFeedback(meta, map[string][]byte{
		"recording.webm": []byte("not-really-video"),
		"voice.webm":     []byte("not-really-audio"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.VideoPath == "" {
		t.Fatal("recording.webm was stored but not linked as the report's video (B6 regressed)")
	}
	if report.AudioPath == "" {
		t.Fatal("voice.webm was stored but not linked as the report's audio (B6 regressed)")
	}
}

func TestDecodeDataURI(t *testing.T) {
	payload := base64.StdEncoding.EncodeToString([]byte("hello"))
	mime, data, ok := decodeDataURI("data:image/jpeg;base64," + payload)
	if !ok || mime != "image/jpeg" || string(data) != "hello" {
		t.Fatalf("valid data URI rejected: ok=%v mime=%q", ok, mime)
	}
	// Negative controls: bare base64 and non-base64 URIs are refused,
	// never guessed at.
	if _, _, ok := decodeDataURI(payload); ok {
		t.Fatal("bare base64 must not be accepted")
	}
	if _, _, ok := decodeDataURI("data:image/jpeg,hello"); ok {
		t.Fatal("non-base64 data URI must not be accepted")
	}
}
