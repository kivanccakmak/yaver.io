package main

// A refusal must name the way FORWARD.
//
// talos (a monorepo) answered "monorepo projects use none, not WebRTC remote
// runtime" — accurate, and a dead end. The runnable things are one level in
// (talos/mobile, talos/cloud, talos/scanner-suite …), and the product knew that
// and didn't say it. Measured on the mini 2026-07-25.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunnableSubProjectsNamesTheWayForward(t *testing.T) {
	root := t.TempDir()
	for dir, marker := range map[string]string{
		"mobile":        "package.json",
		"cloud":         "package.json",
		"scanner-suite": "package.json",
		"flutter-app":   "pubspec.yaml",
		"ios-thing":     "Package.swift",
		"android-thing": "build.gradle.kts",
	} {
		full := filepath.Join(root, dir)
		os.MkdirAll(full, 0o755)
		os.WriteFile(filepath.Join(full, marker), []byte("{}"), 0o644)
	}
	// Noise that must never be offered as a next step.
	for _, junk := range []string{"node_modules", ".git", "docs"} {
		os.MkdirAll(filepath.Join(root, junk), 0o755)
	}
	os.WriteFile(filepath.Join(root, "node_modules", "package.json"), []byte("{}"), 0o644)

	got := runnableSubProjects(root)
	joined := strings.Join(got, ",")
	for _, want := range []string{"mobile", "cloud", "flutter-app", "ios-thing", "android-thing"} {
		if !strings.Contains(joined, want) {
			t.Errorf("%q missing from the suggestions: %v", want, got)
		}
	}
	for _, unwanted := range []string{"node_modules", ".git", "docs"} {
		if strings.Contains(joined, unwanted) {
			t.Errorf("%q was offered as a runnable project: %v", unwanted, got)
		}
	}
	// Sorted, for a message that doesn't reshuffle between calls.
	for i := 1; i < len(got); i++ {
		if got[i-1] > got[i] {
			t.Errorf("suggestions are unsorted, so the same repo prints differently each time: %v", got)
			break
		}
	}
}

func TestRunnableSubProjectsEmptyForALeafProject(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "package.json"), []byte("{}"), 0o644)
	if got := runnableSubProjects(root); len(got) != 0 {
		t.Errorf("a leaf project should suggest nothing (the caller then keeps its own message): %v", got)
	}
	if got := runnableSubProjects(filepath.Join(root, "nope")); got != nil {
		t.Errorf("unreadable dir should yield nil: %v", got)
	}
}

func TestRunnableSubProjectsCapsTheList(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 20; i++ {
		d := filepath.Join(root, string(rune('a'+i))+"-app")
		os.MkdirAll(d, 0o755)
		os.WriteFile(filepath.Join(d, "package.json"), []byte("{}"), 0o644)
	}
	got := runnableSubProjects(root)
	if len(got) > 9 {
		t.Errorf("an unbounded list is unreadable in an error message: %d entries", len(got))
	}
	if !strings.Contains(strings.Join(got, ","), "more") {
		t.Errorf("truncation must SAY it truncated, or the user thinks that's all there is: %v", got)
	}
}
