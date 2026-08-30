package main

import "testing"

func TestCurrentRunnerFromSettingsReadsNestedAndLegacyShapes(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "nested", body: `{"settings":{"runnerId":"codex"}}`},
		{name: "legacy flat", body: `{"runnerId":"codex"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := currentRunnerFromSettings([]byte(tc.body)); got != "codex" {
				t.Fatalf("current runner = %q, want codex", got)
			}
		})
	}
}

func TestStatusRunnerIdentityPrefersLivePerDeviceRunner(t *testing.T) {
	live := &localAgentInfo{}
	live.Runner.ID = "codex"
	live.Runner.Name = "OpenAI Codex"

	id, name := statusRunnerIdentity(live, "claude", []backendRunner{
		{RunnerID: "claude", Name: "Claude Code"},
		{RunnerID: "codex", Name: "OpenAI Codex"},
	})
	if id != "codex" || name != "OpenAI Codex" {
		t.Fatalf("status runner = %q (%q), want codex (OpenAI Codex)", name, id)
	}
}

func TestStatusRunnerIdentityFallsBackToGlobalCatalogEntry(t *testing.T) {
	id, name := statusRunnerIdentity(nil, "codex", []backendRunner{
		{RunnerID: "codex", Name: "OpenAI Codex"},
	})
	if id != "codex" || name != "OpenAI Codex" {
		t.Fatalf("status runner = %q (%q), want codex (OpenAI Codex)", name, id)
	}
}
