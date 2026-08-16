package main

import (
	"strings"
	"testing"
)

// codex 0.144.x REMOVED `--full-auto` from `codex exec`: the flag maps to
// approval policy "on-failure", which the current binary rejects with
//
//	error: invalid value 'on-failure' for '--ask-for-approval <APPROVAL_POLICY>'
//	  [possible values: untrusted, on-request, never]
//
// Every codex task on the box failed that way (observed live 2026-07-27,
// codex-cli 0.144.1, task be7ea9bb) — the runner looked signed-in and ready,
// and the chat just said FAILED with a flag-parser error the user cannot act
// on. `codex exec --help` on that version offers `-s/--sandbox` with
// [read-only, workspace-write, danger-full-access] and no --full-auto, so the
// equivalent non-interactive policy is `--sandbox workspace-write`.
func TestCodexBuiltinArgsAvoidRemovedFullAuto(t *testing.T) {
	cfg, ok := builtinRunners["codex"]
	if !ok {
		t.Fatal("codex builtin runner missing")
	}
	joined := strings.Join(cfg.Args, " ")
	if strings.Contains(joined, "--full-auto") {
		t.Fatalf("codex args still pass the removed --full-auto: %q", joined)
	}
	if !strings.Contains(joined, "--sandbox workspace-write") {
		t.Fatalf("codex args must select a sandbox policy explicitly, got %q", joined)
	}
	if cfg.Args[0] != "exec" {
		t.Fatalf("codex args must start with exec, got %q", cfg.Args[0])
	}
	if !strings.Contains(joined, "{prompt}") {
		t.Fatalf("codex args lost the prompt placeholder: %q", joined)
	}
}
