package main

// Each case below is a failure that actually reached a user's phone as a spinner
// or a raw dump. The test asserts we now name the fix.

import (
	"errors"
	"strings"
	"testing"
)

func TestDevStartRemedyNamesTheFix(t *testing.T) {
	// Verbatim from the mini on 2026-07-25 (e-mobile, flutter web-server).
	missingAsset := "flutter exited before becoming ready: exit status 1\n" +
		"Launching lib/main.dart on Web Server in debug mode...\n" +
		"Error detected in pubspec.yaml:\n" +
		"No file or variants found for asset: .env.\n" +
		"Failed to compile application."

	cases := []struct {
		name      string
		framework string
		tail      string
		wantAny   []string // all must appear
	}{
		{
			name:      "missing pubspec asset (the observed failure)",
			framework: "flutter",
			tail:      missingAsset,
			wantAny:   []string{".env", "pubspec", "/work/e-mobile"},
		},
		{
			name:      "port already bound",
			framework: "flutter",
			tail:      "SocketException: Failed to create server socket (OS Error: Address already in use, errno = 48), address = 0.0.0.0, port = 9100",
			wantAny:   []string{"lsof", "port"},
		},
		{
			name:      "node dependency missing",
			framework: "vite",
			tail:      "Error: Cannot find module 'vite'\n    at Module._resolveFilename",
			wantAny:   []string{"vite", "install"},
		},
		{
			name:      "wrong directory",
			framework: "flutter",
			tail:      "Error: Could not find a file named \"pubspec.yaml\" in /work/not-a-project",
			wantAny:   []string{"pubspec.yaml"},
		},
		{
			name:      "toolchain absent",
			framework: "flutter",
			tail:      "exec: \"flutter\": executable file not found in $PATH",
			wantAny:   []string{"toolchain", "PATH"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := devStartRemedy(tc.framework, "/work/e-mobile", tc.tail)
			if got == "" {
				t.Fatalf("no remedy for a failure we have SEEN in production:\n%s", tc.tail)
			}
			for _, want := range tc.wantAny {
				if !strings.Contains(got, want) {
					t.Errorf("remedy does not mention %q — a vague remedy costs whole sessions.\ngot: %s", want, got)
				}
			}
		})
	}
}

func TestDevStartRemedyStaysQuietWhenItHasNothingUseful(t *testing.T) {
	for _, tail := range []string{
		"",
		"   ",
		"Compiling lib/main.dart for the Web...",
		"some novel failure nobody has classified yet",
	} {
		if got := devStartRemedy("flutter", "/work", tail); got != "" {
			t.Errorf("invented a remedy for %q: %s", tail, got)
		}
	}
}

func TestAnnotateDevStartErrorAppendsOnce(t *testing.T) {
	err := errors.New("flutter exited before becoming ready: exit status 1\nNo file or variants found for asset: .env.")

	first := annotateDevStartError("flutter", "/work", err)
	if !strings.Contains(first, "What to do:") {
		t.Fatalf("remedy not attached: %s", first)
	}
	// Re-annotating an already-annotated message must not stack remedies — the
	// message travels through /dev/status AND the SSE error event.
	second := annotateDevStartError("flutter", "/work", errors.New(first))
	if strings.Count(second, "What to do:") != 1 {
		t.Errorf("remedy duplicated on re-annotation:\n%s", second)
	}
	if annotateDevStartError("flutter", "/work", nil) != "" {
		t.Error("nil error should annotate to an empty string")
	}
}
