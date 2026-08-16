package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A SNAP BROWSER MUST NEVER BE CHOSEN FOR THE BROWSER LANE.
//
// Measured on ubuntu-4gb-hel1-1, 2026-08-02, with the identical environment:
//
//	/usr/bin/google-chrome   → renders about:blank, exit 0
//	/snap/bin/chromium       → "cannot create temporary directory for the root
//	                            file system: No such file or directory", exit 1
//	/usr/bin/chromium-browser→ same string, exit 1 (it is the snap shim)
//
// The lane hands the browser a PRIVATE HOME/TMPDIR/XDG_RUNTIME_DIR under
// /tmp/yaver-browser-window-*; snap confinement cannot see those paths, so the
// process dies before Chrome starts. `--version` succeeds on all three, which
// is why probing it was not enough — the probe answered a question that was not
// the one that mattered.

func TestChromeBinaryIsSnapConfinedDetectsEveryShape(t *testing.T) {
	dir := t.TempDir()

	// Shape 1: a path under /snap/ — decided without touching the disk.
	if !chromeBinaryIsSnapConfined("/snap/bin/chromium") {
		t.Error("/snap/bin/chromium not detected as snap-confined")
	}

	// Shape 2: a symlink to the snap launcher. This is what /snap/bin/chromium
	// actually is on the box: a link to /usr/bin/snap.
	snapBin := filepath.Join(dir, "snap")
	if err := os.WriteFile(snapBin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "chromium")
	if err := os.Symlink(snapBin, link); err != nil {
		t.Fatal(err)
	}
	if !chromeBinaryIsSnapConfined(link) {
		t.Error("a symlink to the snap launcher was not detected")
	}

	// Shape 3: the /usr/bin/chromium-browser shim — an ordinary-looking path
	// holding a 2 KB script that execs the snap. Nothing about its NAME or
	// LOCATION reveals it; only its contents do.
	shim := filepath.Join(dir, "chromium-browser")
	if err := os.WriteFile(shim, []byte("#!/bin/sh\nexec snap run chromium \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !chromeBinaryIsSnapConfined(shim) {
		t.Error("the chromium-browser snap shim was not detected — this is the binary the box actually had")
	}
}

// NO FALSE REDS: a real browser must not be rejected.
func TestChromeBinaryIsSnapConfinedAcceptsARealBrowser(t *testing.T) {
	dir := t.TempDir()

	real := filepath.Join(dir, "google-chrome")
	if err := os.WriteFile(real, []byte("#!/bin/sh\nexec /opt/google/chrome/chrome \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if chromeBinaryIsSnapConfined(real) {
		t.Error("a genuine google-chrome wrapper was rejected as snap — that would strand a box that has a working browser")
	}

	// A large binary is never read, and never rejected on content.
	big := filepath.Join(dir, "chrome-big")
	if err := os.WriteFile(big, append([]byte("snap run chromium"), make([]byte, 128*1024)...), 0o755); err != nil {
		t.Fatal(err)
	}
	if chromeBinaryIsSnapConfined(big) {
		t.Error("a multi-KB binary that merely CONTAINS the bytes 'snap run' was rejected — only small shim scripts may be judged on content")
	}

	if chromeBinaryIsSnapConfined("") {
		t.Error("empty path must not be called snap-confined")
	}
	if chromeBinaryIsSnapConfined(filepath.Join(dir, "does-not-exist")) {
		t.Error("a missing path must not be called snap-confined — 'absent' and 'confined' need different remedies")
	}
}

// chromeBinaryUsable must reject a snap even when --version would succeed.
// This is the guard that actually keeps the lane off the snap.
func TestChromeBinaryUsableRejectsSnapBeforeProbing(t *testing.T) {
	dir := t.TempDir()

	// A shim that prints a perfectly good version string and exits 0 — exactly
	// what /snap/bin/chromium does. Without the structural check this passes.
	shim := filepath.Join(dir, "chromium-browser")
	script := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'Chromium 150.0.7871.186 snap'; exit 0; fi\nexec snap run chromium \"$@\"\n"
	if err := os.WriteFile(shim, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	if chromeBinaryUsable(shim) {
		t.Fatal("chromeBinaryUsable accepted a snap shim whose --version succeeds — " +
			"this is the inventory-vs-operation trap that produced 'cannot create temporary directory'")
	}

	// NEGATIVE CONTROL: the same script WITHOUT the snap exec is accepted.
	// Without this, the test above could pass because the probe is simply
	// broken for every input.
	plain := filepath.Join(dir, "google-chrome")
	ok := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'Google Chrome 150.0.7871.186'; exit 0; fi\nexit 0\n"
	if err := os.WriteFile(plain, []byte(ok), 0o755); err != nil {
		t.Fatal(err)
	}
	if !chromeBinaryUsable(plain) {
		t.Fatal("negative control failed: a non-snap browser reporting a version was rejected, so the snap test proves nothing")
	}
}

// The snap failure must be NAMED, and must NOT be reported as a disk problem.
//
// The incident began on a full disk, which made "cannot create temporary
// directory" look like exhaustion. It is not: the box now has 1.9 GB free and
// reproduces the string exactly. Routing it to the disk remedy would send the
// user to reclaim space that is already there — a false red, no better than the
// false green ("check the dev server's port") it replaced.
func TestBrowserLaunchReasonSeparatesSnapFromDisk(t *testing.T) {
	cases := []struct {
		name string
		err  string
		want string
	}{
		{
			name: "the exact snap-confine message from the box",
			err:  "chrome failed to start: cannot create temporary directory for the root file system: No such file or directory",
			want: ReasonBrowserWindowChromeSnapConfined,
		},
		{
			name: "genuine exhaustion says so in its own words",
			err:  "open /tmp/yaver-browser-window-1/profile: no space left on device",
			want: ReasonCapabilityInsufficientDisk,
		},
		{
			name: "a missing browser is still a missing browser",
			err:  "exec: \"google-chrome\": executable file not found in $PATH",
			want: ReasonBrowserWindowChromeMissing,
		},
		{
			name: "the socket-directory failure remains a runtime-dir problem",
			err:  "Failed to create socket directory",
			want: ReasonBrowserWindowChromeRuntimeDir,
		},
	}
	for _, c := range cases {
		got := browserWindowLaunchErrorReason(errors.New(c.err))
		if got != c.want {
			t.Errorf("%s:\n  err  = %q\n  got  = %s\n  want = %s", c.name, c.err, got, c.want)
		}
	}

	// And the snap cause must never be confused with the disk cause in EITHER
	// direction — each sends the user to a different, mutually useless action.
	snap := browserWindowLaunchErrorReason(errors.New("cannot create temporary directory for the root file system"))
	if snap == ReasonCapabilityInsufficientDisk {
		t.Error("snap confinement reported as insufficient disk — the user would go free space that is already free")
	}
	if !strings.Contains(ReasonBrowserWindowChromeSnapConfined, "snap") {
		t.Error("the reason code should name snap so a surface can key off it without a regex")
	}
}
