//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// layoutWithCurrentSymlink builds the exact on-disk shape every installed box
// has: a versioned directory holding the real binary, and a `current` symlink
// pointing at that directory.
//
//	<home>/.yaver/bin/1.99.386/linux-arm64/yaver   (real file)
//	<home>/.yaver/bin/current -> <home>/.yaver/bin/1.99.386
func layoutWithCurrentSymlink(t *testing.T) (home, realExe string) {
	t.Helper()
	home = t.TempDir()
	versionDir := filepath.Join(home, ".yaver", "bin", "1.99.386", "linux-arm64")
	if err := os.MkdirAll(versionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	realExe = filepath.Join(versionDir, "yaver")
	if err := os.WriteFile(realExe, []byte("#!/bin/sh\necho real binary\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(home, ".yaver", "bin", "1.99.386"),
		filepath.Join(home, ".yaver", "bin", "current")); err != nil {
		t.Fatal(err)
	}
	return home, realExe
}

// THE BRICK, as a test.
//
// ubuntu-4gb-hel1-1, 2026-08-01. ensureStableAutoStartExecutable computed
// stablePath = .../bin/current/linux-arm64/yaver, compared it to exePath as a
// STRING, saw two different strings, and proceeded to os.Remove(stablePath) —
// which, because `current` is a symlink to the version dir, deleted the running
// binary — then symlinked that path to itself. exec then failed with ELOOP,
// systemd reported status 203, and the unit sat in "activating" forever.
//
// If this test fails, the agent can destroy its own binary again.
func TestEnsureStableAutoStartExecutable_DoesNotDestroyBinaryBehindCurrentSymlink(t *testing.T) {
	home, realExe := layoutWithCurrentSymlink(t)
	t.Setenv("HOME", home)

	got := ensureStableAutoStartExecutable(realExe)

	// The binary must still exist, still be a regular file, and still be ours.
	info, err := os.Lstat(realExe)
	if err != nil {
		t.Fatalf("the running binary was DESTROYED: %v", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("the running binary was replaced by a symlink — this is the ELOOP brick")
	}
	body, err := os.ReadFile(realExe)
	if err != nil || string(body) == "" {
		t.Fatalf("binary unreadable after the call: %v", err)
	}

	// And whatever path it hands back must actually be executable content,
	// not a link that resolves to itself.
	if _, err := os.Stat(got); err != nil {
		t.Fatalf("returned path %q does not resolve: %v", got, err)
	}
}

// The guard has to be identity-based, not string-based. Same file reached by
// two different names must be recognised.
func TestPathsSameFile_SeesThroughTheCurrentSymlink(t *testing.T) {
	home, realExe := layoutWithCurrentSymlink(t)
	viaCurrent := filepath.Join(home, ".yaver", "bin", "current", "linux-arm64", "yaver")

	if realExe == viaCurrent {
		t.Fatal("fixture broken — the two paths must differ as strings")
	}
	if !pathsSameFile(realExe, viaCurrent) {
		t.Fatal("pathsSameFile missed two names for one inode — the string guard is back")
	}
}

func TestPathsSameFile_DistinctFilesAreNotSame(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a")
	b := filepath.Join(dir, "b")
	for _, p := range []string{a, b} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if pathsSameFile(a, b) {
		t.Fatal("two distinct files reported as the same")
	}
	if pathsSameFile(a, filepath.Join(dir, "missing")) {
		t.Fatal("a missing path must never compare equal")
	}
}

// When the paths genuinely differ, the link must still get created — the guard
// must not be so broad that it disables the feature it protects.
func TestEnsureStableAutoStartExecutable_StillLinksWhenTargetIsDistinct(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	versionDir := filepath.Join(home, ".yaver", "bin", "1.99.400", "linux-arm64")
	if err := os.MkdirAll(versionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	realExe := filepath.Join(versionDir, "yaver")
	if err := os.WriteFile(realExe, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	// No `current` symlink at all — stablePath is a genuinely new location.

	got := ensureStableAutoStartExecutable(realExe)
	want := filepath.Join(home, ".yaver", "bin", "current", "linux-arm64", "yaver")
	if got != want {
		t.Fatalf("got %q, want the stable path %q", got, want)
	}
	li, err := os.Lstat(want)
	if err != nil {
		t.Fatalf("stable link not created: %v", err)
	}
	if li.Mode()&os.ModeSymlink == 0 {
		t.Fatal("stable path should be a symlink")
	}
	if !pathsSameFile(want, realExe) {
		t.Fatal("the stable link does not resolve to the real binary")
	}
	// No temp artefact left behind.
	if _, err := os.Lstat(want + ".tmp-link"); !os.IsNotExist(err) {
		t.Fatal("temp link was left on disk")
	}
}
