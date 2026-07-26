package main

import (
	"os"
	"testing"
)

// The surface must fit inside a provider's tool cap. z.ai/GLM rejects >1000 and
// Yaver was advertising 1135 — the owner's own box could not run opencode at all.
func TestWedgeProfileFitsProviderCap(t *testing.T) {
	s := &HTTPServer{}
	os.Setenv("YAVER_MCP_PROFILE", "full")
	full := len(s.getMCPToolsList().(map[string]interface{})["tools"].([]map[string]interface{}))
	os.Unsetenv("YAVER_MCP_PROFILE")
	wedge := len(s.getMCPToolsList().(map[string]interface{})["tools"].([]map[string]interface{}))
	t.Logf("full=%d wedge=%d", full, wedge)
	if wedge >= full {
		t.Fatalf("wedge profile did not trim anything: full=%d wedge=%d", full, wedge)
	}
	// The number that actually matters: it must clear z.ai's hard cap.
	if wedge > 1000 {
		t.Fatalf("wedge surface is %d tools — still over the 1000 cap that broke opencode", wedge)
	}
}

// A lean surface that drops the wedge's OWN tools is worse than the flood: the
// agent would conclude Yaver cannot render, cannot sign a runner in, cannot
// push to a phone. These are the capabilities the profile exists to protect,
// so they are asserted by name rather than trusted to the family allowlist.
func TestWedgeProfileKeepsTheWedge(t *testing.T) {
	s := &HTTPServer{}
	os.Unsetenv("YAVER_MCP_PROFILE")
	tools := s.getMCPToolsList().(map[string]interface{})["tools"].([]map[string]interface{})
	have := map[string]bool{}
	for _, tl := range tools {
		if n, _ := tl["name"].(string); n != "" {
			have[n] = true
		}
	}
	for _, must := range []string{
		"ops",                       // the grand-tool: one tool, ~20 verbs
		"create_task", "list_tasks", // dispatch work
		"list_runners",              // which runners exist
		"runner_auth_browser_start", // REMOTE OAUTH — dead on the user's box today
		"runner_auth_status",
		"web_preview_start",    // browser lane
		"vibe_preview_start",   // vibing
		"mobile_hermes_reload", // Hermes render path
		"mobile_project_build",
		"browser_navigate",                        // browser lane driving
		"remote_status",                           // remote runtime
		"read_file", "write_file", "exec_command", // primitives
		"git_info",
		"yaver_devices", "yaver_status",
	} {
		if !have[must] {
			t.Errorf("wedge profile dropped %q — a capability the profile exists to keep", must)
		}
	}
}
