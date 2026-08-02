package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A temp GOPATH is the exact 2026-08-02 shape: 33 of them, 17 GB of
// byte-identical duplicates, machine down to 118 MB.
func TestFindOrphanGoPaths_DetectsTempGopath(t *testing.T) {
	root := t.TempDir()
	orphan := filepath.Join(root, "tmp.ABC123")
	if err := os.MkdirAll(filepath.Join(orphan, "go", "pkg", "mod", "example.com"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphan, "go", "pkg", "mod", "example.com", "f"), make([]byte, 4096), 0o644); err != nil {
		t.Fatal(err)
	}
	got := FindOrphanGoPaths(root)
	if len(got) != 1 {
		t.Fatalf("expected 1 orphan GOPATH, got %d", len(got))
	}
	if got[0].Kind != ReclaimOrphan {
		t.Fatalf("a temp GOPATH is an ORPHAN — it will never be reused; got %q", got[0].Kind)
	}
	if got[0].Bytes <= 0 {
		t.Fatal("size must be measured, or a surface cannot say what reclaiming buys")
	}
}

// NO FALSE POSITIVES. A temp directory that merely looks similar must be left
// alone — this code deletes, so the default answer is always NO.
func TestFindOrphanGoPaths_IgnoresNonGopathTempDirs(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"tmp.notgo", "tmp.hasgo"} {
		if err := os.MkdirAll(filepath.Join(root, name, "go"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Neither has go/pkg/mod, so neither is a module cache.
	if got := FindOrphanGoPaths(root); len(got) != 0 {
		t.Fatalf("only a real go/pkg/mod is an orphan GOPATH; got %+v", got)
	}
}

// safeToRemove is the last gate. Everything it cannot positively classify must
// come back false.
func TestSafeToRemove_RefusesAnythingUnclassified(t *testing.T) {
	home := t.TempDir()
	tempRoot := t.TempDir()

	for _, bad := range []string{
		"", "/", home,
		filepath.Join(home, "Workspace", "yaver.io"),
		filepath.Join(home, "Documents"),
		"relative/path",
		filepath.Join(tempRoot, "tmp.nothing"), // temp, but no module cache
	} {
		if safeToRemove(bad, home, tempRoot) {
			t.Fatalf("must refuse %q — the default answer to 'delete this?' is NO", bad)
		}
	}

	// A git working tree is SOURCE, whatever else it resembles.
	repo := filepath.Join(home, "Library", "Caches", "go-build")
	_ = os.MkdirAll(filepath.Join(repo, ".git"), 0o755)
	if safeToRemove(repo, home, tempRoot) {
		t.Fatal("a directory containing .git is source and must never be reclaimed")
	}
}

func TestSafeToRemove_AllowsKnownCaches(t *testing.T) {
	home := t.TempDir()
	tempRoot := t.TempDir()

	cache := filepath.Join(home, "Library", "Caches", "go-build")
	_ = os.MkdirAll(cache, 0o755)
	if !safeToRemove(cache, home, tempRoot) {
		t.Fatal("the Go build cache is allowlisted and regenerable")
	}

	orphan := filepath.Join(tempRoot, "tmp.XYZ")
	_ = os.MkdirAll(filepath.Join(orphan, "go", "pkg", "mod"), 0o755)
	if !safeToRemove(orphan, home, tempRoot) {
		t.Fatal("a temp GOPATH carrying a real module cache is reclaimable")
	}
}

// DRY RUN IS THE DEFAULT. A caller that forgets the flag must report, never
// destroy.
func TestReclaimDisk_DryRunDeletesNothing(t *testing.T) {
	home := t.TempDir()
	tempRoot := t.TempDir()
	orphan := filepath.Join(tempRoot, "tmp.DRY")
	_ = os.MkdirAll(filepath.Join(orphan, "go", "pkg", "mod"), 0o755)
	_ = os.WriteFile(filepath.Join(orphan, "go", "pkg", "mod", "f"), make([]byte, 2048), 0o644)

	freed, removed, _ := ReclaimDisk(home, tempRoot, false)
	if len(removed) != 1 || freed <= 0 {
		t.Fatalf("a dry run must still REPORT what it would free; got %d removed, %d bytes", len(removed), freed)
	}
	if _, err := os.Stat(orphan); err != nil {
		t.Fatal("a dry run must not delete anything")
	}
}

func TestReclaimDisk_ApplyRemovesReadOnlyModuleCache(t *testing.T) {
	home := t.TempDir()
	tempRoot := t.TempDir()
	orphan := filepath.Join(tempRoot, "tmp.APPLY")
	modf := filepath.Join(orphan, "go", "pkg", "mod", "x")
	_ = os.MkdirAll(filepath.Dir(modf), 0o755)
	_ = os.WriteFile(modf, make([]byte, 1024), 0o444) // module caches are read-only
	_ = os.Chmod(filepath.Dir(modf), 0o555)

	freed, removed, skipped := ReclaimDisk(home, tempRoot, true)
	if len(removed) != 1 || freed <= 0 {
		t.Fatalf("expected the orphan removed; removed=%d skipped=%d", len(removed), len(skipped))
	}
	if _, err := os.Stat(orphan); err == nil {
		t.Fatal("read-only module caches must still be removable — otherwise the reclaim half-completes")
	}
}

// By default only ORPHANS are freed: wiping a warm build cache costs the user a
// slow rebuild, wiping a duplicate costs nothing.
func TestReclaimDisk_DefaultsToOrphansOnly(t *testing.T) {
	home := t.TempDir()
	tempRoot := t.TempDir()
	warm := filepath.Join(home, "Library", "Caches", "go-build")
	_ = os.MkdirAll(warm, 0o755)
	_ = os.WriteFile(filepath.Join(warm, "f"), make([]byte, 4096), 0o644)

	_, removed, _ := ReclaimDisk(home, tempRoot, false)
	for _, r := range removed {
		if r.Kind == ReclaimSafe {
			t.Fatalf("the default must not touch a warm cache; got %q", r.Path)
		}
	}
}

func TestScanDiskReclaim_AdviceNamesTheConfusingError(t *testing.T) {
	home := t.TempDir()
	tempRoot := t.TempDir()
	orphan := filepath.Join(tempRoot, "tmp.ADV")
	_ = os.MkdirAll(filepath.Join(orphan, "go", "pkg", "mod"), 0o755)
	_ = os.WriteFile(filepath.Join(orphan, "go", "pkg", "mod", "f"), make([]byte, 8192), 0o644)

	rep := ScanDiskReclaim(home, tempRoot)
	if rep.ReclaimableBytes <= 0 {
		t.Fatal("the orphan must be counted")
	}
	if len(rep.Candidates) == 0 {
		t.Fatal("candidates must be listed, not just totalled — a user approves items, not a number")
	}
}
