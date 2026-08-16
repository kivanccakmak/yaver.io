package main

import (
	"strings"
	"testing"
)

// A full disk is the one install failure that masquerades as every other one.
// npm reports a half-written tarball as EINTEGRITY, a truncated extract as
// ENOENT and a failed cache write as EACCES — so before ENOSPC was classified,
// a box with no free space told the user to "re-pack the referenced tarball"
// or to "check that ~/.npm is writable". Both remedies are impossible and both
// send the user hunting a lockfile bug that does not exist.
//
// Measured 2026-07-27: there was no ENOSPC branch anywhere on the install
// path. The only disk-full detection in the tree lives in diskhealth.go and
// storage_reclaim.go, neither of which this path calls.
func TestClassifyInstallFailureNamesAFullDisk(t *testing.T) {
	for _, tail := range []string{
		"npm ERR! nospc ENOSPC: no space left on device, write",
		"Error: ENOSPC: no space left on device, mkdir '/root/app/node_modules/.cache'",
		"tar: write error: No space left on device",
		"pnpm ERR! EDQUOT: disk quota exceeded",
	} {
		got := classifyInstallFailure(tail)
		if got == "" {
			t.Fatalf("%q classified as nothing — the user gets a raw npm dump for a full disk", tail)
		}
		if !strings.Contains(strings.ToLower(got), "disk is full") && !strings.Contains(strings.ToLower(got), "disk") {
			t.Errorf("%q classified as %q — it must name the disk", tail, got)
		}
	}
}

// The dangerous case: a full disk that ALSO surfaced an EINTEGRITY line. The
// disk must win, because the integrity remedy cannot work and costs the user a
// session.
func TestFullDiskWinsOverItsOwnDownstreamSymptoms(t *testing.T) {
	tail := strings.Join([]string{
		"npm ERR! code EINTEGRITY",
		"npm ERR! sha512-abc... integrity checksum failed when using sha512",
		"npm ERR! ENOSPC: no space left on device, write",
	}, "\n")
	got := classifyInstallFailure(tail)
	if strings.Contains(got, "package-lock.json has a stale integrity hash") {
		t.Fatalf("classified a full disk as a stale lockfile: %q — the remedy is impossible and the real cause goes unnamed", got)
	}
	if !strings.Contains(got, "disk is full") {
		t.Errorf("got %q, want the full-disk cause", got)
	}
}

// The other classifiers must be untouched — this change is additive.
func TestExistingInstallClassifiersStillFire(t *testing.T) {
	for _, tc := range []struct{ tail, want string }{
		{"npm ERR! code EINTEGRITY", "stale integrity hash"},
		{"npm ERR! ERESOLVE could not resolve dependency", "peer-dependency conflict"},
		{"npm ERR! code EACCES permission denied", "permission denied"},
		{"npm ERR! code ETARGET no matching version found", "version range"},
		{"npm ERR! code ENOTFOUND registry.npmjs.org", "network error"},
	} {
		if got := classifyInstallFailure(tc.tail); !strings.Contains(got, tc.want) {
			t.Errorf("classifyInstallFailure(%q) = %q, want it to contain %q", tc.tail, got, tc.want)
		}
	}
	if got := classifyInstallFailure("some unrelated build noise"); got != "" {
		t.Errorf("unclassifiable tail returned %q — the caller's generic message must win", got)
	}
}
