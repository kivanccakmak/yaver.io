package main

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

const vibingThreadTitleInstruction = `Conversation title contract:
- In your final response, add exactly one hidden marker on its own final line:
  <!-- YAVER_THREAD_TITLE: concise 3-6 word title -->
- Describe the user's topic, not your completion status. Do not mention this contract.`

var vibingThreadTitlePattern = regexp.MustCompile(`(?is)<!--\s*YAVER_THREAD_TITLE\s*:\s*(.*?)\s*-->`)

func vibingThreadBriefing(context string) string {
	parts := make([]string, 0, 2)
	if trimmed := strings.TrimSpace(context); trimmed != "" {
		parts = append(parts, trimmed)
	}
	parts = append(parts, vibingThreadTitleInstruction)
	return strings.Join(parts, "\n\n") + "\n\nUser request:\n"
}

func stripVibingThreadTitleMarker(text string) (string, string) {
	match := vibingThreadTitlePattern.FindStringSubmatch(text)
	if len(match) < 2 {
		return strings.TrimSpace(text), ""
	}
	title := strings.TrimSpace(match[1])
	title = strings.Trim(title, "`*_#[](){}<>\"' ")
	title = strings.Join(strings.Fields(title), " ")
	if title == "" || utf8.RuneCountInString(title) > 60 || strings.ContainsAny(title, "\r\n") {
		return strings.TrimSpace(vibingThreadTitlePattern.ReplaceAllString(text, "")), ""
	}
	return strings.TrimSpace(vibingThreadTitlePattern.ReplaceAllString(text, "")), title
}

// finalizeVibingThreadTitle promotes the structured title emitted by the same
// coding turn into the task card. It deliberately does not start a second LLM
// request: the fallback remains the user's first prompt until this marker lands.
func finalizeVibingThreadTitle(task *Task) bool {
	if task == nil || !isFeedbackOrVibingSource(task.Source) {
		return false
	}
	candidates := []string{task.ResultText, task.Output}
	for i := len(task.Turns) - 1; i >= 0; i-- {
		if task.Turns[i].Role == "assistant" {
			candidates = append(candidates, task.Turns[i].Content)
			break
		}
	}
	title := ""
	markerFound := false
	for _, candidate := range candidates {
		cleaned, parsed := stripVibingThreadTitleMarker(candidate)
		if cleaned != strings.TrimSpace(candidate) {
			markerFound = true
		}
		if parsed != "" {
			title = parsed
			break
		}
	}
	if !markerFound {
		return false
	}
	if title != "" {
		task.Title = title
	}
	task.Output, _ = stripVibingThreadTitleMarker(task.Output)
	task.ResultText, _ = stripVibingThreadTitleMarker(task.ResultText)
	for i := range task.Turns {
		if task.Turns[i].Role == "assistant" {
			task.Turns[i].Content, _ = stripVibingThreadTitleMarker(task.Turns[i].Content)
		}
	}
	return true
}
