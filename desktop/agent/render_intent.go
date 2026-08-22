package main

import "strings"

// isExplicitRenderInstruction recognizes execution commands, not mentions.
// That distinction prevents prompts such as "fix the reload bug" from
// silently granting permission to replace a working preview.
func isExplicitRenderInstruction(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.TrimRight(normalized, ".!?")
	normalized = strings.Join(strings.Fields(normalized), " ")
	normalized = strings.TrimPrefix(normalized, "please ")
	for _, command := range []string{
		"reload", "reload it", "reload again", "reload the app", "reload the preview", "reload the ui",
		"hot reload", "fast reload", "fast reload the preview",
		"re-render", "re-render it", "re-render again", "re-render the app", "re-render the preview", "re-render the ui",
		"rerender", "rerender it", "rerender again", "render again",
		"refresh", "refresh it", "refresh again", "refresh the app", "refresh app", "refresh the preview", "refresh the ui",
		"push to phone",
	} {
		if normalized == command {
			return true
		}
	}
	// A coding request may deliberately end with a render instruction. Keep it
	// in the coding queue, then honor the suffix after that turn lands. Requiring
	// a sequencing connector avoids treating "fix the reload bug" as consent.
	for _, marker := range []string{
		" and reload", " and re-render", " and rerender", " and render again", " and refresh the preview",
		" then reload", " then re-render", " then rerender", " then render again", " then refresh the preview",
	} {
		if strings.HasSuffix(normalized, marker) {
			return true
		}
	}
	return false
}
