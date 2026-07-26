package main

import "testing"

func TestRunnerModelCompatibleOpenCodeRequiresProviderQualifiedModel(t *testing.T) {
	if runnerModelCompatible("opencode", "gpt-5.4") {
		t.Fatal("opencode must reject unqualified Codex model ids")
	}
	if !runnerModelCompatible("opencode", "zai-coding-plan/glm-4.7") {
		t.Fatal("opencode should accept provider-qualified model ids")
	}
}
