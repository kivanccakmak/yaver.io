package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func makeGitMarker(t *testing.T, parent, name string) string {
	t.Helper()
	repo := filepath.Join(parent, name)
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	return repo
}

func TestGitOperationLockFindsNearestGitMarker(t *testing.T) {
	repo := makeGitMarker(t, t.TempDir(), "checkout")
	nested := filepath.Join(repo, "packages", "app")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, want := canonicalGitOperationKey(nested), canonicalGitOperationKey(repo); got != want {
		t.Fatalf("nested checkout lock key = %q, want repository key %q", got, want)
	}
}

func TestGitOperationLockSerializesSameRepository(t *testing.T) {
	repo := makeGitMarker(t, t.TempDir(), "checkout")
	first := gitOperationLock(repo)
	second := gitOperationLock(filepath.Join(repo, "nested"))
	first.Lock()

	acquired := make(chan struct{})
	go func() {
		second.Lock()
		close(acquired)
		second.Unlock()
	}()

	select {
	case <-acquired:
		t.Fatal("second mutation entered while the same repository was locked")
	case <-time.After(50 * time.Millisecond):
	}
	first.Unlock()

	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatal("waiting mutation did not resume after repository unlock")
	}
}

func TestGitOperationLockDoesNotBlockDifferentRepositories(t *testing.T) {
	parent := t.TempDir()
	first := gitOperationLock(makeGitMarker(t, parent, "one"))
	second := gitOperationLock(makeGitMarker(t, parent, "two"))
	first.Lock()
	defer first.Unlock()

	acquired := make(chan struct{})
	go func() {
		second.Lock()
		close(acquired)
		second.Unlock()
	}()
	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatal("an unrelated repository was blocked")
	}
}
