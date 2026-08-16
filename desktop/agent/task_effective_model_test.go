package main

import "testing"

// The "Model not found: gpt-5.4/" incident (linux box, 2026-07-26): task
// creation guards model compatibility, but the SPAWN-time fallback
// `task.Model || runner.Model` did not — a stale cross-runner model on the
// boot-time runner pref (gpt-5.4, a codex model) was spliced into
// `opencode run --model gpt-5.4` unchecked, and opencode failed every task
// on the box. An incompatible fallback must be DROPPED so the CLI uses its
// own configured default (the box's opencode.json says glm-5.2).
func TestEffectiveModelDropsIncompatibleRunnerFallback(t *testing.T) {
	if got := effectiveModelFor("opencode", "", "gpt-5.4"); got != "" {
		t.Fatalf("effectiveModelFor(opencode, '', gpt-5.4) = %q, want '' (drop the stale codex model)", got)
	}
	if got := effectiveModelFor("opencode", "", "zai-coding-plan/glm-5.2"); got != "zai-coding-plan/glm-5.2" {
		t.Fatalf("compatible opencode fallback dropped: %q", got)
	}
	if got := effectiveModelFor("codex", "", "gpt-5.4"); got != "gpt-5.4" {
		t.Fatalf("codex fallback = %q, want gpt-5.4", got)
	}
}

// Task-pinned model wins over the runner fallback — but is dropped too when
// it can't work on this runner (same rule as creation, applied at the last
// gate before argv).
func TestEffectiveModelPrecedenceAndTaskGuard(t *testing.T) {
	if got := effectiveModelFor("opencode", "zai-coding-plan/glm-5.2", "gpt-5.4"); got != "zai-coding-plan/glm-5.2" {
		t.Fatalf("task model should win: %q", got)
	}
	if got := effectiveModelFor("opencode", "sonnet", ""); got != "" {
		t.Fatalf("incompatible task model must be dropped at spawn: %q", got)
	}
	if got := effectiveModelFor("claude", "", ""); got != "" {
		t.Fatalf("no model anywhere must stay empty: %q", got)
	}
}
