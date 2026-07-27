package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunRunnerProbeCodexUsesDangerousBypass(t *testing.T) {
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "args.txt")
	fakeCodex := filepath.Join(dir, "codex")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shellQuote(argsFile) + "\nprintf 'OK\\n'\n"
	if err := os.WriteFile(fakeCodex, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	out, err := runRunnerProbe(RunnerConfig{RunnerID: "codex", Command: fakeCodex, Model: "gpt-test"}, "codex", "say ok", 2*time.Second)
	if err != nil {
		t.Fatalf("runRunnerProbe failed: %v; output=%q", err, out)
	}
	raw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Split(strings.TrimSpace(string(raw)), "\n")
	joined := strings.Join(args, " ")
	for _, want := range []string{"exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--model gpt-test", "say ok"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("codex probe args missing %q: %v", want, args)
		}
	}
}
