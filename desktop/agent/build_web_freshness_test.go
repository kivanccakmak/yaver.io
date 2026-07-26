package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// shellGitInit creates a real git repo with one commit and returns the
// repo path. Tests use a real git binary because runGit shells out to
// it; mocking the helper would defeat the purpose of the freshness
// check (which is built around exact git semantics).
func shellGitInit(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "test"},
		{"commit", "--allow-empty", "-q", "-m", "initial"},
	} {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Skipf("git unavailable or failed (%v): %s", err, string(out))
		}
	}
	return dir
}

func gitEmptyCommit(t *testing.T, dir string) {
	t.Helper()
	out, err := exec.Command("git", "-C", dir, "commit", "--allow-empty", "-q", "-m", "another").CombinedOutput()
	if err != nil {
		t.Fatalf("commit failed: %v: %s", err, out)
	}
}

func TestWebBundleStaleVsHead_NotAGitRepo(t *testing.T) {
	dir := t.TempDir() // no .git
	stale, _, ok := webBundleStaleVsHead(dir, time.Now().Format(time.RFC3339))
	if ok {
		t.Fatalf("expected ok=false for non-git workdir, got stale=%v ok=%v", stale, ok)
	}
}

func TestWebBundleStaleVsHead_BuiltAfterHead(t *testing.T) {
	dir := shellGitInit(t)
	// Build is in the future relative to HEAD → not stale.
	future := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	stale, _, ok := webBundleStaleVsHead(dir, future)
	if !ok {
		t.Fatalf("expected ok=true for git workdir")
	}
	if stale {
		t.Fatalf("expected stale=false when build is newer than HEAD")
	}
}

func TestWebBundleStaleVsHead_HeadAfterBuild(t *testing.T) {
	dir := shellGitInit(t)
	// Build was an hour ago, then HEAD advanced.
	oldBuilt := time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339)
	time.Sleep(1100 * time.Millisecond) // ensure new commit timestamp > oldBuilt
	gitEmptyCommit(t, dir)
	stale, headTime, ok := webBundleStaleVsHead(dir, oldBuilt)
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if !stale {
		t.Fatalf("expected stale=true after new commit; headTime=%s", headTime)
	}
	if headTime.IsZero() {
		t.Fatalf("expected non-zero headTime")
	}
}

func TestWebBundleStaleVsHead_NoBuiltAtTreatsAsStale(t *testing.T) {
	dir := shellGitInit(t)
	stale, _, ok := webBundleStaleVsHead(dir, "")
	if !ok {
		t.Fatalf("expected ok=true")
	}
	if !stale {
		t.Fatalf("expected stale=true when builtAt is empty (no prior build)")
	}
}

func TestWebBundleStaleVsHead_UnparseableBuiltAtIsNotStale(t *testing.T) {
	dir := shellGitInit(t)
	// Garbage timestamp — we should bail out (ok=false) rather than
	// flap into "always stale" and trigger rebuild storms.
	stale, _, ok := webBundleStaleVsHead(dir, "not-a-timestamp")
	if ok {
		t.Fatalf("expected ok=false on unparseable builtAt, got stale=%v ok=%v", stale, ok)
	}
}

func writeFileMkdir(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

func gitHeadOf(t *testing.T, dir string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").CombinedOutput()
	if err != nil {
		t.Fatalf("rev-parse HEAD: %v: %s", err, out)
	}
	return strings.TrimSpace(string(out))
}

// TestWebBundleStale_StampedCommitBeatsTimestamps is the regression
// guard for the double-build incident (2026-07-26): the pre-build
// `git pull --rebase --autostash` re-stamps committer times, so HEAD's
// commit TIME postdated the bundle's BuiltAt wall clock even though the
// exported COMMIT was unchanged — and a second full ~87 s export fired
// 13 s after the first finished. With the commit-identity stamp, the
// same inputs are fresh. Proven by breaking: the legacy time-based
// fallback (no stamp) still calls this stale.
func TestWebBundleStale_StampedCommitBeatsTimestamps(t *testing.T) {
	dir := shellGitInit(t)
	head := gitHeadOf(t, dir)
	// BuiltAt an hour BEFORE the commit's timestamp — the exact shape
	// that used to false-stale.
	builtAt := time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339)
	info := WebBundleInfo{WorkDir: dir, BuiltAt: builtAt, HeadCommit: head}

	stale, _, ok := webBundleStale(info)
	if !ok {
		t.Fatalf("expected ok=true with a stamped commit in a git workdir")
	}
	if stale {
		t.Fatalf("stamped commit == HEAD must be fresh regardless of timestamps")
	}

	// Contrast: the un-stamped legacy path calls this stale — that IS
	// the bug the stamp fixes. If this half ever starts passing as
	// fresh, the fallback changed and this test should be revisited.
	legacyStale, _, legacyOK := webBundleStale(WebBundleInfo{WorkDir: dir, BuiltAt: builtAt})
	if !legacyOK || !legacyStale {
		t.Fatalf("legacy timestamp fallback expected to report stale (stale=%v ok=%v)", legacyStale, legacyOK)
	}
}

func TestWebBundleStale_StampedCommitMismatchIsStale(t *testing.T) {
	dir := shellGitInit(t)
	head := gitHeadOf(t, dir)
	gitEmptyCommit(t, dir) // HEAD moves past the stamp
	info := WebBundleInfo{WorkDir: dir, BuiltAt: time.Now().UTC().Format(time.RFC3339), HeadCommit: head}
	stale, _, ok := webBundleStale(info)
	if !ok || !stale {
		t.Fatalf("HEAD moved past the stamped commit — expected stale=true ok=true, got stale=%v ok=%v", stale, ok)
	}
}

func TestWebBundleStale_StampInNonGitDirIsUndecided(t *testing.T) {
	dir := t.TempDir() // no .git
	stale, _, ok := webBundleStale(WebBundleInfo{WorkDir: dir, HeadCommit: "deadbeef"})
	if ok {
		t.Fatalf("non-git workdir must be undecided, got stale=%v ok=%v", stale, ok)
	}
}

func TestWebBundleFastReusable(t *testing.T) {
	dir := shellGitInit(t)
	// A tracked file, committed, so we can dirty it later.
	tracked := filepath.Join(dir, "app.js")
	if err := writeFileMkdir(tracked, "console.log('v1')\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	for _, args := range [][]string{{"add", "app.js"}, {"commit", "-q", "-m", "app"}} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	head := gitHeadOf(t, dir)
	buildDir := filepath.Join(dir, ".yaver-build-web")
	if err := writeFileMkdir(filepath.Join(buildDir, "index.html"), "<html></html>"); err != nil {
		t.Fatalf("write bundle: %v", err)
	}
	info := WebBundleInfo{
		WorkDir: dir, BuildDir: buildDir, IndexFile: "index.html",
		BuiltAt: time.Now().UTC().Format(time.RFC3339), HeadCommit: head,
	}

	if reuse, why := webBundleFastReusable(info, dir); !reuse {
		t.Fatalf("fresh stamped bundle with clean tree must be reusable (reason: %s)", why)
	}

	// Uncommitted edit to a TRACKED file must force a rebuild — this is
	// the active-coding-agent case; serving the old bundle here would
	// hide the agent's edits behind a "successful" fast reload.
	if err := writeFileMkdir(tracked, "console.log('v2-uncommitted')\n"); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if reuse, why := webBundleFastReusable(info, dir); reuse {
		t.Fatalf("dirty tracked tree must not fast-reuse (reason given: %s)", why)
	}

	// Missing output on disk must rebuild even when git says fresh.
	if err := exec.Command("git", "-C", dir, "checkout", "--", "app.js").Run(); err != nil {
		t.Fatalf("git checkout: %v", err)
	}
	infoGone := info
	infoGone.BuildDir = filepath.Join(dir, ".yaver-build-web-missing")
	if reuse, _ := webBundleFastReusable(infoGone, dir); reuse {
		t.Fatalf("missing bundle output must not be reusable")
	}

	// A different project's bundle must never satisfy a fast request.
	other := t.TempDir()
	if reuse, _ := webBundleFastReusable(info, other); reuse {
		t.Fatalf("bundle for another workdir must not be reusable")
	}
}

func TestResolveWebBundleWorkDir_PrefersExplicitWorkDir(t *testing.T) {
	info := WebBundleInfo{WorkDir: "/explicit/work", BuildDir: "/somewhere/.yaver-build-web"}
	if got := resolveWebBundleWorkDir(info); got != "/explicit/work" {
		t.Fatalf("expected explicit WorkDir, got %q", got)
	}
}

func TestResolveWebBundleWorkDir_DerivesFromBuildDirSuffix(t *testing.T) {
	cases := []struct {
		buildDir, want string
	}{
		{"/root/proj/.yaver-build-web", "/root/proj"},
		{"/root/proj/.yaver-build-web-hermes", "/root/proj"},
	}
	for _, tc := range cases {
		got := resolveWebBundleWorkDir(WebBundleInfo{BuildDir: tc.buildDir})
		if got != tc.want {
			t.Errorf("buildDir=%s: got %q want %q", tc.buildDir, got, tc.want)
		}
	}
}

func TestResolveWebBundleWorkDir_UnknownSuffixReturnsEmpty(t *testing.T) {
	// Don't guess for unrecognized BuildDir layouts — we'd risk
	// running git in the wrong place.
	got := resolveWebBundleWorkDir(WebBundleInfo{BuildDir: "/somewhere/random/dir"})
	if got != "" {
		t.Fatalf("expected empty for unrecognized BuildDir suffix, got %q", got)
	}
}

func TestClaimWebRebuildSlot_SerializesPerWorkDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "proj")
	defer releaseWebRebuildSlot(dir)
	if !claimWebRebuildSlot(dir) {
		t.Fatalf("first claim should succeed")
	}
	if claimWebRebuildSlot(dir) {
		t.Fatalf("second claim should be blocked while slot is held")
	}
	releaseWebRebuildSlot(dir)
	if !claimWebRebuildSlot(dir) {
		t.Fatalf("claim after release should succeed")
	}
}

func TestClaimWebRebuildSlot_DifferentWorkDirsDoNotConflict(t *testing.T) {
	a := filepath.Join(t.TempDir(), "a")
	b := filepath.Join(t.TempDir(), "b")
	defer releaseWebRebuildSlot(a)
	defer releaseWebRebuildSlot(b)
	if !claimWebRebuildSlot(a) {
		t.Fatalf("claim a should succeed")
	}
	if !claimWebRebuildSlot(b) {
		t.Fatalf("claim b should succeed independently of a")
	}
}

func TestRenderWebRebuildingPage_ContainsPollScriptAndTimestamps(t *testing.T) {
	html := string(renderWebRebuildingPage("2026-05-10T08:00:00Z", time.Date(2026, 5, 10, 8, 30, 0, 0, time.UTC)))
	for _, want := range []string{
		"Rebuilding web bundle",
		"/dev/web-bundle/info",
		"location.reload",
		"2026-05-10T08:00:00Z",
		"2026-05-10T08:30:00Z",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("rebuilding page missing %q\n--- page ---\n%s", want, html)
		}
	}
}

func TestRenderWebRebuildingPage_HandlesEmptyBuiltAt(t *testing.T) {
	html := string(renderWebRebuildingPage("", time.Date(2026, 5, 10, 8, 30, 0, 0, time.UTC)))
	if !strings.Contains(html, "(no prior build)") {
		t.Errorf("expected friendly fallback for empty builtAt; got: %s", html)
	}
}
