package main

import (
	"strings"
	"testing"
)

func TestSeleniumSearchURL(t *testing.T) {
	got := seleniumSearchURL("google", "hasan arda kasikci live")
	if got != "https://www.google.com/search?q=hasan+arda+kasikci+live" {
		t.Fatalf("google search URL = %q", got)
	}
	got = seleniumSearchURL("ddg", "teams meeting")
	if got != "https://duckduckgo.com/?q=teams+meeting" {
		t.Fatalf("ddg search URL = %q", got)
	}
}

func TestSeleniumVersionParsingAndBuildMatching(t *testing.T) {
	if got := dottedVersion("Google Chrome 151.0.7922.138 "); got != "151.0.7922.138" {
		t.Fatalf("dottedVersion = %q", got)
	}
	if got := dottedVersion("ChromeDriver 151.0.7922.47 (abcdef)"); got != "151.0.7922.47" {
		t.Fatalf("driver dottedVersion = %q", got)
	}
	if chromeBuildVersion("151.0.7922.138") != chromeBuildVersion("151.0.7922.47") {
		t.Fatal("same Chrome build must accept a different patch")
	}
	if chromeBuildVersion("151.0.7922.138") == chromeBuildVersion("152.0.7977.42") {
		t.Fatal("different Chrome builds must not match")
	}
}

func TestSeleniumMCPToolsRegistered(t *testing.T) {
	wrapper, ok := (&HTTPServer{}).getMCPToolsList().(map[string]interface{})
	if !ok {
		t.Fatal("getMCPToolsList did not return wrapper")
	}
	tools, ok := wrapper["tools"].([]map[string]interface{})
	if !ok {
		t.Fatalf("tools has unexpected type %T", wrapper["tools"])
	}
	want := map[string]bool{
		"selenium_status":     false,
		"selenium_start":      false,
		"selenium_search":     false,
		"selenium_text":       false,
		"selenium_screenshot": false,
		"selenium_close":      false,
	}
	for _, tool := range tools {
		if _, exists := want[tool["name"].(string)]; exists {
			want[tool["name"].(string)] = true
			desc, _ := tool["description"].(string)
			if tool["name"] == "selenium_search" && !strings.Contains(strings.ToLower(desc), "google") {
				t.Fatalf("selenium_search description should mention Google, got %q", desc)
			}
		}
	}
	for name, found := range want {
		if !found {
			t.Fatalf("missing selenium MCP tool %s", name)
		}
	}
}
