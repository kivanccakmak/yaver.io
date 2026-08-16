package main

import "strings"

// isEmptyRunnerReply reports whether a finished runner produced no user-visible
// content at all — neither streamed output nor a final result. Used by the
// clean-exit path in the task manager: a silent run must become a NAMED
// failure, never a review card with nothing in it.
func isEmptyRunnerReply(output, resultText string) bool {
	return strings.TrimSpace(output) == "" && strings.TrimSpace(resultText) == ""
}
