package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestLiveManagedGitProviderRoundTrip is opt-in because it creates or updates
// public, explicitly named Yaver example repositories on GitHub and GitLab.
// It proves the same commit through all three paths: the Yaver Managed Git bare
// repo, the GitHub mirror, and the GitLab mirror. No credential is logged or
// written into the project worktree.
func TestLiveManagedGitProviderRoundTrip(t *testing.T) {
	if os.Getenv("YAVER_LIVE_MANAGED_GIT") != "1" {
		t.Skip("set YAVER_LIVE_MANAGED_GIT=1 with explicit project and repository names")
	}
	workDir := strings.TrimSpace(os.Getenv("YAVER_LIVE_MANAGED_GIT_PROJECT"))
	githubRepo := strings.TrimSpace(os.Getenv("YAVER_LIVE_MANAGED_GIT_GITHUB_REPO"))
	gitlabRepo := strings.TrimSpace(os.Getenv("YAVER_LIVE_MANAGED_GIT_GITLAB_REPO"))
	if workDir == "" || githubRepo == "" || gitlabRepo == "" {
		t.Fatal("YAVER_LIVE_MANAGED_GIT_PROJECT, _GITHUB_REPO, and _GITLAB_REPO are required")
	}
	if info, err := os.Stat(workDir); err != nil || !info.IsDir() {
		t.Fatalf("live project is not a directory: %v", err)
	}

	slug := filepath.Base(workDir)
	meta, err := EnsureManagedGitForProject(workDir, slug, "Yaver Mobile Workspace Todo Example", &ManagedGitCreateOptions{
		Enabled: true, Visibility: "public",
	})
	if err != nil {
		t.Fatalf("enable Yaver Managed Git: %v", err)
	}
	if _, err := ManagedGitCheckpoint(workDir, "chore: initialize mobile workspace example"); err != nil {
		t.Fatalf("initial Yaver Git checkpoint: %v", err)
	}

	marker := "Yaver Mobile Workspace git plumbing verified through Yaver Git, GitHub, and GitLab.\n"
	if err := os.WriteFile(filepath.Join(workDir, "git-plumbing.txt"), []byte(marker), 0o644); err != nil {
		t.Fatal(err)
	}
	commit, err := ManagedGitCheckpoint(workDir, "test: verify three-provider git plumbing")
	if err != nil {
		t.Fatalf("Yaver Git checkpoint: %v", err)
	}

	for _, provider := range []struct {
		kind, host, repo string
	}{
		{kind: "github", host: "github.com", repo: githubRepo},
		{kind: "gitlab", host: "gitlab.com", repo: gitlabRepo},
	} {
		mirror, mirrorErr := ManagedGitMirrorToProvider(
			workDir, provider.kind, provider.host, provider.repo, "public",
			"Yaver Mobile Workspace todo example created and rendered on a remote development box.",
		)
		if mirrorErr != nil {
			t.Fatalf("%s mirror: %v", provider.kind, mirrorErr)
		}
		// Call the same operation twice: onboarding retries and repeated Next taps
		// must update the mirror rather than trying to recreate it.
		if _, mirrorErr = ManagedGitMirrorToProvider(workDir, provider.kind, provider.host, provider.repo, "public", ""); mirrorErr != nil {
			t.Fatalf("%s idempotent mirror retry: %v", provider.kind, mirrorErr)
		}
		remote, lsErr := managedGitCmd("", "ls-remote", mirror.CloneURL, "refs/heads/main")
		if lsErr != nil || !strings.HasPrefix(strings.TrimSpace(remote), commit+"\t") {
			t.Fatalf("%s public mirror does not expose checkpoint %s: %v %s", provider.kind, commit, lsErr, strings.TrimSpace(remote))
		}
	}

	bareCommit, err := managedGitCmd("", "--git-dir", meta.BarePath, "rev-parse", "refs/heads/main")
	if err != nil || strings.TrimSpace(bareCommit) != commit {
		t.Fatalf("Yaver Git main = %q, want %q: %v", strings.TrimSpace(bareCommit), commit, err)
	}
}
