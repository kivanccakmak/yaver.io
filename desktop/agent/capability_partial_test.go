package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// THE STUCK STATE, reproduced exactly. An install killed during `tar -xJf`
// leaves an executable bin/flutter over a 15%-extracted tree. Before the
// marker, runFlutterInstall saw that and announced "already installed" —
// success, forever, over an SDK that cannot run.
//
// BREAK IT: make installTreeIsComplete return true whenever the root exists
// (the old `os.Stat(flutterBin)` logic) and this fails.
func TestAPartiallyExtractedTreeIsNotMistakenForAnInstall(t *testing.T) {
	root := filepath.Join(t.TempDir(), "flutter")
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	// What tar leaves behind when it is killed early: the executable, nothing else.
	if err := os.WriteFile(filepath.Join(root, "bin", "flutter"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if flutterSDKLooksComplete(root) {
		t.Fatal("bin/flutter alone must not read as a complete SDK — that is the false green")
	}
	if installTreeIsComplete(root, func() bool { return flutterSDKLooksComplete(root) }) {
		t.Fatal("no marker AND not usable ⇒ partial; anything else repeats the incident")
	}
}

// The mirror image, and the one that protects a real 1.2 GB SDK: a tree that
// predates the marker but WORKS must be adopted, never deleted. A "cleanup"
// that eats a working toolchain to fix a bookkeeping gap is a much worse bug.
func TestAPreMarkerButWorkingTreeIsAdoptedNotDeleted(t *testing.T) {
	root := filepath.Join(t.TempDir(), "flutter")
	for _, rel := range []string{"bin/internal", "packages/flutter"} {
		if err := os.MkdirAll(filepath.Join(root, rel), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "flutter"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if !installTreeIsComplete(root, func() bool { return flutterSDKLooksComplete(root) }) {
		t.Fatal("a usable pre-marker SDK must be treated as complete")
	}
	// Adoption stamps the marker so the next check is cheap and certain.
	if _, err := os.Stat(installMarkerPath(root)); err != nil {
		t.Errorf("adoption must stamp the marker: %v", err)
	}
	// And beginToolInstall must leave it alone.
	if note := beginToolInstall("flutter", root, func() bool { return flutterSDKLooksComplete(root) }, nil); note != "" {
		t.Errorf("a complete tree must not be touched, got note %q", note)
	}
	if _, err := os.Stat(filepath.Join(root, "packages", "flutter")); err != nil {
		t.Errorf("beginToolInstall deleted a working SDK: %v", err)
	}
}

// SELF-CLEARING: the partial tree goes away before the next install writes a
// byte, and the removal ANNOUNCES itself. A silent 800 MB delete is as
// unfalsifiable as a silent serve.
func TestBeginToolInstallClearsAPartialTreeAndSaysSo(t *testing.T) {
	root := filepath.Join(t.TempDir(), "nested", "flutter")
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "flutter"), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}

	var streamed []string
	note := beginToolInstall("flutter", root, func() bool { return flutterSDKLooksComplete(root) },
		func(s string) { streamed = append(streamed, s) })

	if note == "" {
		t.Fatal("clearing a partial tree must be reported, not done silently")
	}
	if !strings.Contains(note, root) {
		t.Errorf("the note must name the path removed, got %q", note)
	}
	if len(streamed) == 0 {
		t.Error("the note must reach the progress stream the user is watching")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Errorf("the partial tree survived: %v", err)
	}
}

// The destructive-path gate. These are the paths a bug (or a bad FLUTTER_ROOT
// env var) could aim the cleaner at.
func TestPartialRemovalRefusesDangerousRoots(t *testing.T) {
	for _, bad := range []string{"", "relative/path", string(filepath.Separator), "/opt"} {
		if err := partialRemovalAllowed(bad); err == nil {
			t.Errorf("partialRemovalAllowed(%q) allowed a dangerous target", bad)
		}
	}
	if home := capabilityHomeDir(); home != "" {
		if err := partialRemovalAllowed(home); err == nil {
			t.Error("the home directory must never be a removal target")
		}
	}
	if err := partialRemovalAllowed("/opt/flutter/sdk"); err != nil {
		t.Errorf("a real nested toolchain root must be allowed: %v", err)
	}
}

// Stranded downloads: the installers' `defer os.Remove` does not run through a
// SIGKILL, so a killed install leaves its archive in /tmp — disk the box never
// gets back, and on a small volume the next failure.
func TestStrandedDownloadsAreClearedAndNarrowlyMatched(t *testing.T) {
	tmp := os.TempDir()
	stranded := filepath.Join(tmp, "flutter_linux_3.27.4-stable.tar.xz")
	if err := os.WriteFile(stranded, []byte("partial"), 0o644); err != nil {
		t.Skipf("cannot write to temp dir: %v", err)
	}
	defer os.Remove(stranded)

	// Something that must NEVER match — a user's own export sitting in /tmp.
	innocent := filepath.Join(tmp, "my-backup-2026.tar.xz")
	if err := os.WriteFile(innocent, []byte("precious"), 0o644); err != nil {
		t.Skip("cannot write to temp dir")
	}
	defer os.Remove(innocent)

	found := strandedInstallDebris("flutter")
	var sawStranded, sawInnocent bool
	for _, f := range found {
		if f == stranded {
			sawStranded = true
		}
		if f == innocent {
			sawInnocent = true
		}
	}
	if !sawStranded {
		t.Errorf("the stranded flutter archive was not found in %v", found)
	}
	if sawInnocent {
		t.Fatal("the debris glob matched a file Yaver did not download — that glob deletes user data")
	}

	beginToolInstall("flutter", "", nil, nil)
	if _, err := os.Stat(stranded); !os.IsNotExist(err) {
		t.Errorf("stranded download survived: %v", err)
	}
	if _, err := os.Stat(innocent); err != nil {
		t.Fatalf("beginToolInstall deleted a file it did not create: %v", err)
	}
}

// A tool with no debris pattern must produce no glob at all. A default that
// matched "*.tar.xz" would delete user archives on every install.
func TestUnknownToolsHaveNoDebrisGlob(t *testing.T) {
	if got := strandedInstallDebris("some-tool-yaver-never-heard-of"); len(got) != 0 {
		t.Errorf("an unknown tool must claim no debris, got %v", got)
	}
}
