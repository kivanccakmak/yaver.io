package main

import "testing"

// A runner that exits cleanly having said NOTHING did not succeed. glm-4.7
// via opencode does exactly this (exit 0, zero bytes, seconds) and the task
// used to land in REVIEW as a silent empty card. Pin the classifier.
func TestEmptyRunnerReplyIsNotSuccess(t *testing.T) {
	if !isEmptyRunnerReply("", "") {
		t.Fatal("zero output + zero result must classify as empty")
	}
	if !isEmptyRunnerReply("  \n\t  ", " \n") {
		t.Fatal("whitespace-only output must classify as empty")
	}
	if isEmptyRunnerReply("Hi! What would you like me to do?", "") {
		t.Fatal("streamed output present — not empty")
	}
	if isEmptyRunnerReply("", "final answer") {
		t.Fatal("result text present — not empty")
	}
}
