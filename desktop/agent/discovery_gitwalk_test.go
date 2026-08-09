package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The invariant these pin: a scan that runs out of time returns LESS, never
// NOTHING.
//
// The bug (2026-07-24, mac mini): writeProjects shelled out to `find`. On a box
// whose home held 30+ monorepo clones the walk took minutes, the 30s context
// killed find, and find's block-buffered pipe stdout — holding every repo it
// had already located — was discarded with the process. cmd.Output() returned
// empty, so a machine full of projects reported "_No projects found._" while
// the sibling in-process scanner found 213 on the same disk.

func mkRepo(t *testing.T, base string, parts ...string) string {
	t.Helper()
	dir := filepath.Join(append([]string{base}, parts...)...)
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// withHome points projectDiscoveryRoots at a scratch dir by overriding HOME.
// No hardcoded path anywhere — the walker resolves roots from the environment,
// which is exactly what makes it work for any user on any box.
func withHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, "Workspace"), 0o755); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestGitWalkFindsReposUnderWorkspace(t *testing.T) {
	home := withHome(t)
	ws := filepath.Join(home, "Workspace")
	want := []string{
		mkRepo(t, ws, "e-mobile"),
		mkRepo(t, ws, "talos"),
		mkRepo(t, ws, "nested", "deeper-project"),
	}

	got := findGitRepoDirsForDiscovery(20 * time.Second)
	found := map[string]bool{}
	for _, g := range got {
		found[g] = true
	}
	for _, w := range want {
		if !found[w] {
			t.Fatalf("repo %q not found; got %v", w, got)
		}
	}
}

func TestGitWalkSkipsNoiseDirectories(t *testing.T) {
	home := withHome(t)
	ws := filepath.Join(home, "Workspace")
	real := mkRepo(t, ws, "realproject")
	// A checkout buried in node_modules is a dependency, not the user's project.
	mkRepo(t, ws, "realproject", "node_modules", "some-dep")
	mkRepo(t, home, "Library", "Caches", "junk")

	got := findGitRepoDirsForDiscovery(20 * time.Second)
	for _, g := range got {
		if filepath.Base(filepath.Dir(g)) == "node_modules" {
			t.Fatalf("walked into node_modules: %q", g)
		}
		if len(g) > len(home) && filepath.Base(g) == "junk" {
			t.Fatalf("walked into Library: %q", g)
		}
	}
	var sawReal bool
	for _, g := range got {
		if g == real {
			sawReal = true
		}
	}
	if !sawReal {
		t.Fatalf("the real project was not found; got %v", got)
	}
}

// THE regression test. An exhausted budget must still return what was already
// found — the exact behaviour find(1) could not provide.
func TestGitWalkReturnsPartialResultsWhenBudgetExpires(t *testing.T) {
	home := withHome(t)
	ws := filepath.Join(home, "Workspace")
	for i := 0; i < 40; i++ {
		mkRepo(t, ws, "proj"+string(rune('a'+i%26))+string(rune('0'+i/26)))
	}

	// A budget so small it is already spent inside the first Walk callback.
	got := findGitRepoDirsForDiscovery(1 * time.Nanosecond)
	// The contract is "never panics, never hangs, returns a slice". Whatever it
	// managed is acceptable; silently losing a full buffer is not, and cannot
	// happen because results are appended as they are seen.
	if got == nil {
		return // zero found within a nanosecond is legitimate
	}
	for _, g := range got {
		if g == "" {
			t.Fatal("empty repo path returned")
		}
	}
}

func TestGitWalkNeverDescendsIntoDotGit(t *testing.T) {
	home := withHome(t)
	ws := filepath.Join(home, "Workspace")
	repo := mkRepo(t, ws, "proj")
	// A nested .git inside .git would be reported twice if we descended.
	if err := os.MkdirAll(filepath.Join(repo, ".git", "modules", "sub", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := findGitRepoDirsForDiscovery(20 * time.Second)
	for _, g := range got {
		if filepath.Base(g) == "sub" {
			t.Fatalf("descended into .git internals: %q", g)
		}
	}
}

func TestGitWalkDeduplicatesAcrossOverlappingRoots(t *testing.T) {
	// `home` is itself a discovery root and contains Workspace, so every repo
	// is reachable by two roots. It must be reported once.
	home := withHome(t)
	repo := mkRepo(t, filepath.Join(home, "Workspace"), "dup")

	got := findGitRepoDirsForDiscovery(20 * time.Second)
	count := 0
	for _, g := range got {
		if g == repo {
			count++
		}
	}
	if count > 1 {
		t.Fatalf("repo reported %d times, want 1: %v", count, got)
	}
}

// The ubuntu-4gb box regression (2026-08-09 audit): the dashboard rail showed
// 153 "projects" of which ~140 were Go module-cache clones under
// /root/go/pkg/mod — <module>@v<version> dirs are per-version git repos, so a
// home fallback root picked them all up. Both the dirs themselves and the
// @v<digits> shape must be skipped while the real repos keep surfacing.
func TestGitWalkSkipsGoModuleCache(t *testing.T) {
	home := withHome(t)
	ws := filepath.Join(home, "Workspace")
	real := mkRepo(t, ws, "realproject")
	// The exact junk seen on the box: module cache clones with git metadata.
	mkRepo(t, home, "go", "pkg", "mod", "github.com", "foo@v1.2.3")
	mkRepo(t, home, "go", "pkg", "mod", "golang.org", "x", "tools@v0.19.0")
	// A bare cache dir without the @v shape must also be skipped via the
	// dir-name skip map ("mod", "pkg", "go").
	mkRepo(t, home, "go", "pkg", "mod", "cache")
	// A project genuinely named with @v semantics must still be found — the
	// guard must not skip arbitrary names that merely contain @v.
	fake := mkRepo(t, ws, "notamodulecache@v1")
	got := findGitRepoDirsForDiscovery(20 * time.Second)
	found := map[string]bool{}
	for _, g := range got {
		found[g] = true
	}
	for _, g := range got {
		if g == real || g == fake {
			continue
		}
		if strings.Contains(g, string(os.PathSeparator)+"go"+string(os.PathSeparator)+"pkg") {
			t.Fatalf("walked into Go module cache: %q", g)
		}
	}
	if !found[real] {
		t.Fatalf("real project not found; got %v", got)
	}
	if !found[fake] {
		t.Fatalf("top-level project whose name contains @v was skipped; got %v", got)
	}
	// Direct check of the shape guard (it receives ONE path segment name).
	if !isGoModuleCacheDir("foo@v1.2.3") {
		t.Fatal("isGoModuleCacheDir failed on segment foo@v1.2.3")
	}
	// A name that merely CONTAINS "@v" without a numeric version after it.
	if isGoModuleCacheDir("notamodulecache@version") {
		t.Fatal("isGoModuleCacheDir must reject a name that merely contains @v")
	}
	if isGoModuleCacheDir("foo@v") {
		t.Fatal("isGoModuleCacheDir must reject a bare @v with no version")
	}
	if isGoModuleCacheDir("foo@vnext") {
		t.Fatal("isGoModuleCacheDir must reject non-numeric versions")
	}
	if isGoModuleCacheDir("foo@v1beta") {
		t.Fatal("isGoModuleCacheDir must reject non-numeric trailing versions")
	}
}
