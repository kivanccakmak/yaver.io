package main

import (
	"os"
	"strings"
	"testing"
)

// Agent startup is inventory and transport initialization, never permission to
// open a shell, launch an AI runner, or spend a token. Explicit tasks (including
// /goal) remain the sole runner-session creation boundary.
func TestStartupCannotCreateTmuxOrWarmRunnerSessions(t *testing.T) {
	checks := []struct {
		path   string
		forbid []string
	}{
		{"main.go", []string{"BootstrapDefaultSession(", ".WarmUp()"}},
		{"tasks.go", []string{"You are a warm session", "func (tm *TaskManager) WarmUp(", "warmSessionID", "warmPID"}},
		{"tmux.go", []string{"func (m *TmuxManager) BootstrapDefaultSession("}},
	}
	for _, check := range checks {
		raw, err := os.ReadFile(check.path)
		if err != nil {
			t.Fatalf("read %s: %v", check.path, err)
		}
		for _, forbidden := range check.forbid {
			if strings.Contains(string(raw), forbidden) {
				t.Errorf("%s still contains automatic-session path %q", check.path, forbidden)
			}
		}
	}
}

func TestPreferenceAndTerminalLaunchDoNotRunGenerationPreflights(t *testing.T) {
	checks := []struct {
		path  string
		start string
		end   string
	}{
		{"../../mobile/app/phone-projects.tsx", "const persistPrimaryTaskTarget", "const load = useCallback"},
		{"../../web/components/dashboard/TerminalView.tsx", "const toggleRunner", "// Optional browser dictation"},
	}
	for _, check := range checks {
		raw, err := os.ReadFile(check.path)
		if err != nil {
			t.Fatalf("read %s: %v", check.path, err)
		}
		body := string(raw)
		start := strings.Index(body, check.start)
		end := strings.Index(body, check.end)
		if start < 0 || end <= start {
			t.Fatalf("could not isolate guarded launch path in %s", check.path)
		}
		section := body[start:end]
		if strings.Contains(section, "/agent/runners/test") || strings.Contains(section, ".testRunner(") {
			t.Errorf("%s runs a hidden generation probe before the user's requested operation", check.path)
		}
	}
}
