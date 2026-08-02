package main

// disk_reclaim.go — find and reclaim REGENERABLE build caches before a full
// disk takes the machine down.
//
// ── The incident (2026-08-02) ──────────────────────────────────────────────
//
// A coding session ran Go commands with `HOME=$(mktemp -d)` to keep tests away
// from the real `~/.yaver` (a genuine hazard — see the test that once wiped a
// developer's auth). Every invocation got a fresh HOME, therefore a fresh
// GOPATH, therefore re-downloaded the entire module cache. 33 of them
// accumulated: **17 GB of byte-identical duplicates**, and the machine went
// from 10 GB free to 118 MB. At that point `go build` failed with
// `ld: write() failed, errno=28`, `go vet` could not unzip a module, and even
// the tooling could not write its own output file.
//
// Nothing was wrong with the disk, the code, or the toolchain. The machine had
// been quietly buried in caches that could be regenerated from nothing.
//
// ── Why this belongs in the PRODUCT ────────────────────────────────────────
//
// Because it is not specific to that session, or to Go, or to Yaver's own
// repo. Anyone developing with Yaver accumulates exactly this: node_modules
// trees, Xcode DerivedData, Gradle caches, npm/pnpm stores, Playwright
// browsers, Docker layers. A remote box that fills up stops building and — the
// part that actually hurts — reports the failure as whatever the compiler
// happened to say when it ran out of room. `errno=28` is not a sentence a user
// can act on; "your build cache is 17 GB of duplicates" is.
//
// This is the Snowball Principle applied to the incident: the session's disk
// was unblocked in a minute by deleting the duplicates, and that helped exactly
// one machine. What ships is the detection and the reclaim.
//
// ── Safety ─────────────────────────────────────────────────────────────────
//
// This file DELETES. Every rule in CLAUDE.md's destructive-paths section is
// enforced structurally rather than remembered:
//
//   - allowlist only: a candidate must match a known regenerable-cache shape
//   - absolute paths, resolved, with the home prefix verified
//   - never $HOME itself, never a git working tree, never a path we cannot
//     classify
//   - dry-run is the DEFAULT; freeing requires an explicit opt-in
//   - every removal is reported with its size, so the user sees what went
//
// Nothing here touches source, credentials, or anything a user authored.

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ReclaimKind classifies a candidate so a surface can explain the trade.
type ReclaimKind string

const (
	// ReclaimSafe — pure cache. Regenerates automatically on next use; the only
	// cost of removing it is one slower build.
	ReclaimSafe ReclaimKind = "safe"
	// ReclaimOrphan — a duplicate or abandoned cache that will NEVER be reused,
	// because whatever created it is gone. Free money.
	ReclaimOrphan ReclaimKind = "orphan"
)

// ReclaimCandidate is one directory that can be freed.
type ReclaimCandidate struct {
	Path  string      `json:"path"`
	Kind  ReclaimKind `json:"kind"`
	Bytes int64       `json:"bytes"`
	// What this is, in words — never a bare path. A user approving a delete
	// must be able to tell what they are approving.
	Label string `json:"label"`
	// Why removing it is safe, stated per candidate rather than assumed.
	Why string `json:"why"`
}

// DiskReclaimReport is what the agent hands to any surface.
type DiskReclaimReport struct {
	FreeBytes  int64              `json:"freeBytes"`
	TotalBytes int64              `json:"totalBytes"`
	// PercentUsed is carried so a surface can decide urgency without doing
	// arithmetic on two numbers it might get wrong.
	PercentUsed  int                `json:"percentUsed"`
	Candidates   []ReclaimCandidate `json:"candidates"`
	ReclaimableBytes int64          `json:"reclaimableBytes"`
	// Urgent is true when the machine is close enough to full that builds are
	// already at risk. Set from measurement, never from a guess.
	Urgent  bool      `json:"urgent"`
	Advice  string    `json:"advice"`
	ScanAt  time.Time `json:"scanAt"`
}

// diskPressureThreshold — below this much free space, a large link step or an
// Xcode archive can fail outright. Chosen from the incident: the Go link died
// with ~900 MB free, and a mobile archive needs far more.
const diskPressureThreshold = int64(5) << 30 // 5 GiB

// reclaimRule describes one recognised cache shape.
type reclaimRule struct {
	// rel is relative to $HOME.
	rel   string
	kind  ReclaimKind
	label string
	why   string
}

// knownReclaimRules is the ALLOWLIST. A directory not described here is never
// a candidate, however large it looks — the cost of guessing wrong is someone's
// source tree.
var knownReclaimRules = []reclaimRule{
	{"Library/Caches/go-build", ReclaimSafe, "Go build cache",
		"Regenerated automatically by the next build; only cost is a slower first compile."},
	{"Library/Caches/ms-playwright", ReclaimSafe, "Playwright browsers",
		"Re-downloaded by `playwright install` when a test next needs them."},
	{".npm/_cacache", ReclaimSafe, "npm content cache",
		"Package tarballs; npm refetches on demand."},
	{"Library/Developer/Xcode/DerivedData", ReclaimSafe, "Xcode DerivedData",
		"Intermediate build products; Xcode rebuilds them."},
	{".gradle/caches", ReclaimSafe, "Gradle cache",
		"Dependency and build cache; Gradle refetches on demand."},
	{"Library/Caches/node-gyp", ReclaimSafe, "node-gyp headers",
		"Node headers, refetched when a native module builds."},
}

// FindOrphanGoPaths locates duplicate Go module caches under the system temp
// directory — the exact 2026-08-02 failure.
//
// A GOPATH under TMPDIR belongs to a process that has almost certainly exited:
// nothing legitimate keeps a module cache there across reboots, and each one is
// a byte-identical copy of the shared cache. They are pure waste.
//
// Deliberately narrow: the path must contain a real `go/pkg/mod` under a temp
// root. A bare temp directory is never touched.
func FindOrphanGoPaths(tempRoot string) []ReclaimCandidate {
	root := strings.TrimSpace(tempRoot)
	if root == "" {
		root = os.TempDir()
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []ReclaimCandidate
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		modDir := filepath.Join(dir, "go", "pkg", "mod")
		st, err := os.Stat(modDir)
		if err != nil || !st.IsDir() {
			continue
		}
		size := dirSizeBounded(dir)
		out = append(out, ReclaimCandidate{
			Path:  dir,
			Kind:  ReclaimOrphan,
			Bytes: size,
			Label: "Orphaned Go module cache (temp GOPATH)",
			Why: "A GOPATH under the temp directory belongs to a process that has exited. " +
				"It is a byte-identical duplicate of the shared module cache and will never be reused.",
		})
	}
	return out
}

// dirSizeBounded sums a tree, giving up rather than walking forever.
//
// Bounded on purpose: this runs during a health check, and an unbounded walk of
// a huge tree is the "advisory work in the critical path" defect. An
// approximate size that arrives is worth more than an exact one that hangs.
func dirSizeBounded(path string) int64 {
	const maxEntries = 200_000
	var total int64
	seen := 0
	deadline := time.Now().Add(3 * time.Second)
	_ = filepath.WalkDir(path, func(_ string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		seen++
		if seen > maxEntries || time.Now().After(deadline) {
			return filepath.SkipAll
		}
		if d.IsDir() {
			return nil
		}
		if info, e := d.Info(); e == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

// safeToRemove is the last gate before any deletion.
//
// Returns false for anything it cannot positively classify. The default answer
// to "should I delete this?" is NO.
func safeToRemove(path, home, tempRoot string) bool {
	p := filepath.Clean(strings.TrimSpace(path))
	if p == "" || p == "/" || p == filepath.Clean(home) {
		return false
	}
	if !filepath.IsAbs(p) {
		return false
	}
	// A git working tree is source, never cache — whatever else it looks like.
	if _, err := os.Stat(filepath.Join(p, ".git")); err == nil {
		return false
	}
	// Allowlisted cache under HOME…
	for _, r := range knownReclaimRules {
		if p == filepath.Clean(filepath.Join(home, r.rel)) {
			return true
		}
	}
	// …or an orphan GOPATH under the temp root, which must actually contain a
	// module cache. Checking the marker rather than the name means a temp dir
	// that merely looks similar is left alone.
	if tempRoot != "" && strings.HasPrefix(p, filepath.Clean(tempRoot)+string(os.PathSeparator)) {
		if st, err := os.Stat(filepath.Join(p, "go", "pkg", "mod")); err == nil && st.IsDir() {
			return true
		}
	}
	return false
}

// ScanDiskReclaim measures the disk and lists what could be freed.
func ScanDiskReclaim(home, tempRoot string) DiskReclaimReport {
	rep := DiskReclaimReport{ScanAt: time.Now()}
	// Reuse the existing cross-platform helper (diskhealth_unix.go /
	// diskhealth_windows.go) rather than adding a second syscall path — a
	// duplicate would drift on exactly one OS and nobody would notice.
	totalGB, freeGB, ok := statfsGB(home)
	var free, total int64
	if ok {
		free = int64(freeGB * float64(int64(1)<<30))
		total = int64(totalGB * float64(int64(1)<<30))
	}
	rep.FreeBytes, rep.TotalBytes = free, total
	if total > 0 {
		rep.PercentUsed = int(float64(total-free) / float64(total) * 100)
	}
	rep.Urgent = free > 0 && free < diskPressureThreshold

	for _, r := range knownReclaimRules {
		p := filepath.Join(home, r.rel)
		if st, err := os.Stat(p); err != nil || !st.IsDir() {
			continue
		}
		sz := dirSizeBounded(p)
		if sz <= 0 {
			continue
		}
		rep.Candidates = append(rep.Candidates, ReclaimCandidate{
			Path: p, Kind: r.kind, Bytes: sz, Label: r.label, Why: r.why,
		})
	}
	rep.Candidates = append(rep.Candidates, FindOrphanGoPaths(tempRoot)...)
	for _, c := range rep.Candidates {
		rep.ReclaimableBytes += c.Bytes
	}

	switch {
	case rep.Urgent && rep.ReclaimableBytes > 0:
		rep.Advice = "This machine is nearly full and builds will start failing with confusing errors " +
			"(a Go link reports `errno=28`, Xcode reports a signing error). " +
			humanBytes(rep.ReclaimableBytes) + " of it is regenerable cache — reclaim it before diagnosing anything else."
	case rep.Urgent:
		rep.Advice = "This machine is nearly full and no regenerable cache was found — the space is real data. " +
			"Free some manually before running builds."
	case rep.ReclaimableBytes > (int64(10) << 30):
		rep.Advice = humanBytes(rep.ReclaimableBytes) + " of regenerable build cache is sitting here. " +
			"Not urgent, but worth reclaiming."
	default:
		rep.Advice = ""
	}
	return rep
}

// ReclaimDisk frees the candidates. `apply` MUST be true to delete anything —
// the default is a dry run, so a caller that forgets the flag reports instead
// of destroying.
func ReclaimDisk(home, tempRoot string, apply bool, kinds ...ReclaimKind) (freed int64, removed []ReclaimCandidate, skipped []ReclaimCandidate) {
	want := map[ReclaimKind]bool{}
	for _, k := range kinds {
		want[k] = true
	}
	if len(want) == 0 {
		// Default to the free money only. Wiping a warm build cache slows the
		// next build; wiping an orphan costs nothing at all.
		want[ReclaimOrphan] = true
	}

	rep := ScanDiskReclaim(home, tempRoot)
	for _, c := range rep.Candidates {
		if !want[c.Kind] {
			continue
		}
		if !safeToRemove(c.Path, home, tempRoot) {
			skipped = append(skipped, c)
			continue
		}
		if !apply {
			removed = append(removed, c)
			freed += c.Bytes
			continue
		}
		// Module caches are written read-only; without this the remove fails
		// halfway and leaves a partially-deleted tree.
		_ = filepath.WalkDir(c.Path, func(p string, d os.DirEntry, err error) error {
			if err == nil {
				_ = os.Chmod(p, 0o700)
			}
			return nil
		})
		if err := os.RemoveAll(c.Path); err != nil {
			skipped = append(skipped, c)
			continue
		}
		removed = append(removed, c)
		freed += c.Bytes
	}
	return freed, removed, skipped
}

// humanBytes and itoa64 already exist (pipeline.go, stack_detect.go). Reused
// rather than re-implemented — this package already carries humanBytes AND
// humanBytesDG, and a third copy is how formatting quietly diverges per call
// site.
