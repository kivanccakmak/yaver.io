package main

// Guards for the autostash-conflict false green (incident 2026-07-27):
// `git pull --rebase --autostash` EXITS 0 when the rebase succeeds but the
// autostash re-apply conflicts — git parks the stash, leaves `<<<<<<<`
// conflict markers + unmerged (UU) index entries, prints a warning, and
// reports success via exit code. The old executePullDecision read the exit
// code and logged "[pre-build-pull] git pull --rebase --autostash
// succeeded"; Metro then burned ~11 s to die on the conflict markers with a
// cryptic "Unexpected token".
//
// Real git repos throughout, per house convention — the whole point is
// that REAL git produces exit 0 over a conflicted tree; a mock would be
// asserting our own assumption back at us. Reuses the repo helpers from
// devserver_pull_fast_test.go (initBareRemote / cloneAndConfig / gitInDir).

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// setupAutostashConflictState reproduces the incident's pre-pull state:
// a clone that is one commit behind its upstream with a dirty edit that
// conflicts with the upstream commit. Returns the workdir of the clone
// that is about to run the pull.
func setupAutostashConflictState(t *testing.T) string {
	t.Helper()
	remote := initBareRemote(t)

	// Seed clone "a": commit the file, push, then advance it remotely.
	a := cloneAndConfig(t, remote)
	appFile := filepath.Join(a, "app.tsx")
	if err := os.WriteFile(appFile, []byte("export const x = 'original'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitInDir(t, a, "add", "app.tsx")
	gitInDir(t, a, "commit", "-q", "-m", "init")
	gitInDir(t, a, "push", "-q", "-u", "origin", "main")

	// Clone "b" — this is the box that will pull.
	b := cloneAndConfig(t, remote)

	// Divergent remote commit from "a".
	if err := os.WriteFile(appFile, []byte("export const x = 'remote change'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitInDir(t, a, "commit", "-q", "-am", "remote change")
	gitInDir(t, a, "push", "-q")

	// Conflicting dirty (uncommitted) edit in "b" — the autostash payload.
	if err := os.WriteFile(filepath.Join(b, "app.tsx"), []byte("export const x = 'local conflicting edit'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return b
}

// TestExecutePullDecision_AutostashConflictIsNotSuccess is guard (1):
// after a pull whose exit code lies, the summary must name the conflicted
// files + the remedy and err must be non-nil. Never the word "succeeded"
// over a conflicted tree.
func TestExecutePullDecision_AutostashConflictIsNotSuccess(t *testing.T) {
	b := setupAutostashConflictState(t)

	summary, err := executePullDecision(b, preBuildPullDecision{Action: pullActionRebaseAutostash})

	// Honesty check on the reproduction itself: the tree must actually be
	// in the unmerged state the incident produced. If git's behavior ever
	// changes (pull starts failing loudly), this fails first and tells us
	// the guard is now redundant rather than broken.
	porcelain := gitInDir(t, b, "status", "--porcelain")
	if !strings.Contains(porcelain, "UU app.tsx") {
		t.Fatalf("reproduction broke: expected UU app.tsx in porcelain status, got:\n%s\n(summary=%q err=%v)", porcelain, summary, err)
	}

	if err == nil {
		t.Fatalf("executePullDecision returned nil error over a conflicted tree; summary=%q", summary)
	}
	if strings.Contains(summary, "succeeded") {
		t.Errorf("summary says %q over a conflicted tree — the false green is back", summary)
	}
	if !strings.Contains(summary, "app.tsx") {
		t.Errorf("summary must name the conflicted file; got %q", summary)
	}
	if !strings.Contains(summary, "left conflicts in") || !strings.Contains(summary, "git checkout --ours") {
		t.Errorf("summary must state the cause and the remedy; got %q", summary)
	}
	// The autostash must still be parked in the stash — that's part of the
	// remedy sentence, so it had better be true.
	if stash := gitInDir(t, b, "stash", "list"); !strings.Contains(stash, "autostash") {
		t.Errorf("expected the autostash to be kept in git stash; stash list:\n%s", stash)
	}
}

// TestPreflightWebBundle_RefusesUnmergedTree is guard (2): the
// web-js-bundle preflight must refuse an unmerged tree BEFORE the bundler
// spawns, naming the files and the remedy — instead of ok=true followed by
// Metro dying on "Unexpected token".
func TestPreflightWebBundle_RefusesUnmergedTree(t *testing.T) {
	b := setupAutostashConflictState(t)
	// Drive the real pull to produce the real UU state.
	_, _ = executePullDecision(b, preBuildPullDecision{Action: pullActionRebaseAutostash})
	if porcelain := gitInDir(t, b, "status", "--porcelain"); !strings.Contains(porcelain, "UU app.tsx") {
		t.Fatalf("reproduction broke: expected UU app.tsx, got:\n%s", porcelain)
	}

	report := preflightWebBundle(b)
	if report.OK {
		t.Fatalf("preflight said ok=true over an unmerged tree: %+v", report)
	}
	joined := strings.Join(report.Errors, " | ")
	if !strings.Contains(joined, "app.tsx") {
		t.Errorf("preflight error must name the conflicted file; got %q", joined)
	}
	if !strings.Contains(joined, "unresolved merge conflicts") || !strings.Contains(joined, "git checkout --ours") {
		t.Errorf("preflight error must state the cause and the remedy; got %q", joined)
	}
}

// TestPreflightWebBundle_NonGitDirSkipsConflictCheck: advisory work must
// not block the operation it annotates — no git repo (or no git at all)
// means the conflict check silently skips, it does not fail the build.
func TestPreflightWebBundle_NonGitDirSkipsConflictCheck(t *testing.T) {
	dir := t.TempDir() // plain directory, not a git repo
	report := preflightWebBundle(dir)
	if !report.OK {
		t.Fatalf("preflight must not fail a non-git workDir; got %+v", report)
	}
	if files := unmergedTreeFiles(dir); files != nil {
		t.Fatalf("unmergedTreeFiles on a non-repo must return nil, got %v", files)
	}
}
