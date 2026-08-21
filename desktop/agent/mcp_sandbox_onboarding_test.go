package main

import "testing"

func TestMobileWorkspaceOnboardingMCPToolsAreRegistered(t *testing.T) {
	wrapper, ok := (&HTTPServer{}).getMCPToolsList().(map[string]interface{})
	if !ok {
		t.Fatal("getMCPToolsList did not return a map wrapper")
	}
	tools, ok := wrapper["tools"].([]map[string]interface{})
	if !ok {
		t.Fatal("tools key is not []map[string]interface{}")
	}
	status := findMCPToolForTest(t, tools, "mobile_workspace_onboarding_status")
	if status["description"] == "" {
		t.Fatal("mobile_workspace_onboarding_status needs a description")
	}
	selectTool := findMCPToolForTest(t, tools, "mobile_workspace_onboarding_select")
	schema, _ := selectTool["inputSchema"].(map[string]interface{})
	required, _ := schema["required"].([]string)
	if len(required) != 2 || required[0] != "device" || required[1] != "runner" {
		t.Fatalf("mobile_workspace_onboarding_select required = %#v, want device + runner", required)
	}
}

func TestMobileWorkspaceMCPRejectsUnverifiedRunnerInventory(t *testing.T) {
	installedOnly := remoteRunnerSummary{
		Installed: true, Ready: true, AuthConfigured: true, AuthVerified: false,
	}
	if remoteRunnerReadyForMobileWorkspace(installedOnly) {
		t.Fatal("installed credentials without a provider operation must not pass Mobile Workspace onboarding")
	}
	installedOnly.AuthVerified = true
	if !remoteRunnerReadyForMobileWorkspace(installedOnly) {
		t.Fatal("a runner proven by a real provider operation should pass Mobile Workspace onboarding")
	}
}
