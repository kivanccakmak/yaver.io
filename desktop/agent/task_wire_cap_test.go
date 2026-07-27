package main

import (
	"strings"
	"testing"
	"time"
)

// GET /tasks/{id} must stay small enough to poll through a relay. On
// 2026-07-27 one long runner turn pushed the detail body to 3.5MB and the web
// UI re-downloaded it every 2 seconds — the browser-side freeze the user read
// as "stuck". Output was capped; ResultText and Turns were not. If someone
// removes capTaskTranscript from taskInfoFromTask or widens the caps into
// megabytes, this fails.
func TestCapTaskTranscriptBoundsWirePayload(t *testing.T) {
	big := strings.Repeat("x", 3*1024*1024)
	turns := make([]ConversationTurn, 60)
	for i := range turns {
		turns[i] = ConversationTurn{Role: "assistant", Content: big, Timestamp: time.Now()}
	}
	info := TaskInfo{ResultText: big, Turns: turns}
	capTaskTranscript(&info)

	if !info.TranscriptTruncated {
		t.Fatal("transcriptTruncated flag not set — surfaces can't tell tail from whole")
	}
	if len(info.ResultText) != taskWireResultTextCap {
		t.Fatalf("resultText not tail-capped: %d bytes", len(info.ResultText))
	}
	if len(info.Turns) != taskWireMaxTurns {
		t.Fatalf("turns not capped: %d", len(info.Turns))
	}
	total := len(info.ResultText)
	for _, turn := range info.Turns {
		total += len(turn.Content)
	}
	if total > 1024*1024 {
		t.Fatalf("capped task detail still %d bytes — relay polling budget blown", total)
	}
}

// The cap must trim a COPY. info.Turns aliases the task manager's live slice;
// trimming in place would corrupt the stored transcript on the first poll.
func TestCapTaskTranscriptDoesNotMutateSource(t *testing.T) {
	big := strings.Repeat("y", taskWireTurnContentCap+10)
	source := []ConversationTurn{{Role: "assistant", Content: big}}
	info := TaskInfo{Turns: source}
	capTaskTranscript(&info)
	if len(source[0].Content) != len(big) {
		t.Fatal("capTaskTranscript mutated the task's stored turns")
	}
}

func TestCapTaskTranscriptNoopOnSmallTasks(t *testing.T) {
	info := TaskInfo{ResultText: "done", Turns: []ConversationTurn{{Role: "user", Content: "hi"}}}
	capTaskTranscript(&info)
	if info.TranscriptTruncated {
		t.Fatal("small task flagged as truncated")
	}
	if info.ResultText != "done" || info.Turns[0].Content != "hi" {
		t.Fatal("small task content altered")
	}
}
