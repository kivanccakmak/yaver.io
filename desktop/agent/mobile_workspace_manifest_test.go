package main

import (
	"strings"
	"testing"
)

func TestBuildMobileWorkspaceYamlPinsPredeterminedRemoteStack(t *testing.T) {
	manifest := buildMobileWorkspaceYaml("todo-example")
	for _, want := range []string{
		"mobile_workspace:",
		"primary_device: auto",
		"default_execution_role: remote-development",
		"stack: react-native-expo",
		"typescript",
		"yaver-serverless",
		"yaver-xml",
		"test_surfaces: [browser, rn-hermes]",
	} {
		if !strings.Contains(manifest, want) {
			t.Fatalf("Mobile Workspace manifest missing %q:\n%s", want, manifest)
		}
	}
	for _, forbidden := range []string{"mobile_sandbox", "auto-detect", "docker"} {
		if strings.Contains(strings.ToLower(manifest), forbidden) {
			t.Fatalf("Mobile Workspace manifest must not contain %q:\n%s", forbidden, manifest)
		}
	}
}
