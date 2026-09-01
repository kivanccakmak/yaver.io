package main

// terminal_semantics.go classifies terminal bytes OFFLINE. A PTY drops the
// runner's rich event types, so this is intentionally conservative: it labels
// evidence for status/console UI but NEVER promotes raw prose into chat.

import (
	"regexp"
	"strings"
)

type terminalLineKind string

const (
	terminalLineEmpty       terminalLineKind = "empty"
	terminalLineDecoration  terminalLineKind = "decoration"
	terminalLineCommand     terminalLineKind = "command"
	terminalLineProgress    terminalLineKind = "progress"
	terminalLineCommandOut  terminalLineKind = "command_output"
	terminalLineDiff        terminalLineKind = "diff"
	terminalLineFailure     terminalLineKind = "failure"
	terminalLineUnknownText terminalLineKind = "unknown_text"
)

type terminalLine struct {
	Kind     terminalLineKind
	Text     string // ANSI/terminal decoration removed; console evidence only.
	Command  string // populated only for a high-confidence command boundary.
	Activity string // Yaver-authored human status, never raw runner prose.
}

var (
	terminalShellCommandRE = regexp.MustCompile(`^(?:\*\*)?\$\s+(.+?)(?:\*\*)?$`)
	terminalCodexRunRE     = regexp.MustCompile(`(?i)^[•●·]\s*(?:ran|running)\s+(.+)$`)
	terminalPhaseRE        = regexp.MustCompile(`(?i)^(?:[•●·]\s*)?(exploring|investigating|planning|thinking|reading|searching|editing|writing|applying|testing|building|checking)\b`)
	terminalDiffRE         = regexp.MustCompile(`^(?:diff --git |--- |\+\+\+ |@@ |[+\-]{3}\s)`)
	terminalFailureRE      = regexp.MustCompile(`(?i)^(?:error|fatal|panic|exception|failed)\b|\b(?:command failed|process exited)\b`)
	terminalSpinnerRE      = regexp.MustCompile(`^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]+(?:\s|$)`)
	terminalFenceRE        = regexp.MustCompile("^\\s*`{3,}")
	terminalPatchStartRE   = regexp.MustCompile(`^(?:\*\*\* Begin Patch|diff --git |--- |\+\+\+ |@@ )`)
)

// classifyTerminalLine identifies syntax/mechanics, not natural-language
// meaning. Bold text is decoration unless it contains the explicit `$ command`
// grammar. That keeps Markdown and model prose from becoming fake chat turns.
func classifyTerminalLine(raw string) terminalLine {
	text := strings.TrimSpace(strings.TrimRight(stripANSI(raw), "\r"))
	if text == "" {
		return terminalLine{Kind: terminalLineEmpty}
	}
	if match := terminalShellCommandRE.FindStringSubmatch(text); len(match) == 2 {
		command := strings.TrimSpace(match[1])
		return terminalLine{Kind: terminalLineCommand, Text: text, Command: command, Activity: humanTaskActivityForCommand(command)}
	}
	if match := terminalCodexRunRE.FindStringSubmatch(text); len(match) == 2 {
		command := strings.TrimSpace(match[1])
		return terminalLine{Kind: terminalLineCommand, Text: text, Command: command, Activity: humanTaskActivityForCommand(command)}
	}
	if match := terminalPhaseRE.FindStringSubmatch(text); len(match) == 2 {
		activity := map[string]string{
			"exploring": "Inspecting the project.", "investigating": "Inspecting the project.", "reading": "Inspecting the project.", "searching": "Inspecting the project.",
			"planning": "Planning the requested changes.", "thinking": "Planning the requested changes.",
			"editing": "Making the requested changes.", "writing": "Making the requested changes.", "applying": "Making the requested changes.",
			"testing": "Checking the work.", "checking": "Checking the work.", "building": "Building the project.",
		}[strings.ToLower(match[1])]
		return terminalLine{Kind: terminalLineProgress, Text: text, Activity: activity}
	}
	if terminalDiffRE.MatchString(text) {
		return terminalLine{Kind: terminalLineDiff, Text: text}
	}
	if terminalFailureRE.MatchString(text) {
		return terminalLine{Kind: terminalLineFailure, Text: text}
	}
	if terminalSpinnerRE.MatchString(text) || strings.Trim(text, "─═━│┃┌┐└┘├┤┬┴┼ ") == "" {
		return terminalLine{Kind: terminalLineDecoration, Text: text}
	}
	return terminalLine{Kind: terminalLineUnknownText, Text: text}
}

// humanReadableRunnerAnswer is the final offline gate between a runner answer
// and a human surface. It preserves prose and rejects terminal commands,
// patches, fences and decoration. Lossless evidence remains in Details.
func humanReadableRunnerAnswer(raw string) string {
	kept := make([]string, 0, 8)
	inFence, inPatch := false, false
	for _, line := range strings.Split(strings.ReplaceAll(stripANSI(raw), "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if terminalFenceRE.MatchString(trimmed) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if terminalPatchStartRE.MatchString(trimmed) {
			inPatch = true
			continue
		}
		if inPatch {
			if trimmed == "" {
				inPatch = false
			}
			continue
		}
		switch classifyTerminalLine(line).Kind {
		case terminalLineEmpty:
			if len(kept) > 0 && kept[len(kept)-1] != "" {
				kept = append(kept, "")
			}
		case terminalLineCommand, terminalLineCommandOut, terminalLineDiff, terminalLineDecoration:
			continue
		case terminalLineFailure:
			kept = append(kept, "The runner reported a problem while completing the work.")
		default:
			kept = append(kept, strings.TrimRight(line, " \t"))
		}
	}
	answer := strings.TrimSpace(strings.Join(kept, "\n"))
	if answer == "" {
		return "The runner finished without a user-facing summary. Technical details are available under Details."
	}
	return answer
}
