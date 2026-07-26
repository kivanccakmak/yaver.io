package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// runnerMCPScope is the launch-time MCP view for a runner process spawned by
// Yaver. It is deliberately per-invocation/per-task: the user's global Codex,
// Claude, or OpenCode config can keep any MCPs they use by hand, while a Yaver
// task sees one stable doorway: `yaver mcp`.
type runnerMCPScope struct {
	Args []string
	Env  []string
}

func prepareRunnerMCPScope(runnerID, workDir string) runnerMCPScope {
	yaverPath := findYaverBinary()
	switch normalizeRunnerID(runnerID) {
	case "codex":
		return runnerMCPScope{Args: codexYaverOnlyMCPArgs(yaverPath)}
	case "claude", "glm":
		env, err := prepareClaudeYaverOnlyConfig(yaverPath, workDir)
		if err != nil {
			log.Printf("[runner-mcp] claude scoped MCP config unavailable; falling back to runner config: %v", err)
			return runnerMCPScope{Args: claudeYaverOnlyMCPArgs(yaverPath)}
		}
		return runnerMCPScope{Env: env}
	case "opencode":
		env, err := prepareOpenCodeYaverOnlyConfig(yaverPath)
		if err != nil {
			log.Printf("[runner-mcp] opencode scoped MCP config unavailable; falling back to runner config: %v", err)
			return runnerMCPScope{}
		}
		return runnerMCPScope{Env: env}
	default:
		return runnerMCPScope{}
	}
}

func codexYaverOnlyMCPArgs(yaverPath string) []string {
	return []string{
		"--ignore-user-config",
		"-c", fmt.Sprintf("mcp_servers.yaver.command=%q", yaverPath),
		"-c", `mcp_servers.yaver.args=["mcp"]`,
	}
}

func claudeYaverOnlyMCPArgs(yaverPath string) []string {
	cfg, _ := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			"yaver": mcpServerEntry(yaverPath),
		},
	})
	return []string{"--mcp-config", string(cfg)}
}

func prepareClaudeYaverOnlyConfig(yaverPath, workDir string) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil, fmt.Errorf("resolve home: %w", err)
	}
	dir := filepath.Join(home, ".yaver", "runner-mcp", "claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}

	cfg := map[string]any{}
	if data, err := os.ReadFile(filepath.Join(home, ".claude.json")); err == nil && len(strings.TrimSpace(string(data))) > 0 {
		if err := json.Unmarshal(data, &cfg); err != nil {
			return nil, fmt.Errorf("parse ~/.claude.json: %w", err)
		}
	}
	cfg["hasCompletedOnboarding"] = true
	trustClaudeScopedWorkDir(cfg, workDir)
	stripClaudeProjectMCPServers(cfg)
	cfg["mcpServers"] = map[string]any{"yaver": mcpServerEntry(yaverPath)}
	if err := writeJSONFile(filepath.Join(dir, ".claude.json"), cfg, 0o600); err != nil {
		return nil, err
	}

	srcCred := filepath.Join(home, ".claude", ".credentials.json")
	dstCred := filepath.Join(dir, ".credentials.json")
	if err := copyFileIfExists(srcCred, dstCred, 0o600); err != nil {
		return nil, err
	}
	return []string{"CLAUDE_CONFIG_DIR=" + dir}, nil
}

func trustClaudeScopedWorkDir(cfg map[string]any, workDir string) {
	workDir = strings.TrimSpace(workDir)
	if workDir == "" {
		return
	}
	abs, err := filepath.Abs(workDir)
	if err != nil {
		return
	}
	projects, _ := cfg["projects"].(map[string]any)
	if projects == nil {
		projects = map[string]any{}
		cfg["projects"] = projects
	}
	entry, _ := projects[abs].(map[string]any)
	if entry == nil {
		entry = map[string]any{}
		projects[abs] = entry
	}
	entry["hasTrustDialogAccepted"] = true
}

func stripClaudeProjectMCPServers(cfg map[string]any) {
	projects, _ := cfg["projects"].(map[string]any)
	for _, raw := range projects {
		entry, _ := raw.(map[string]any)
		if entry == nil {
			continue
		}
		delete(entry, "mcpServers")
	}
}

func prepareOpenCodeYaverOnlyConfig(yaverPath string) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil, fmt.Errorf("resolve home: %w", err)
	}
	dir := filepath.Join(home, ".yaver", "runner-mcp", "opencode")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	cfg := map[string]any{}
	if _, text := readFirstExistingFile(openCodeConfigPaths("")); len(strings.TrimSpace(text)) > 0 {
		if err := json.Unmarshal(stripJSONC([]byte(text)), &cfg); err != nil {
			return nil, fmt.Errorf("parse opencode config: %w", err)
		}
	}
	cfg["mcp"] = map[string]any{
		"yaver": map[string]any{
			"type":    "local",
			"command": []string{yaverPath, "mcp"},
			"enabled": true,
		},
	}
	path := filepath.Join(dir, "opencode.json")
	if err := writeJSONFile(path, cfg, 0o600); err != nil {
		return nil, err
	}
	return []string{"OPENCODE_CONFIG=" + path}, nil
}

func writeJSONFile(path string, v any, mode os.FileMode) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return writeFileAtomic(path, data, mode)
}

func copyFileIfExists(src, dst string, mode os.FileMode) error {
	data, err := os.ReadFile(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	return writeFileAtomic(dst, data, mode)
}

func insertArgsAfter(args []string, marker string, insert []string) []string {
	if len(insert) == 0 {
		return args
	}
	out := make([]string, 0, len(args)+len(insert))
	for i, a := range args {
		out = append(out, a)
		if a == marker {
			out = append(out, insert...)
			out = append(out, args[i+1:]...)
			return out
		}
	}
	return append(out, insert...)
}
