package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestMCPToolsList_hasNoUnknownDispatcherEntries(t *testing.T) {
	wrapper, ok := (&HTTPServer{}).getMCPToolsList().(map[string]interface{})
	if !ok {
		t.Fatal("getMCPToolsList did not return a map wrapper")
	}
	tools, ok := wrapper["tools"].([]map[string]interface{})
	if !ok {
		t.Fatal("tools key is not []map[string]interface{}")
	}
	// This guard used to CALL every advertised tool with empty arguments. That
	// is not a read-only coverage check: no-argument tools can mutate real local
	// state (the test cleared the developer's relay password on 2026-08-17), and
	// tools that require an initialized manager can panic before returning their
	// argument error. Compare the advertised names with the package's static
	// dispatcher cases instead. MCP dispatch is intentionally split across
	// httpserver.go and focused mcp_*.go helpers, so inspect every production Go
	// source file while excluding tests.
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read agent package: %v", err)
	}
	caseRE := regexp.MustCompile(`(?m)\bcase\s+((?:"[^"]+"\s*,?\s*)+):`)
	nameRE := regexp.MustCompile(`"([^"]+)"`)
	implemented := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		source, readErr := os.ReadFile(entry.Name())
		if readErr != nil {
			t.Fatalf("read %s: %v", entry.Name(), readErr)
		}
		for _, match := range caseRE.FindAllStringSubmatch(string(source), -1) {
			for _, quoted := range nameRE.FindAllStringSubmatch(match[1], -1) {
				implemented[quoted[1]] = true
			}
		}
	}
	for _, tool := range tools {
		name, _ := tool["name"].(string)
		if strings.TrimSpace(name) == "" {
			continue
		}
		if !implemented[name] {
			t.Errorf("tools/list advertises %q but handleMCPToolCallWithAddr has no case", name)
		}
	}
}

func TestMCPNilTaskManagerToolsReturnNamedError(t *testing.T) {
	srv := &HTTPServer{}
	for _, name := range []string{
		"create_task", "get_info", "publish_config_get", "list_directory",
		"tmux_list_sessions", "git_sync_remote", "yaver_doctor", "yaver_status",
		"yaver_ping", "mobile_hermes_doctor", "pipeline_list", "session_list",
	} {
		t.Run(name, func(t *testing.T) {
			raw := []byte(`{"name":"` + name + `","arguments":{}}`)
			text := strings.ToLower(billingToolText(t, srv.handleMCPToolCall(raw)))
			if !strings.Contains(text, "task manager unavailable") {
				t.Fatalf("%s did not return the named unavailable error: %s", name, text)
			}
		})
	}
}
