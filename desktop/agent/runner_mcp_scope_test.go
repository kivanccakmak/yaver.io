package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexYaverOnlyMCPArgsIgnoreUserConfig(t *testing.T) {
	args := codexYaverOnlyMCPArgs("/tmp/yaver")
	joined := strings.Join(args, "\x00")
	for _, want := range []string{
		"--ignore-user-config",
		"mcp_servers.yaver.command=\"/tmp/yaver\"",
		`mcp_servers.yaver.args=["mcp"]`,
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("codex scoped args missing %q: %v", want, args)
		}
	}
}

func TestPrepareClaudeYaverOnlyConfigStripsForeignMCPs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	work := t.TempDir()

	seed := map[string]any{
		"oauthAccount": map[string]any{"emailAddress": "user@example.com"},
		"mcpServers":   map[string]any{"talos": map[string]any{"command": "talcli"}},
		"projects": map[string]any{
			work: map[string]any{
				"mcpServers": map[string]any{"other": map[string]any{"command": "other"}},
			},
		},
	}
	data, _ := json.Marshal(seed)
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", ".credentials.json"), []byte(`{"token":"keep"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	env, err := prepareClaudeYaverOnlyConfig("/tmp/yaver", work)
	if err != nil {
		t.Fatal(err)
	}
	if len(env) != 1 || !strings.HasPrefix(env[0], "CLAUDE_CONFIG_DIR=") {
		t.Fatalf("unexpected env: %v", env)
	}
	dir := strings.TrimPrefix(env[0], "CLAUDE_CONFIG_DIR=")
	got := readClaudeConfig(t, filepath.Join(dir, ".claude.json"))
	mcp, _ := got["mcpServers"].(map[string]any)
	if len(mcp) != 1 || mcp["yaver"] == nil {
		t.Fatalf("scoped mcpServers = %v, want only yaver", mcp)
	}
	if got["oauthAccount"] == nil {
		t.Fatal("oauthAccount was not preserved")
	}
	projects, _ := got["projects"].(map[string]any)
	entry, _ := projects[work].(map[string]any)
	if entry["mcpServers"] != nil {
		t.Fatalf("project-level MCP servers leaked into scoped config: %v", entry["mcpServers"])
	}
	if trusted, _ := entry["hasTrustDialogAccepted"].(bool); !trusted {
		t.Fatalf("workdir trust was not set: %v", entry)
	}
	if _, err := os.Stat(filepath.Join(dir, ".credentials.json")); err != nil {
		t.Fatalf("credentials were not copied into scoped dir: %v", err)
	}
}

func TestPrepareOpenCodeYaverOnlyConfigPreservesProviderConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OPENCODE_CONFIG", "")
	t.Setenv("OPENCODE_CONFIG_DIR", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	cfgDir := filepath.Join(home, ".config", "opencode")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		t.Fatal(err)
	}
	seed := `{
	  // JSONC is the common handwritten opencode shape.
	  "provider": {"openrouter": {"apiKey": "secret"}},
	  "mcp": {"talos": {"command": ["talcli"]}},
	}`
	if err := os.WriteFile(filepath.Join(cfgDir, "opencode.jsonc"), []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	env, err := prepareOpenCodeYaverOnlyConfig("/tmp/yaver")
	if err != nil {
		t.Fatal(err)
	}
	if len(env) != 1 || !strings.HasPrefix(env[0], "OPENCODE_CONFIG=") {
		t.Fatalf("unexpected env: %v", env)
	}
	data, err := os.ReadFile(strings.TrimPrefix(env[0], "OPENCODE_CONFIG="))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got["provider"] == nil {
		t.Fatal("provider config was not preserved")
	}
	mcp, _ := got["mcp"].(map[string]any)
	if len(mcp) != 1 || mcp["yaver"] == nil {
		t.Fatalf("scoped opencode mcp = %v, want only yaver", mcp)
	}
}
