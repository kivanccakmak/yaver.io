package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// builtinToolDefs returns the built-in tool definitions.
func builtinToolDefs() []ToolDef {
	return []ToolDef{
		{
			Name:        "read_file",
			Description: "Read the contents of a file. Returns the file content as text.",
			InputSchema: map[string]interface{}{
				"type":     "object",
				"required": []string{"path"},
				"properties": map[string]interface{}{
					"path": map[string]interface{}{"type": "string", "description": "File path to read"},
				},
			},
		},
		{
			Name:        "write_file",
			Description: "Write content to a file. Creates parent directories if needed.",
			InputSchema: map[string]interface{}{
				"type":     "object",
				"required": []string{"path", "content"},
				"properties": map[string]interface{}{
					"path":    map[string]interface{}{"type": "string", "description": "File path to write"},
					"content": map[string]interface{}{"type": "string", "description": "Content to write"},
				},
			},
		},
		{
			Name:        "list_directory",
			Description: "List files and directories in a path.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path": map[string]interface{}{"type": "string", "description": "Directory path (default: working directory)"},
				},
			},
		},
		{
			Name:        "search_files",
			Description: "Search for files matching a glob pattern.",
			InputSchema: map[string]interface{}{
				"type":     "object",
				"required": []string{"pattern"},
				"properties": map[string]interface{}{
					"pattern": map[string]interface{}{"type": "string", "description": "Glob pattern (e.g. '**/*.go')"},
					"path":    map[string]interface{}{"type": "string", "description": "Base directory (default: working directory)"},
				},
			},
		},
		{
			Name:        "search_content",
			Description: "Search file contents using grep/ripgrep. Returns matching lines with file names and line numbers.",
			InputSchema: map[string]interface{}{
				"type":     "object",
				"required": []string{"query"},
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string", "description": "Search text or regex"},
					"path":  map[string]interface{}{"type": "string", "description": "Directory to search (default: working directory)"},
					"glob":  map[string]interface{}{"type": "string", "description": "File pattern filter (e.g. '*.ts')"},
				},
			},
		},
		{
			Name:        "exec_command",
			Description: "Execute a shell command and return its output.",
			InputSchema: map[string]interface{}{
				"type":     "object",
				"required": []string{"command"},
				"properties": map[string]interface{}{
					"command": map[string]interface{}{"type": "string", "description": "Shell command to execute"},
					"timeout": map[string]interface{}{"type": "integer", "description": "Timeout in seconds (default: 30)"},
				},
			},
		},
		{
			Name:        "git_status",
			Description: "Show git status, branch, and recent log.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "git_diff",
			Description: "Show git diff (staged and unstaged changes).",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"staged": map[string]interface{}{"type": "boolean", "description": "Show staged changes only"},
				},
			},
		},
		{
			Name:        "system_info",
			Description: "Get system information (OS, CPU, memory, disk).",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "web_fetch",
			Description: "Fetch content from a URL and return it as text.",
			InputSchema: map[string]interface{}{
				"type":     "object",
				"required": []string{"url"},
				"properties": map[string]interface{}{
					"url": map[string]interface{}{"type": "string", "description": "URL to fetch"},
				},
			},
		},
	}
}

// handleBuiltinTool executes a built-in tool and returns (result, handled).
func handleBuiltinTool(name string, rawArgs json.RawMessage, workDir string) (interface{}, bool) {
	var args map[string]interface{}
	json.Unmarshal(rawArgs, &args)

	getString := func(key string) string {
		if v, ok := args[key]; ok {
			if s, ok := v.(string); ok {
				return s
			}
		}
		return ""
	}

	result := func(text string) interface{} {
		return map[string]interface{}{
			"content": []map[string]interface{}{
				{"type": "text", "text": text},
			},
		}
	}

	errResult := func(text string) interface{} {
		return map[string]interface{}{
			"content": []map[string]interface{}{
				{"type": "text", "text": text},
			},
			"isError": true,
		}
	}

	resolvePath := func(p string) string {
		if p == "" {
			return workDir
		}
		if filepath.IsAbs(p) {
			return p
		}
		return filepath.Join(workDir, p)
	}

	switch name {
	case "read_file":
		path := resolvePath(getString("path"))
		data, err := os.ReadFile(path)
		if err != nil {
			return errResult(fmt.Sprintf("read error: %v", err)), true
		}
		return result(string(data)), true

	case "write_file":
		path := resolvePath(getString("path"))
		content := getString("content")
		os.MkdirAll(filepath.Dir(path), 0755)
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			return errResult(fmt.Sprintf("write error: %v", err)), true
		}
		return result(fmt.Sprintf("Written %d bytes to %s", len(content), path)), true

	case "list_directory":
		path := resolvePath(getString("path"))
		entries, err := os.ReadDir(path)
		if err != nil {
			return errResult(fmt.Sprintf("list error: %v", err)), true
		}
		var sb strings.Builder
		for _, e := range entries {
			info, _ := e.Info()
			suffix := ""
			if e.IsDir() {
				suffix = "/"
			}
			size := int64(0)
			if info != nil {
				size = info.Size()
			}
			sb.WriteString(fmt.Sprintf("%s%s  (%d bytes)\n", e.Name(), suffix, size))
		}
		return result(sb.String()), true

	case "search_files":
		pattern := getString("pattern")
		basePath := resolvePath(getString("path"))
		var matches []string
		filepath.WalkDir(basePath, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() && (d.Name() == ".git" || d.Name() == "node_modules" || d.Name() == ".next") {
				return filepath.SkipDir
			}
			rel, _ := filepath.Rel(basePath, path)
			if matched, _ := filepath.Match(pattern, filepath.Base(path)); matched {
				matches = append(matches, rel)
			}
			if len(matches) > 200 {
				return filepath.SkipAll
			}
			return nil
		})
		return result(strings.Join(matches, "\n")), true

	case "search_content":
		query := getString("query")
		searchPath := resolvePath(getString("path"))
		glob := getString("glob")

		// Try ripgrep first, fall back to grep
		var cmdArgs []string
		rgPath, err := exec.LookPath("rg")
		if err == nil {
			cmdArgs = []string{rgPath, "-n", "--max-count=50"}
			if glob != "" {
				cmdArgs = append(cmdArgs, "--glob", glob)
			}
			cmdArgs = append(cmdArgs, query, searchPath)
		} else {
			cmdArgs = []string{"grep", "-rn", "--max-count=50"}
			if glob != "" {
				cmdArgs = append(cmdArgs, "--include", glob)
			}
			cmdArgs = append(cmdArgs, query, searchPath)
		}
		out, _ := exec.Command(cmdArgs[0], cmdArgs[1:]...).CombinedOutput()
		if len(out) == 0 {
			return result("No matches found."), true
		}
		return result(string(out)), true

	case "exec_command":
		command := getString("command")
		if command == "" {
			return errResult("command is required"), true
		}
		cmd := exec.Command("sh", "-c", command)
		cmd.Dir = workDir
		out, err := cmd.CombinedOutput()
		text := string(out)
		if err != nil {
			text += "\n" + err.Error()
		}
		return result(text), true

	case "git_status":
		var sb strings.Builder
		if out, err := exec.Command("git", "-C", workDir, "branch", "--show-current").Output(); err == nil {
			sb.WriteString("Branch: " + strings.TrimSpace(string(out)) + "\n\n")
		}
		if out, err := exec.Command("git", "-C", workDir, "status", "--short").Output(); err == nil {
			sb.WriteString("Status:\n" + string(out) + "\n")
		}
		if out, err := exec.Command("git", "-C", workDir, "log", "--oneline", "-5").Output(); err == nil {
			sb.WriteString("Recent commits:\n" + string(out))
		}
		return result(sb.String()), true

	case "git_diff":
		gitArgs := []string{"-C", workDir, "diff"}
		if v, ok := args["staged"]; ok && v == true {
			gitArgs = append(gitArgs, "--cached")
		}
		out, _ := exec.Command("git", gitArgs...).CombinedOutput()
		if len(out) == 0 {
			return result("No changes."), true
		}
		return result(string(out)), true

	case "system_info":
		hostname, _ := os.Hostname()
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("OS: %s/%s\n", runtime.GOOS, runtime.GOARCH))
		sb.WriteString(fmt.Sprintf("Hostname: %s\n", hostname))
		sb.WriteString(fmt.Sprintf("CPUs: %d\n", runtime.NumCPU()))
		sb.WriteString(fmt.Sprintf("Go: %s\n", runtime.Version()))
		return result(sb.String()), true

	case "web_fetch":
		url := getString("url")
		if url == "" {
			return errResult("url is required"), true
		}
		cmd := exec.Command("curl", "-sL", "--max-time", "10", url)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return errResult(fmt.Sprintf("fetch error: %v", err)), true
		}
		text := string(out)
		if len(text) > 50000 {
			text = text[:50000] + "\n...(truncated)"
		}
		return result(text), true

	default:
		return nil, false
	}
}
