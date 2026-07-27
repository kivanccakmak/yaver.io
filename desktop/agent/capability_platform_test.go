package main

import (
	"strings"
	"testing"
)

// platformGrid is every GOOS/GOARCH a Yaver agent is actually distributed for
// (CLAUDE.md, "Distribution — npm only"), plus native windows, which is the one
// the WSL2 constraints exist to name.
var platformGrid = []struct{ goos, goarch string }{
	{"darwin", "arm64"},
	{"darwin", "amd64"},
	{"linux", "amd64"},
	{"linux", "arm64"},
	{"windows", "amd64"},
	{"windows", "arm64"},
}

// THE DIRECTION THIS TABLE MOST OFTEN GETS WRONG. Flutter publishes no
// linux/arm64 tarball, and the naive reading is "so Flutter is impossible on an
// arm64 box". flutter_install.go git-clones there — Flutter's own supported
// install for that platform — and has since it was written. Declaring
// impossible what the product already supports withholds a working capability,
// which is exactly as much a defect as offering an install that cannot work.
//
// BREAK IT: make the flutter row `Supported: func(goos, goarch string) bool {
// return !(goos == "linux" && goarch == "arm64") }` — the shape a reader of
// flutterStableTarball would write — and this fails.
func TestFlutterIsInstallableOnLinuxArm64ViaGitClone(t *testing.T) {
	ok, constraint := capabilityFixSupportedOn("flutter", "linux", "arm64")
	if !ok {
		t.Fatalf("flutter must stay installable on linux/arm64 (git-clone path in flutter_install.go); got constraint %q", constraint)
	}
	if constraint != "" {
		t.Errorf("a supported platform must carry no constraint, got %q", constraint)
	}
	// And the tarball probe must still agree that there is no tarball — if it
	// ever gains one, this test is the place that notices.
	if _, _, hasTarball := flutterStableTarball(); hasTarball && (runtimeGOOSForTest() == "linux") {
		t.Log("note: a linux tarball now exists; the git-clone fallback may be dead code")
	}
}

func runtimeGOOSForTest() string {
	goos, _ := capabilityHostPlatform()
	return goos
}

// Apple's toolchain is not a packaging gap — there is no Xcode for Linux at any
// price. A spinner over "iOS simulator" on a Hetzner box is a wait that can
// never end, so the product must say so instead of offering a button.
func TestAppleToolchainIsNeverOfferedOffMac(t *testing.T) {
	for _, tool := range []string{"xcodebuild", "xcrun", "simctl", "pod", "xcodegen", "cliclick", "wda"} {
		for _, p := range platformGrid {
			ok, constraint := capabilityFixSupportedOn(tool, p.goos, p.goarch)
			if p.goos == "darwin" {
				if !ok {
					t.Errorf("%s on %s/%s: must be supported on a Mac", tool, p.goos, p.goarch)
				}
				continue
			}
			if ok {
				t.Errorf("%s on %s/%s: offered off macOS — Apple ships no Xcode for it, so this button cannot work",
					tool, p.goos, p.goarch)
			}
			if !strings.Contains(constraint, "macOS") {
				t.Errorf("%s on %s/%s: constraint must name macOS as the requirement, got %q", tool, p.goos, p.goarch, constraint)
			}
		}
	}
}

// The emulator predicate must BE the product's existing truth
// (emulatorHostSupported, android_sdk_install.go), not a second copy of it.
// Two copies is how a tool ends up platform-aware in one place and not the
// other — the failure this whole table exists to prevent.
func TestAndroidEmulatorMatchesTheInstallersOwnTruth(t *testing.T) {
	for _, p := range platformGrid {
		ok, constraint := capabilityFixSupportedOn("emulator", p.goos, p.goarch)
		want := emulatorHostSupported(p.goos, p.goarch)
		if ok != want {
			t.Errorf("emulator on %s/%s: matrix says %v, emulatorHostSupported says %v", p.goos, p.goarch, ok, want)
		}
		if !ok && !strings.Contains(strings.ToLower(constraint), "redroid") {
			t.Errorf("emulator on %s/%s: the refusal must name the path that DOES work here (redroid), got %q",
				p.goos, p.goarch, constraint)
		}
	}
	// The specific box this was measured on.
	if ok, _ := capabilityFixSupportedOn("emulator", "linux", "arm64"); ok {
		t.Error("linux/arm64 has no Android emulator host binary at all — offering it aborts the whole SDK install")
	}
}

// Google publishes no Chrome for linux/arm64: its apt and rpm repos are x86_64
// only, so chrome_install.go's apt path resolves nothing and the "install"
// leaves the box exactly as it was. A green install that changes nothing is the
// worst of the three outcomes.
func TestChromeIsRefusedOnLinuxArm64AndNamesChromium(t *testing.T) {
	ok, constraint := capabilityFixSupportedOn("chrome", "linux", "arm64")
	if ok {
		t.Fatal("Chrome on linux/arm64 would install nothing and report success")
	}
	if !strings.Contains(strings.ToLower(constraint), "chromium") {
		t.Errorf("the refusal must name the browser that DOES exist on arm64, got %q", constraint)
	}
	if ok, _ := capabilityFixSupportedOn("chrome", "linux", "amd64"); !ok {
		t.Error("linux/amd64 Chrome is real and installable — refusing it withholds a working capability")
	}
}

// THE CONTRACT, pinned across the whole table: supported ⇒ no constraint,
// unsupported ⇒ a constraint that says something. A false predicate with an
// empty sentence renders as a disabled button with no reason, which is the same
// dead end as a spinner.
//
// BREAK IT: delete any row's Constraint func and this fails on that row.
func TestEveryUnsupportedPlatformNamesItsConstraint(t *testing.T) {
	for tool := range capabilityToolMatrix {
		for _, p := range platformGrid {
			ok, constraint := capabilityFixSupportedOn(tool, p.goos, p.goarch)
			if ok && constraint != "" {
				t.Errorf("%s on %s/%s: supported AND constrained — clients cannot branch", tool, p.goos, p.goarch)
			}
			if ok {
				continue
			}
			if strings.TrimSpace(constraint) == "" {
				t.Errorf("%s on %s/%s: refused with no reason — a disabled button with no explanation", tool, p.goos, p.goarch)
				continue
			}
			if len(constraint) < 60 {
				t.Errorf("%s on %s/%s: constraint %q is too terse to act on; name the reason AND the alternative",
					tool, p.goos, p.goarch, constraint)
			}
			// "check your configuration" class errors cost whole sessions.
			for _, vague := range []string{"not supported", "unsupported platform", "check your"} {
				if strings.EqualFold(strings.TrimSpace(constraint), vague) {
					t.Errorf("%s on %s/%s: vague constraint %q", tool, p.goos, p.goarch, constraint)
				}
			}
		}
	}
}

// The node row must not drift from nodeTarballForPlatform's actual list — the
// installer errors "unsupported platform %s/%s" for anything else, and a matrix
// that disagrees either offers a doomed install or withholds a real one.
func TestNodeRowMatchesTheTarballTable(t *testing.T) {
	supported := map[string]bool{
		"linux/amd64": true, "linux/arm64": true,
		"darwin/amd64": true, "darwin/arm64": true,
	}
	for _, p := range platformGrid {
		ok, _ := capabilityFixSupportedOn("node", p.goos, p.goarch)
		if want := supported[p.goos+"/"+p.goarch]; ok != want {
			t.Errorf("node on %s/%s: matrix %v, nodeTarballForPlatform %v", p.goos, p.goarch, ok, want)
		}
		// `mobile` is the meta-install that ships the same runtime; it must
		// carry the same limits or one of the two lies.
		mobileOK, _ := capabilityFixSupportedOn("mobile", p.goos, p.goarch)
		if mobileOK != ok {
			t.Errorf("mobile on %s/%s: %v but node is %v — the meta-install ships the Node runtime", p.goos, p.goarch, mobileOK, ok)
		}
	}
}

// THE PRODUCER must act on the predicate, not merely own it. This is the test
// that would have caught "Install Flutter" rendering on a Windows box.
//
// BREAK IT: delete the platform loop in capabilityGapForMissingTools and this
// fails with a Fix where a Constraint belongs.
func TestProducerRefusesAFixItsPlatformCannotRun(t *testing.T) {
	restore := capabilityHostPlatform
	capabilityHostPlatform = func() (string, string) { return "windows", "amd64" }
	defer func() { capabilityHostPlatform = restore }()

	gap := DetectCapabilityGap(CapabilityGapContext{Framework: "flutter", MissingTools: []string{"flutter"}})
	if gap == nil {
		t.Fatal("a missing tool must still be named on Windows")
	}
	if gap.Fix != nil {
		t.Fatalf("Windows got an Install button whose install cannot work: %+v", gap.Fix)
	}
	if !strings.Contains(gap.Constraint, "WSL2") {
		t.Errorf("the constraint must name Yaver's supported Windows path, got %q", gap.Constraint)
	}
	if gap.Summary == "" {
		t.Error("the machine-facing sentence must still be there")
	}
}

// And the mirror image: on a platform where the install DOES work, the button
// must survive the new gate untouched. A platform check that quietly refuses
// everything would "pass" the test above and break the product.
func TestProducerStillOffersTheFixWherePlatformAllowsIt(t *testing.T) {
	restore := capabilityHostPlatform
	capabilityHostPlatform = func() (string, string) { return "linux", "arm64" }
	defer func() { capabilityHostPlatform = restore }()

	restoreProbe := probeHeadroomFn
	probeHeadroomFn = func(string) machineHeadroom {
		return machineHeadroom{Path: "/opt", FreeBytes: 200 * gib, TotalBytes: 500 * gib, RAMBytes: 16 * gib, Measured: true}
	}
	defer func() { probeHeadroomFn = restoreProbe }()

	gap := DetectCapabilityGap(CapabilityGapContext{Framework: "flutter", MissingTools: []string{"flutter"}})
	if gap == nil || gap.Fix == nil {
		t.Fatalf("linux/arm64 Flutter installs via git clone — the button must be there; got %+v", gap)
	}
	if gap.Constraint != "" {
		t.Errorf("a gap with a fix must not also claim a constraint: %q", gap.Constraint)
	}
}
