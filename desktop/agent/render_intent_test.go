package main

import "testing"

func TestExplicitRenderInstructionRequiresWholeCommand(t *testing.T) {
	for _, prompt := range []string{"reload", "please re-render", "refresh the app", "render again", "make the header blue and reload", "fix spacing then render again"} {
		if !isExplicitRenderInstruction(prompt) {
			t.Fatalf("expected explicit render intent for %q", prompt)
		}
	}
	for _, prompt := range []string{"fix the reload bug", "test it", "show me the code", "update the app header"} {
		if isExplicitRenderInstruction(prompt) {
			t.Fatalf("coding prompt must not grant render permission: %q", prompt)
		}
	}
}
