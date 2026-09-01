package main

import (
	"encoding/json"
	"strings"
)

// ACP deliberately uses discriminated unions for session updates. Keep that
// variability at the agent boundary; mobile/web/CLI receive the same stable
// human presentation plus folded raw console lane regardless of runner.
func acpMessageText(raw json.RawMessage) []string {
	var block struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &block) != nil || block.Type != "text" || block.Text == "" {
		return nil
	}
	return []string{block.Text}
}

// acpToolEvidence projects ACP tool updates to terminal-friendly text. It is
// intentionally conservative: assistant prose remains in the presentation
// lane, while commands, output and patches stay folded until the user opens
// the live console. The JSON field names cover the ACP v1 tool-call contract
// plus codex-acp's optional incremental terminal extension.
func acpToolEvidence(rawInput, rawOutput, content, meta json.RawMessage) []string {
	var evidence []string
	if command := acpCommand(rawInput); command != "" {
		evidence = append(evidence, "$ "+command)
	}
	if output := acpOutput(rawOutput); output != "" {
		evidence = append(evidence, output)
	}
	evidence = append(evidence, acpContentEvidence(content)...)
	evidence = append(evidence, acpTerminalMetaEvidence(meta)...)

	seen := make(map[string]struct{}, len(evidence))
	result := make([]string, 0, len(evidence))
	for _, item := range evidence {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		item += "\n"
		if _, exists := seen[item]; exists {
			continue
		}
		seen[item] = struct{}{}
		result = append(result, item)
	}
	return result
}

func acpCommand(raw json.RawMessage) string {
	var value struct {
		Command any `json:"command"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return ""
	}
	switch command := value.Command.(type) {
	case string:
		return strings.TrimSpace(command)
	case []any:
		parts := make([]string, 0, len(command))
		for _, part := range command {
			if text, ok := part.(string); ok && text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, " ")
	default:
		return ""
	}
}

func acpOutput(raw json.RawMessage) string {
	var value map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return ""
	}
	// Prefer the adapter's display-ready output to separate stdout/stderr so
	// a command end event is represented once rather than repeated three times.
	for _, field := range []string{"formatted_output", "formattedOutput", "aggregated_output", "aggregatedOutput", "stdout", "output", "text"} {
		if text, ok := value[field].(string); ok {
			return text
		}
	}
	return ""
}

func acpContentEvidence(raw json.RawMessage) []string {
	var items []map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &items) != nil {
		return nil
	}
	var result []string
	for _, item := range items {
		switch item["type"] {
		case "content":
			if nested, ok := item["content"].(map[string]any); ok {
				if text, ok := nested["text"].(string); ok {
					result = append(result, text)
				}
			}
			if text, ok := item["text"].(string); ok { // tolerant older adapters
				result = append(result, text)
			}
		case "diff":
			path, _ := item["path"].(string)
			oldText := firstACPString(item, "oldText", "old_text")
			newText := firstACPString(item, "newText", "new_text")
			if path != "" || oldText != "" || newText != "" {
				result = append(result, "diff --git a/"+path+" b/"+path+"\n--- "+path+"\n+++ "+path+"\n-"+oldText+"\n+"+newText)
			}
		}
	}
	return result
}

func acpTerminalMetaEvidence(raw json.RawMessage) []string {
	var meta struct {
		TerminalOutput struct {
			Data string `json:"data"`
		} `json:"terminal_output"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &meta) != nil || meta.TerminalOutput.Data == "" {
		return nil
	}
	return []string{meta.TerminalOutput.Data}
}

func firstACPString(value map[string]any, names ...string) string {
	for _, name := range names {
		if text, ok := value[name].(string); ok {
			return text
		}
	}
	return ""
}
