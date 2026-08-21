package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunRunnerProbeOpenCodeUsesMobileWorkspaceLauncher(t *testing.T) {
	original := openCodeProbeRunnerFactory
	t.Cleanup(func() { openCodeProbeRunnerFactory = original })

	var gotSelection sandboxRunnerSelection
	openCodeProbeRunnerFactory = func(selection sandboxRunnerSelection) sandboxRunnerFn {
		gotSelection = selection
		return func(_ context.Context, workDir, prompt string) (sandboxRunMeta, error) {
			if prompt != "prove provider auth" {
				t.Fatalf("prompt = %q", prompt)
			}
			if info, err := os.Stat(workDir); err != nil || !info.IsDir() {
				t.Fatalf("isolated workdir is not usable: info=%v err=%v", info, err)
			}
			return sandboxRunMeta{rationale: "provider verified", model: selection.Model}, nil
		}
	}

	out, err := runRunnerProbe(RunnerConfig{
		RunnerID: "opencode",
		Model:    "deepseek/deepseek-v4-flash",
	}, "opencode", "prove provider auth", 2*time.Second)
	if err != nil {
		t.Fatalf("runRunnerProbe failed: %v", err)
	}
	if out != "provider verified" {
		t.Fatalf("output = %q", out)
	}
	if gotSelection.Model != "deepseek/deepseek-v4-flash" || gotSelection.Provider != "deepseek" || gotSelection.Mode != "build" {
		t.Fatalf("selection = %+v", gotSelection)
	}
}

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
