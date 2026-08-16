package main

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func syncGitCmd(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s in %s: %v\n%s", strings.Join(args, " "), dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

func syncWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func setupSyncRepos(t *testing.T) (seed, local, origin string) {
	t.Helper()
	root := t.TempDir()
	origin = filepath.Join(root, "origin.git")
	seed = filepath.Join(root, "seed")
	local = filepath.Join(root, "local")
	syncGitCmd(t, "", "init", "--bare", origin)
	syncGitCmd(t, "", "clone", origin, seed)
	syncGitCmd(t, seed, "config", "user.email", "sync-test@yaver.invalid")
	syncGitCmd(t, seed, "config", "user.name", "Yaver Sync Test")
	syncGitCmd(t, seed, "checkout", "-b", "main")
	syncWrite(t, filepath.Join(seed, "shared.txt"), "base\n")
	syncGitCmd(t, seed, "add", "shared.txt")
	syncGitCmd(t, seed, "commit", "-m", "base")
	syncGitCmd(t, seed, "push", "-u", "origin", "main")
	syncGitCmd(t, "", "clone", "--branch", "main", origin, local)
	syncGitCmd(t, local, "config", "user.email", "sync-test@yaver.invalid")
	syncGitCmd(t, local, "config", "user.name", "Yaver Sync Test")
	return seed, local, origin
}

func TestGitSyncRemoteAbortsCleanRebaseConflict(t *testing.T) {
	seed, local, _ := setupSyncRepos(t)
	syncWrite(t, filepath.Join(local, "shared.txt"), "local commit\n")
	syncGitCmd(t, local, "add", "shared.txt")
	syncGitCmd(t, local, "commit", "-m", "local")
	originalHead := syncGitCmd(t, local, "rev-parse", "HEAD")

	syncWrite(t, filepath.Join(seed, "shared.txt"), "remote commit\n")
	syncGitCmd(t, seed, "add", "shared.txt")
	syncGitCmd(t, seed, "commit", "-m", "remote")
	syncGitCmd(t, seed, "push")

	status, resp := runGitSyncRemote(local)
	if status != http.StatusConflict || !resp.RequiresAgent || len(resp.Conflicts) != 1 {
		t.Fatalf("conflict was not structured: status=%d resp=%+v", status, resp)
	}
	if got := syncGitCmd(t, local, "rev-parse", "HEAD"); got != originalHead {
		t.Fatalf("abort changed HEAD: got %s want %s", got, originalHead)
	}
	if got := syncGitCmd(t, local, "status", "--porcelain"); got != "" {
		t.Fatalf("aborted clean-tree rebase left changes: %q", got)
	}
}

func TestGitSyncRemoteDetectsZeroExitAutostashConflictAndDoesNotPush(t *testing.T) {
	seed, local, origin := setupSyncRepos(t)
	syncWrite(t, filepath.Join(local, "shared.txt"), "dirty local edit\n")

	syncWrite(t, filepath.Join(seed, "shared.txt"), "remote edit\n")
	syncGitCmd(t, seed, "add", "shared.txt")
	syncGitCmd(t, seed, "commit", "-m", "remote")
	syncGitCmd(t, seed, "push")
	remoteBefore := syncGitCmd(t, "", "--git-dir", origin, "rev-parse", "refs/heads/main")

	status, resp := runGitSyncRemote(local)
	if status != http.StatusConflict || !resp.RequiresAgent || resp.Pushed || len(resp.Conflicts) != 1 {
		t.Fatalf("zero-exit autostash conflict was a false success: status=%d resp=%+v", status, resp)
	}
	if got := syncGitCmd(t, "", "--git-dir", origin, "rev-parse", "refs/heads/main"); got != remoteBefore {
		t.Fatalf("sync pushed while autostash was conflicted: got %s want %s", got, remoteBefore)
	}
	if stash := syncGitCmd(t, local, "stash", "list"); !strings.Contains(strings.ToLower(stash), "autostash") {
		t.Fatalf("Git did not retain the recovery stash: %s", stash)
	}
}

func TestGitSyncRemoteRejectsDetachedHeadBeforePull(t *testing.T) {
	_, local, _ := setupSyncRepos(t)
	syncGitCmd(t, local, "checkout", "--detach")
	status, resp := runGitSyncRemote(local)
	if status != http.StatusConflict || !strings.Contains(resp.Error, "detached HEAD") {
		t.Fatalf("detached HEAD was not refused: status=%d resp=%+v", status, resp)
	}
	if len(resp.Actions) != 0 {
		t.Fatalf("detached HEAD performed sync actions: %v", resp.Actions)
	}
}
