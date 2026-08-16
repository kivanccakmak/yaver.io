package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func testGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestValidGitRef(t *testing.T) {
	for _, ref := range []string{"HEAD", "main", "feature/cloud-studio", "v1.2.3"} {
		if !validGitRef(ref) {
			t.Errorf("expected valid ref %q", ref)
		}
	}
	for _, ref := range []string{"", "--help", "main..evil", "refs/@{1}", "bad ref", "topic~1"} {
		if validGitRef(ref) {
			t.Errorf("expected invalid ref %q", ref)
		}
	}
}

func TestProjectSessionLifecycleAndIsolation(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)
	t.Setenv("GIT_AUTHOR_NAME", "Yaver Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@yaver.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Yaver Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@yaver.invalid")

	source := filepath.Join(tempHome, "source-project")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	testGit(t, source, "init", "-b", "main")
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("hello\n"), 0600); err != nil {
		t.Fatal(err)
	}
	testGit(t, source, "add", "README.md")
	testGit(t, source, "commit", "-m", "initial")

	configDir, err := ConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	projects := "# Yaver Local Context\n\n## Projects\n\n### " + source + "\n- Branch: main\n"
	if err := os.WriteFile(filepath.Join(configDir, projectsFileName), []byte(projects), 0600); err != nil {
		t.Fatal(err)
	}

	repositories, err := ListGitRepositories(false)
	if err != nil || len(repositories) != 1 {
		t.Fatalf("repositories = %#v, err = %v", repositories, err)
	}
	manager, err := NewProjectSessionManager()
	if err != nil {
		t.Fatal(err)
	}
	session, err := manager.Create(repositories[0].RepositoryID, "main")
	if err != nil {
		t.Fatal(err)
	}
	if session.WorkDir == source || !strings.HasPrefix(session.ReviewBranch, "yaver/cloud-") {
		t.Fatalf("session is not isolated: %#v", session)
	}
	encoded, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), session.WorkDir) || strings.Contains(string(encoded), source) {
		t.Fatalf("session JSON exposed runner paths: %s", encoded)
	}

	if err := os.WriteFile(filepath.Join(session.WorkDir, "README.md"), []byte("hello from Cloud Studio\n"), 0600); err != nil {
		t.Fatal(err)
	}
	diff, err := manager.GitDiff(session.ProjectSessionID)
	if err != nil || !strings.Contains(diff, "hello from Cloud Studio") {
		t.Fatalf("diff = %q, err = %v", diff, err)
	}
	sha, err := manager.GitCommit(session.ProjectSessionID, "Update readme")
	if err != nil || len(sha) < 7 {
		t.Fatalf("commit SHA = %q, err = %v", sha, err)
	}
	if _, err := manager.PushReview(session.ProjectSessionID); err == nil || !strings.Contains(err.Error(), "HTTPS or SSH") {
		t.Fatalf("local-origin push should be rejected, got %v", err)
	}
	stopped, err := manager.Stop(session.ProjectSessionID)
	if err != nil || stopped.Status != "stopped" {
		t.Fatalf("stop = %#v, err = %v", stopped, err)
	}

	reloaded, err := NewProjectSessionManager()
	if err != nil {
		t.Fatal(err)
	}
	loaded, ok := reloaded.Get(session.ProjectSessionID)
	if !ok || loaded.Status != "stopped" {
		t.Fatalf("reloaded session = %#v, ok = %v", loaded, ok)
	}
	if _, err := reloaded.Delete(session.ProjectSessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(session.WorkDir); !os.IsNotExist(err) {
		t.Fatalf("deleted checkout still exists: %v", err)
	}
	finalManager, err := NewProjectSessionManager()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := finalManager.Get(session.ProjectSessionID); ok {
		t.Fatal("deleted session was restored from registry")
	}
}
