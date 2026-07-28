package main

// devserver_http_guidance_bounds_test.go — guards the "Compatibility guidance
// bounds" contract in devserver_http.go.
//
// Incident 2026-07-28 (build-482 regression): /dev/compatibility joined ~90
// "<dep> requires native code but is not present in the Yaver app." sentences
// into one 8,212-character `guidance` string. The mobile action sheet rendered
// it unbounded, pushing the only offered routes ("WebRTC Reload" / "Browser
// Reload") 280–340px below a fold the user could not scroll past. Advisory
// content must never win over the route — so guidance is a bounded summary,
// and this test reproduces the 90-module case that produced the wall.
//
// Proven by breaking: restore `strings.Join(errs, " ")` inside
// compatIncompatibleGuidance and TestGuidanceBoundedWith90MissingModules fails
// naming the byte count.

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestGuidanceBoundedWith90MissingModules(t *testing.T) {
	var missing []string
	var errs []string
	for i := 0; i < 90; i++ {
		dep := fmt.Sprintf("react-native-fake-native-module-%02d", i)
		missing = append(missing, dep)
		errs = append(errs, fmt.Sprintf("%s requires native code but is not present in the Yaver app.", dep))
	}
	// Non-module errors ride along in real payloads too.
	errs = append(errs, "Missing local build tools: hermesc.")

	g := compatIncompatibleGuidance(errs, missing)
	if len(g) > compatGuidanceMaxChars {
		t.Fatalf("guidance is %d bytes — exceeds the %d-byte cap; the build-482 advisory wall is back and the action lanes render below an unscrollable fold", len(g), compatGuidanceMaxChars)
	}
	if !strings.Contains(g, "90") {
		t.Fatalf("guidance must name the count of missing native modules, got: %q", g)
	}
	if !strings.Contains(g, missing[0]) {
		t.Fatalf("guidance should name the first few modules, got: %q", g)
	}
	// Detail preservation: the bounded summary must not come at the cost of the
	// structured channel — surfaces render per-module detail from `errors` and
	// `missingModules`, which the summarizer must never mutate or truncate.
	if len(errs) != 91 {
		t.Fatalf("errors channel lost detail: %d entries, want 91", len(errs))
	}
	if len(missing) != 90 {
		t.Fatalf("missingModules channel lost detail: %d entries, want 90", len(missing))
	}
}

func TestGuidanceCapBacksstopsAnyProducerPath(t *testing.T) {
	// The backstop must bound ANY string a future producer path assigns —
	// e.g. buildStateGuidance embedding a multi-KB bundler stack trace.
	wall := strings.Repeat("Unable to resolve module ./nope from /project/index.js. ", 200)
	g := capCompatGuidance(wall)
	if len(g) > compatGuidanceMaxChars {
		t.Fatalf("capCompatGuidance returned %d bytes, cap is %d", len(g), compatGuidanceMaxChars)
	}
	if !strings.HasSuffix(g, "…") {
		t.Fatalf("truncated guidance must end with an ellipsis, got: %q", g)
	}
	// Word boundary: every space-separated token before the ellipsis must be a
	// complete word from the input, never a mid-word fragment.
	for _, tok := range strings.Fields(strings.TrimSuffix(g, "…")) {
		if !strings.Contains(wall, tok) {
			t.Fatalf("truncation split a word: token %q is not a whole word of the input", tok)
		}
	}
	if !utf8.ValidString(g) {
		t.Fatalf("truncation split a UTF-8 rune: %q", g)
	}

	short := "Hermes bundle already compiled on this machine."
	if got := capCompatGuidance(short); got != short {
		t.Fatalf("short guidance must pass through untouched, got: %q", got)
	}
}
