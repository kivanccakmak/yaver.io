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

// A dev server can be healthy and still have nothing to serve. That case looked
// identical to success on every surface: readiness passed, the proxy answered
// index.html with 200, and the phone rendered black forever.
//
// Verbatim from a real project on 2026-07-25 (Flutter 3.44 + a lock file pinning
// font_awesome_flutter 10.12.0, whose IconData subclassing broke when IconData
// became a final class).
func TestCompileFailureIsRecognisedAndExplained(t *testing.T) {
	tail := []string{
		"Waiting for connection from debug service on Web Server...",
		"../../.pub-cache/hosted/pub.dev/font_awesome_flutter-10.12.0/lib/src/icon_data.dart:104:36: Error: The class 'IconData' can't be extended outside of its library because it's a final class.",
		"class IconDataSharpRegular extends IconData {",
		"^",
		"Failed to compile application.",
	}

	if !devBuildFailureLine("Failed to compile application.") {
		t.Error("the Flutter summary line was not recognised as a build failure — the preview would keep looking healthy")
	}
	for _, other := range []string{
		"error: Failed to compile.",                         // Next.js
		"Bundling failed 3721ms",                            // Metro
		"Unable to resolve module ./missing from index.js",  // Metro
		"The following build commands failed: CompileSwift", // xcodebuild
	} {
		if !devBuildFailureLine(other) {
			t.Errorf("not recognised as a build failure: %q", other)
		}
	}
	for _, healthy := range []string{
		"Compiling lib/main.dart for the Web...",
		"Waiting for connection from debug service on Web Server...",
		"",
	} {
		if devBuildFailureLine(healthy) {
			t.Errorf("healthy output misread as a build failure: %q", healthy)
		}
	}

	lines := compileErrorLines(tail)
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "font_awesome_flutter") {
		t.Errorf("the explanation drops the offending package, which is the ONE thing the user must change:\n%s", joined)
	}
	if !strings.Contains(joined, "Failed to compile application.") {
		t.Errorf("the explanation drops the summary line:\n%s", joined)
	}
	for _, noise := range []string{"^", "Waiting for connection"} {
		if strings.Contains(joined, noise) {
			t.Errorf("noise line %q survived into the explanation:\n%s", noise, joined)
		}
	}
	if len(lines) > 6 {
		t.Errorf("explanation is %d lines — a failure panel nobody reads is a failure panel that does not work", len(lines))
	}
}

func TestCompileErrorLinesFallsBackToTheRawTail(t *testing.T) {
	tail := []string{"something inscrutable happened", "and then it stopped"}
	got := compileErrorLines(tail)
	if len(got) == 0 {
		t.Fatal("an unrecognised tail produced NO explanation — saying nothing is the failure mode we are removing")
	}
}
