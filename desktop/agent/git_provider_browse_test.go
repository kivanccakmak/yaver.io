package main

import "testing"

func TestParseRepoRefRejectsHostAndPathInjection(t *testing.T) {
	for _, tc := range []struct{ host, repo string }{
		{"https://github.com", "owner/repo"},
		{"github.com/path", "owner/repo"},
		{"github.com", "repo"},
		{"github.com", "owner/../repo"},
	} {
		if _, err := parseRepoRef(tc.host, tc.repo); err == nil {
			t.Errorf("parseRepoRef(%q, %q) accepted an unsafe reference", tc.host, tc.repo)
		}
	}
}

func TestProviderRepoEscapingPreservesNestedFilePaths(t *testing.T) {
	ref, err := parseRepoRef("github.com", "owner/repo name")
	if err != nil {
		t.Fatal(err)
	}
	slug, err := ref.githubRepoSlug()
	if err != nil {
		t.Fatal(err)
	}
	if slug != "owner/repo%20name" {
		t.Fatalf("github slug = %q", slug)
	}
	if got := escapedPathSegments("docs/setup guide/read me.md"); got != "docs/setup%20guide/read%20me.md" {
		t.Fatalf("nested file path = %q", got)
	}

	gitlab, err := parseRepoRef("gitlab.example.com", "group/subgroup/repo")
	if err != nil {
		t.Fatal(err)
	}
	if gitlab.Full != "group/subgroup/repo" {
		t.Fatalf("GitLab nested repo = %q", gitlab.Full)
	}
	if _, err := gitlab.githubRepoSlug(); err == nil {
		t.Fatal("nested GitLab path was accepted as a GitHub owner/repo slug")
	}
}
