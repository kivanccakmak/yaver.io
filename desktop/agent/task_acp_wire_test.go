package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestACPWireProjectsMessageObjectsAndTerminalDiffEvidence(t *testing.T) {
	message := json.RawMessage(`{"type":"text","text":"The background is ready."}`)
	if got := acpMessageText(message); len(got) != 1 || got[0] != "The background is ready." {
		t.Fatalf("message text = %#v", got)
	}
	evidence := acpToolEvidence(
		json.RawMessage(`{"command":["sed","-n","1,20p","colors.ts"]}`),
		json.RawMessage(`{"exit_code":0,"formatted_output":"background: #7C3AED\\n"}`),
		json.RawMessage(`[{"type":"diff","path":"src/theme/colors.ts","oldText":"background: '#081A3A',","newText":"background: '#7C3AED',"}]`),
		json.RawMessage(`{"terminal_output":{"terminal_id":"cmd-1","data":"verified\\n"}}`),
	)
	joined := strings.Join(evidence, "")
	for _, want := range []string{"$ sed -n 1,20p colors.ts", "background: #7C3AED", "diff --git a/src/theme/colors.ts", "-background: '#081A3A',", "+background: '#7C3AED',", "verified"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("projected evidence missing %q: %q", want, joined)
		}
	}
}
