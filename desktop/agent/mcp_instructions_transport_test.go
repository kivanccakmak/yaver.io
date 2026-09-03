package main

import (
	"strings"
	"testing"
)

func TestMCPInitializeResultCarriesExistingAppIntegrationGuidance(t *testing.T) {
	result := mcpInitializeResult()
	instructions, _ := result["instructions"].(string)
	for _, want := range []string{
		"yaver_sdk_integrate",
		"existing Expo app",
		"Do not hand-edit",
		"yaver_openrouter_integrate",
		"passes OpenRouter SSE directly",
	} {
		if !strings.Contains(instructions, want) {
			t.Fatalf("shared MCP initialize instructions missing %q", want)
		}
	}
	serverInfo, _ := result["serverInfo"].(map[string]interface{})
	if serverInfo["name"] != "yaver" {
		t.Fatalf("shared MCP initialize payload lost server identity: %#v", serverInfo)
	}
}
