package main

import "testing"

func TestGitHubCreateRepoTarget(t *testing.T) {
	for _, tc := range []struct {
		name, authUser, input, endpoint, repo string
	}{
		{
			name: "personal shorthand", input: "mobile-todo",
			endpoint: "https://api.github.com/user/repos", repo: "mobile-todo",
		},
		{
			name: "explicit authenticated user", authUser: "yaver-user", input: "YAVER-USER/mobile-todo",
			endpoint: "https://api.github.com/user/repos", repo: "mobile-todo",
		},
		{
			name: "organization", authUser: "yaver-user", input: "yaver-io/mobile-todo",
			endpoint: "https://api.github.com/orgs/yaver-io/repos", repo: "mobile-todo",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			endpoint, repo, err := githubCreateRepoTarget(tc.authUser, tc.input)
			if err != nil {
				t.Fatal(err)
			}
			if endpoint != tc.endpoint || repo != tc.repo {
				t.Fatalf("target = (%q, %q), want (%q, %q)", endpoint, repo, tc.endpoint, tc.repo)
			}
		})
	}
}

func TestGitHubCreateRepoTargetRejectsNestedPath(t *testing.T) {
	if _, _, err := githubCreateRepoTarget("user", "org/team/repo"); err == nil {
		t.Fatal("nested GitHub repository path must be rejected")
	}
}

func TestManagedGitMirrorMatchesQualifiedAndPersonalNames(t *testing.T) {
	github := ManagedGitMirrorMeta{Provider: "github", Host: "github.com", FullName: "yaver-io/mobile-todo"}
	if !managedGitMirrorMatches(github, "github", "github.com", "yaver-io/mobile-todo") {
		t.Fatal("qualified GitHub mirror should be reusable")
	}
	gitlab := ManagedGitMirrorMeta{Provider: "gitlab", Host: "gitlab.com", FullName: "example-user/mobile-todo"}
	if !managedGitMirrorMatches(gitlab, "gitlab", "gitlab.com", "mobile-todo") {
		t.Fatal("personal GitLab mirror should match its repository basename")
	}
	if managedGitMirrorMatches(gitlab, "github", "github.com", "mobile-todo") {
		t.Fatal("a mirror from another provider must not match")
	}
}
