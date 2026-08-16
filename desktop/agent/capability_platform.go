package main

// capability_platform.go — the PLATFORM half of "never advertise a fix that
// cannot work here", and the per-tool declaration of what a fix COSTS.
//
// THE DEFECT THIS REMOVES. Before 2026-07-27, capability_gap.go answered one
// question — "does `yaver install <tool>` have a recipe?" — and treated a yes
// as a yes everywhere. That is the *inventory* answering for the *operation*
// again, one layer up from the incidents this whole file family exists for:
//
//   - `POST /install/flutter` has a recipe, so a Windows box got an "Install
//     Flutter" button. runFlutterInstall on GOOS=windows falls through to
//     git-clone and then writes ~/.profile — a file no Windows shell reads.
//     The install reports success and `flutter` is still not on PATH. A green
//     install followed by the identical failure is worse than a refusal: the
//     user now believes Yaver's buttons do not work.
//   - The reverse defect is just as real and cost just as much. Flutter
//     publishes NO linux/arm64 tarball (verified against releases_linux.json),
//     and the naive reading is "so Flutter is impossible on an arm64 box".
//     It is not: git-clone IS Flutter's supported install for that platform and
//     flutter_install.go has done exactly that the whole time. Declaring
//     impossible what the product already supports withholds a working
//     capability. Getting this backwards in EITHER direction is the defect,
//     which is why `TestFlutterIsInstallableOnLinuxArm64ViaGitClone` and
//     `TestNoToolIsOfferedWhereItsInstallerCannotWork` are both in the guard
//     set.
//
// THE SHAPE. One row per tool, in ONE table, declaring:
//
//	Supported(goos, goarch)  — can the fix actually work there?
//	Constraint(goos, goarch) — the honest sentence when it cannot. MUST be
//	                           non-empty wherever Supported is false; a false
//	                           predicate with no sentence is a disabled button
//	                           with no reason, which is the same dead end.
//	InstallBytes / FirstBuildBytes / RAMBytes — what it costs, so the button
//	                           can be honest and the agent can refuse before
//	                           it fills the disk (capability_resources.go).
//	Root()                   — the volume the install writes into. Free space
//	                           on `/` is not free space on the volume holding
//	                           /opt, and probing the wrong one is a false green.
//	Partials()               — what a half-finished install leaves behind, so
//	                           the box is never left STUCK (see
//	                           capability_partial.go).
//
// Adding a toolchain is one row here. Nothing else in the product needs to
// learn about its platform limits.
//
// WHERE THE TRUTHS COME FROM. Every predicate below mirrors a fact this repo
// already encodes in its installers — cited per row. A predicate invented here
// that the installer does not honour is drift with a test around it, so the
// rule is: cite the file, or do not add the row.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Byte constants, spelled out so a row reads as a size rather than a number.
const (
	mib = int64(1) << 20
	gib = int64(1) << 30
)

// capabilityToolSpec is ONE tool's declaration. Every field is optional except
// Display; a row with only a Display behaves exactly like the pre-2026-07-27
// table (installable wherever the install registry has a recipe), which is what
// makes adding rows incremental rather than a migration.
type capabilityToolSpec struct {
	// Display is how the tool is named to a human ("Flutter", not "flutter").
	Display string

	// Est is the size/time sentence for the button. Empty when we have no
	// defensible number — a made-up estimate is worse than none.
	Est string

	// Supported reports whether the FIX can actually work on goos/goarch.
	// nil ⇒ "wherever the install registry has a recipe" (no extra limit).
	Supported func(goos, goarch string) bool

	// Constraint is the honest sentence for a platform Supported rejects. It
	// must NAME the reason and, where one exists, the real alternative. nil is
	// only legal when Supported is nil.
	Constraint func(goos, goarch string) string

	// InstallBytes is what the fix itself writes to Root()'s volume.
	InstallBytes int64
	// FirstBuildBytes is what the FIRST build after the install needs on top.
	// The install fitting is not the same as the operation fitting; a box with
	// room for the SDK and none for the build is exactly the "you may run out
	// mid-build" case the warning lane exists for.
	FirstBuildBytes int64
	// RAMBytes is the RAM floor below which the tool thrashes or gets
	// OOM-killed rather than failing clean. Advisory: RAM cannot be reclaimed,
	// and the install itself almost always succeeds, so this warns and never
	// refuses.
	RAMBytes int64

	// Root is the directory the install writes into — the volume whose free
	// space actually decides the outcome. nil ⇒ probe $HOME.
	Root func() string

	// Partials are the paths a killed/failed install leaves behind. Used by
	// capability_partial.go to make a dead install SELF-CLEARING instead of a
	// box that reports "already installed" over a broken tree forever.
	Partials func() []string
}

// darwinOnly is the predicate for every Apple-toolchain capability. Apple ships
// no Xcode, no simulator runtime and no CoreSimulator for any other OS; this is
// a licensing + kernel fact, not a packaging gap, so no installer can ever
// change it. Naming it is the whole point — a spinner over "iOS simulator" on a
// Hetzner box is a wait that can never end.
func darwinOnly(goos, _ string) bool { return goos == "darwin" }

func appleToolchainConstraint(what string) func(goos, goarch string) string {
	return func(goos, goarch string) string {
		return fmt.Sprintf(
			"%s only exists on macOS — Apple ships no Xcode or iOS simulator runtime for %s, so there is "+
				"nothing Yaver could install here. Point this project at a Mac (`yaver primary set <device>`, "+
				"then start the preview from there), or use the WebRTC native-preview lane, which streams a "+
				"real device's screen instead of simulating one.",
			what, goos)
	}
}

// unixOnly covers package-manager-backed tools whose install plans in
// install_cmd.go are macOS+Linux only (`%s is not supported (macOS + Linux
// only)` there). On Windows the agent is expected to run under WSL2, where
// GOOS is linux and this predicate is satisfied by construction.
func unixOnly(goos, _ string) bool { return goos == "darwin" || goos == "linux" }

func wsl2Constraint(what string) func(goos, goarch string) string {
	return func(goos, goarch string) string {
		return fmt.Sprintf(
			"Yaver's %s installer targets macOS and Linux; on native Windows (%s) it would report success "+
				"while leaving nothing on PATH. Yaver's supported Windows path is WSL2 — install "+
				"`yaver-cli` inside your WSL2 distro and run the agent there, where this install works "+
				"unchanged.",
			what, goos)
	}
}

// nodeRuntimePlatformSupported mirrors nodeTarballForPlatform
// (node_install.go), which publishes exactly four GOOS/GOARCH pairs and errors
// with "unsupported platform" for anything else. Shared by the `node` and
// `mobile` rows — `mobile` is the meta-install that ships the same runtime, so
// a second copy of this list is drift waiting to happen.
func nodeRuntimePlatformSupported(goos, goarch string) bool {
	switch goos + "/" + goarch {
	case "linux/amd64", "linux/arm64", "darwin/amd64", "darwin/arm64":
		return true
	}
	return false
}

func nodeRuntimePlatformConstraint(goos, goarch string) string {
	return fmt.Sprintf(
		"Yaver's managed Node runtime ships tarballs for linux and macOS on x64/arm64 only — there is "+
			"none for %s/%s. Install Node %d+ from nodejs.org on this machine (or run the agent inside "+
			"WSL2 on Windows), then start again.",
		goos, goarch, nodeMinimumMajor)
}

// capabilityToolMatrix is THE table. One row per tool that has a platform
// limit, a real cost, or an install that can leave debris.
//
// Tools absent from this table are not "unsupported" — they simply declare no
// extra limit beyond the install registry, which is the correct default for
// npm-backed CLIs that run anywhere Node does.
var capabilityToolMatrix = map[string]capabilityToolSpec{
	// FLUTTER. flutter_install.go: tarball for linux/amd64 + darwin (universal
	// since 3.10); linux/arm64 has NO tarball and takes the git-clone path,
	// which is Flutter's own supported install for that platform. So arm64 is
	// SUPPORTED with a different route — the direction this table most often
	// gets wrong.
	//
	// Native Windows is refused: runFlutterInstall's non-tarball branch would
	// git-clone and then call ensureFlutterShellPath, which writes
	// /etc/profile.d or ~/.profile — neither of which a Windows shell reads.
	"flutter": {
		Display: "Flutter",
		Est:     "~1.2 GB SDK · usually 3–10 min",
		Supported: func(goos, goarch string) bool {
			return goos == "darwin" || goos == "linux"
		},
		Constraint: wsl2Constraint("Flutter"),
		// The extracted SDK is ~1.2 GB; the git-clone path pulls the Dart SDK
		// on first `flutter --version`, landing in the same place. Budget for
		// the archive AND the extracted tree co-existing during install.
		InstallBytes:    2 * gib,
		FirstBuildBytes: 2 * gib,
		RAMBytes:        2 * gib,
		Root:            flutterRoot,
		Partials: func() []string {
			return []string{flutterRoot()}
		},
	},

	// ANDROID SDK. android_sdk_install.go refuses outright for
	// `runtime.GOOS != "linux" && != "darwin"`, and
	// androidCommandLineToolsArchive has no Windows filename.
	"android-sdk": {
		Display:         "the Android SDK",
		Est:             "~2 GB · usually 5–15 min",
		Supported:       unixOnly,
		Constraint:      wsl2Constraint("Android SDK"),
		InstallBytes:    5 * gib,
		FirstBuildBytes: 3 * gib,
		RAMBytes:        4 * gib,
		Root:            androidSDKRoot,
		Partials: func() []string {
			return []string{
				filepath.Join(androidSDKRoot(), "cmdline-tools"),
				filepath.Join(androidSDKRoot(), "system-images"),
			}
		},
	},

	// ANDROID EMULATOR. The predicate is emulatorHostSupported
	// (android_sdk_install.go) — the product's OWN truth, not a second copy:
	// Google publishes no linux-aarch64 emulator host binary, so on an arm64
	// Linux box `sdkmanager` has no `emulator` package at all and requesting
	// it aborts the whole SDK install. Independent of /dev/kvm.
	"emulator": {
		Display:   "the Android emulator",
		Supported: emulatorHostSupported,
		Constraint: func(goos, goarch string) string {
			return fmt.Sprintf(
				"Google publishes no Android emulator for %s/%s — there is no host binary to install, and "+
					"even software (TCG) emulation needs one. On this box the working Android target is "+
					"redroid (a containerised Android that runs natively on arm64 Linux): `yaver ops "+
					"redroid_resource_status`. A USB- or WiFi-attached physical phone also works via "+
					"`yaver wire push`.",
				goos, goarch)
		},
		InstallBytes:    3 * gib,
		FirstBuildBytes: 2 * gib,
		RAMBytes:        8 * gib,
		Root:            androidSDKRoot,
	},

	// REDROID. android_resource.go already states it: needs a Linux host with
	// Android binder support. Encoded here so the gap producer says the same
	// thing the ops verb does.
	"redroid": {
		Display:   "redroid (containerised Android)",
		Supported: func(goos, _ string) bool { return goos == "linux" },
		Constraint: func(goos, _ string) string {
			return fmt.Sprintf(
				"redroid needs a Linux host with Android binder support in the kernel; %s has none, so no "+
					"install can produce it here. Use a Linux box or a managed Yaver cloud machine for the "+
					"Android clone, or attach a physical phone with `yaver wire detect`.",
				goos)
		},
		InstallBytes: 4 * gib,
		RAMBytes:     4 * gib,
	},

	// NODE. nodeTarballForPlatform (node_install.go) publishes exactly four
	// pairs; anything else falls into its "unsupported platform" error.
	"node": {
		Display:         "Node.js",
		Est:             "~60 MB · usually under a minute",
		Supported:       nodeRuntimePlatformSupported,
		Constraint:      nodeRuntimePlatformConstraint,
		InstallBytes:    400 * mib,
		FirstBuildBytes: 500 * mib,
		RAMBytes:        1 * gib,
		Root:            runtimeRoot,
		Partials: func() []string {
			return []string{filepath.Join(runtimeRoot(), "node")}
		},
	},

	// MOBILE is the meta-install that ships the Node runtime plus the Hermes
	// reload path, so it inherits Node's platform limits exactly.
	"mobile": {
		Display:         "the mobile toolchain",
		Est:             "~60 MB · usually under a minute",
		Supported:       nodeRuntimePlatformSupported,
		Constraint:      nodeRuntimePlatformConstraint,
		InstallBytes:    600 * mib,
		FirstBuildBytes: 1 * gib,
		RAMBytes:        2 * gib,
		Root:            runtimeRoot,
	},

	// HERMESC. hermesc_embedded.go embeds a prebuilt for darwin/arm64,
	// darwin/amd64 and linux/amd64 ONLY — but hermesc_resolver.go BUILDS it
	// from source for anything else and caches per GOOS-GOARCH, so linux/arm64
	// is supported by a slower route. Same lesson as Flutter's git-clone: the
	// missing prebuilt is not the missing capability.
	"hermesc": {
		Display:   "the Hermes compiler",
		Supported: unixOnly,
		Constraint: func(goos, goarch string) string {
			return fmt.Sprintf(
				"Hermes has no prebuilt and no from-source path Yaver can drive on %s. Run the agent under "+
					"WSL2 (Linux) or on macOS to produce Hermes bundles; the browser preview lane needs no "+
					"Hermes at all and works here.",
				goos)
		},
		InstallBytes:    1 * gib, // from-source build tree on linux/arm64
		FirstBuildBytes: 500 * mib,
		RAMBytes:        4 * gib,
	},

	// CHROME. chrome_install.go drives Google's apt/dnf repos — and Google
	// publishes NO google-chrome package for linux/arm64 at all, so the apt
	// path resolves nothing and the "install" leaves the box exactly as it
	// was. Chromium is the real arm64 browser and is a different package name.
	"chrome": {
		Display: "Google Chrome",
		Est:     "~120 MB · usually 1–3 min",
		Supported: func(goos, goarch string) bool {
			if goos == "linux" && goarch == "arm64" {
				return false
			}
			return goos == "darwin" || goos == "linux" || goos == "windows"
		},
		Constraint: func(goos, goarch string) string {
			return fmt.Sprintf(
				"Google publishes no Chrome build for %s/%s — its apt and rpm repos carry x86_64 only, so an "+
					"install here would report success and add nothing. Install `chromium` with your package "+
					"manager instead (`apt-get install -y chromium` / `pacman -S chromium`); Yaver's pixel "+
					"preview uses it the same way.",
				goos, goarch)
		},
		InstallBytes: 1 * gib,
		RAMBytes:     2 * gib,
	},

	// DOCKER. install_cmd.go's docker plan is brew-cask on macOS and distro
	// packages on Linux; there is no unattended native-Windows path.
	"docker": {
		Display:      "Docker",
		Supported:    unixOnly,
		Constraint:   wsl2Constraint("Docker"),
		InstallBytes: 3 * gib,
		RAMBytes:     4 * gib,
	},

	// THE APPLE FAMILY. Each of these is named separately because the sentence
	// the user reads should name the thing they asked for, not a category.
	"xcodebuild": {Display: "Xcode", Supported: darwinOnly, Constraint: appleToolchainConstraint("Xcode"), RAMBytes: 8 * gib, InstallBytes: 40 * gib, FirstBuildBytes: 10 * gib},
	"xcrun":      {Display: "the Xcode command-line tools", Supported: darwinOnly, Constraint: appleToolchainConstraint("The Xcode command-line tools"), InstallBytes: 2 * gib},
	"simctl":     {Display: "the iOS Simulator", Supported: darwinOnly, Constraint: appleToolchainConstraint("The iOS Simulator"), RAMBytes: 8 * gib, InstallBytes: 8 * gib},
	"pod":        {Display: "CocoaPods", Supported: darwinOnly, Constraint: appleToolchainConstraint("CocoaPods"), InstallBytes: 500 * mib},
	"xcodegen":   {Display: "XcodeGen", Supported: darwinOnly, Constraint: appleToolchainConstraint("XcodeGen"), InstallBytes: 100 * mib},
	"cliclick":   {Display: "cliclick", Supported: darwinOnly, Constraint: appleToolchainConstraint("cliclick"), InstallBytes: 10 * mib},
	"wda":        {Display: "WebDriverAgent", Supported: darwinOnly, Constraint: appleToolchainConstraint("WebDriverAgent")},

	// CARTON (SwiftWasm). No recipe in either install table — that constraint
	// is produced by capabilityGapForMissingTools already. The row exists so
	// the PLATFORM limit is stated too, and so the display name has one home.
	"carton": {
		Display:    "carton (the SwiftWasm toolchain)",
		Supported:  unixOnly,
		Constraint: wsl2Constraint("SwiftWasm (carton)"),
		RAMBytes:   4 * gib,
	},

	// FFMPEG backs capture-card streaming and clip recording.
	"ffmpeg": {
		Display:      "ffmpeg",
		Est:          "package-manager install · usually under a minute",
		Supported:    unixOnly,
		Constraint:   wsl2Constraint("ffmpeg"),
		InstallBytes: 300 * mib,
	},

	"tmux": {
		Display:      "tmux",
		Est:          "package-manager install · usually under a minute",
		Supported:    unixOnly,
		Constraint:   wsl2Constraint("tmux"),
		InstallBytes: 20 * mib,
	},

	// The npm-backed runner CLIs. No platform limit beyond Node's, which the
	// install itself enforces; the rows exist for the size estimate and the
	// disk floor so a 50 MB npm install is not started on a full disk.
	"claude":   {Display: "", Est: "~50 MB · usually under a minute", InstallBytes: 400 * mib, RAMBytes: 2 * gib},
	"codex":    {Display: "", Est: "~50 MB · usually under a minute", InstallBytes: 400 * mib, RAMBytes: 2 * gib},
	"opencode": {Display: "", Est: "~50 MB · usually under a minute", InstallBytes: 400 * mib, RAMBytes: 2 * gib},
}

// capabilityToolSpecFor looks a tool up, normalising case the way every other
// lookup in this file family does.
func capabilityToolSpecFor(tool string) (capabilityToolSpec, bool) {
	spec, ok := capabilityToolMatrix[strings.ToLower(strings.TrimSpace(tool))]
	return spec, ok
}

// capabilityFixSupportedOn is THE platform predicate the gap producer calls.
//
// Returns (supported, constraint). The two are exclusive by contract:
// supported ⇒ constraint == "", and !supported ⇒ constraint != "". A false
// predicate with an empty sentence would render as a disabled button with no
// reason, which is the dead end this file exists to remove — pinned by
// TestEveryUnsupportedPlatformNamesItsConstraint.
func capabilityFixSupportedOn(tool, goos, goarch string) (bool, string) {
	spec, ok := capabilityToolSpecFor(tool)
	if !ok || spec.Supported == nil {
		return true, ""
	}
	if spec.Supported(goos, goarch) {
		return true, ""
	}
	if spec.Constraint == nil {
		// Defensive: a row that refuses without a sentence still must not
		// produce a silent dead end. The test above prevents this shipping,
		// but the runtime must not be worse than the test.
		return false, fmt.Sprintf(
			"%s is not available on %s/%s, and Yaver has no install path for it here.",
			capabilityDisplayName(tool), goos, goarch)
	}
	return false, strings.TrimSpace(spec.Constraint(goos, goarch))
}

// capabilityHostPlatform reports the GOOS/GOARCH the producer resolves
// against. A var rather than a direct runtime.GOOS read because CLAUDE.md's
// "prove the guard by breaking it" is unsatisfiable otherwise: you cannot watch
// the Windows refusal fail from a Mac unless you can ask the Mac what a Windows
// box would be told. Production never reassigns it.
var capabilityHostPlatform = func() (string, string) { return runtime.GOOS, runtime.GOARCH }

// capabilityFixSupportedHere is capabilityFixSupportedOn for the running host.
// Every production call site uses this; the goos/goarch form exists so tests
// can assert a Mac's answer for a Linux box without one.
func capabilityFixSupportedHere(tool string) (bool, string) {
	goos, goarch := capabilityHostPlatform()
	return capabilityFixSupportedOn(tool, goos, goarch)
}

// capabilityInstallRoot is the directory whose VOLUME decides whether the
// install fits. Falls back to $HOME, which is where every npm-backed install
// lands. Never "." — the agent's CWD standing in for an unknown path is its own
// documented incident (CLAUDE.md, the /tasks payload bug).
func capabilityInstallRoot(tool string) string {
	if spec, ok := capabilityToolSpecFor(tool); ok && spec.Root != nil {
		if root := strings.TrimSpace(spec.Root()); root != "" {
			return root
		}
	}
	return capabilityHomeDir()
}

// capabilityHomeDir is the fallback volume probe target. Resolved at runtime —
// Yaver is not single-user and a literal /Users/<name> is a bug (CLAUDE.md).
// Returns "" rather than "." when HOME is unknowable: an unknown path must not
// silently become the agent's CWD.
func capabilityHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(home)
}

// existingAncestor walks up from path to the first directory that EXISTS.
//
// Needed because the volume we must measure is the one an install is about to
// WRITE to, and that directory does not exist yet — statfs on it returns ENOENT
// and the naive reading is "cannot measure", which degrades every fresh box to
// no resource check at all. The nearest existing ancestor is on the same
// filesystem in every layout Yaver installs into.
func existingAncestor(path string) string {
	p := strings.TrimSpace(path)
	for i := 0; p != "" && i < 64; i++ {
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(p)
		if parent == p {
			return ""
		}
		p = parent
	}
	return ""
}

// capabilityPlatformSummary renders the table for docs/diagnostics. Sorted by
// caller; this returns rows, not prose.
type capabilityPlatformRow struct {
	Tool            string `json:"tool"`
	Display         string `json:"display"`
	SupportedHere   bool   `json:"supportedHere"`
	Constraint      string `json:"constraint,omitempty"`
	InstallBytes    int64  `json:"installBytes,omitempty"`
	FirstBuildBytes int64  `json:"firstBuildBytes,omitempty"`
	RAMBytes        int64  `json:"ramBytes,omitempty"`
	Root            string `json:"root,omitempty"`
}

func capabilityPlatformRows(goos, goarch string) []capabilityPlatformRow {
	rows := make([]capabilityPlatformRow, 0, len(capabilityToolMatrix))
	for tool, spec := range capabilityToolMatrix {
		ok, constraint := capabilityFixSupportedOn(tool, goos, goarch)
		row := capabilityPlatformRow{
			Tool:            tool,
			Display:         capabilityDisplayName(tool),
			SupportedHere:   ok,
			Constraint:      constraint,
			InstallBytes:    spec.InstallBytes,
			FirstBuildBytes: spec.FirstBuildBytes,
			RAMBytes:        spec.RAMBytes,
		}
		if spec.Root != nil {
			row.Root = spec.Root()
		}
		rows = append(rows, row)
	}
	return rows
}
