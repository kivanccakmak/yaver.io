package main

// chrome_allocator_chokepoint_test.go — every Chrome allocator pins its binary.
//
// THE RULE THAT COULD NOT BE REMEMBERED. chromedp searches for a browser itself
// when ExecPath is unset, and on any box with a snap installed it finds
// /usr/bin/chromium-browser — the redirector, which cannot create its temp dir
// under a daemon and dies with "cannot create temporary directory for the root
// file system". /usr/bin/google-chrome sits alongside it and works.
//
// This tree had FIVE exec allocators. Four pinned the probed binary and one did
// not, and WHICH one drifted over time:
//
//	2026-08-03  browser.go was unpinned → vibe-preview could not capture at all.
//	2026-08-05  doctor_browser_lane.go was unpinned → the PHONE could not render
//	            the browser lane on a box where the DASHBOARD could, and the
//	            failure was additionally misreported as a navigation problem, so
//	            the remedy on screen talked about dev-server ports.
//	same day   twin_jobs.go was found unpinned while fixing the above.
//
// A rule enforced by remembering at five call sites will be forgotten at the
// sixth. newPinnedChromeAllocator makes the correct thing the only thing, and
// this test makes a sixth unpinned one fail the build.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEveryChromeAllocatorIsPinned(t *testing.T) {
	root := repoRoot(t)
	dir := filepath.Join(root, "desktop", "agent")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read agent dir: %v", err)
	}

	// The chokepoint itself is the one legal caller of the raw constructor.
	const chokepoint = "browser_resolve.go"

	offenders := []string{}
	sawChokepoint := false
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		src := string(body)
		// Strip comments: this file's siblings DISCUSS the raw constructor on
		// purpose, and a guard that cannot tell code from the commentary
		// explaining its own removal fires on the fix instead of the bug.
		code := stripGoComments(src)
		if !strings.Contains(code, "chromedp.NewExecAllocator") {
			continue
		}
		if name == chokepoint {
			sawChokepoint = true
			continue
		}
		offenders = append(offenders, name)
	}

	if !sawChokepoint {
		t.Fatalf("%s no longer contains the raw constructor — the chokepoint moved or vanished, and this guard is now measuring nothing", chokepoint)
	}
	for _, f := range offenders {
		t.Errorf("%s calls chromedp.NewExecAllocator directly. Use newPinnedChromeAllocator: an unpinned allocator lets chromedp pick the snap redirector, which cannot launch under a daemon.", f)
	}
}

// TestPinnedAllocatorActuallyPins — the helper must set ExecPath when a browser
// resolves. Without this the chokepoint could become a pass-through and every
// call site would silently regress at once.
func TestPinnedAllocatorActuallyPins(t *testing.T) {
	src, err := os.ReadFile(filepath.Join(repoRoot(t), "desktop", "agent", "browser_resolve.go"))
	if err != nil {
		t.Fatalf("read browser_resolve.go: %v", err)
	}
	code := stripGoComments(string(src))
	if !strings.Contains(code, "chromedp.ExecPath(cp)") {
		t.Error("newPinnedChromeAllocator must append chromedp.ExecPath — a chokepoint that does not pin is worse than no chokepoint, because every call site now trusts it")
	}
	if !strings.Contains(code, "resolveLaunchableChrome(ctx)") {
		t.Error("the path must come from resolveLaunchableChrome, which probes by RUNNING each candidate: PATH order is exactly what is untrustworthy, since `which chromium-browser` returns the snap stub")
	}
}

func stripGoComments(src string) string {
	out := make([]string, 0, 256)
	for _, line := range strings.Split(src, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "//") {
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}
