package testkit

// runtime_families_disk.go — which Apple simulator runtimes this machine HAS,
// answered by reading the disk instead of asking simctl.
//
// ── The incident ─────────────────────────────────────────────────────────────
//
// On a real Mac mini (2026-07-25) `xcrun simctl help` took **17 seconds**. The
// capability probe allowed simctl 4 seconds, so it timed out and every Apple
// simulator target came back:
//
//   ios-simulator  enabled=false
//   reason: "iOS runtime not installed. Open Xcode > Settings > Components and install it."
//
// iOS 26.4 was installed. A device was booted on it. The product told the user to
// go install a component they already had, and the WebRTC lane for Swift/RN looked
// unavailable on a machine perfectly able to run it.
//
// Two lessons, both encoded here:
//
//   • A slow dependency is not an absent one. "I could not find out" must never
//     render as "it is not there" — see InstalledRuntimeFamiliesDetermined, which
//     returns that distinction instead of collapsing it.
//   • Prefer the cheapest probe that cannot hang. Runtime bundles are FILES;
//     reading files cannot block on an XPC service that is wedged or busy.
//
// Three on-disk layouts, because Apple has moved these twice:
//
//   1. Xcode 15+/26 — mounted volumes:
//      /Library/Developer/CoreSimulator/Volumes/{iOS_23E244,watchOS_23T240b,…}
//   2. The image catalogue (names runtimes even when the volume is unmounted):
//      /Library/Developer/CoreSimulator/Images/images.plist, containing
//      com.apple.CoreSimulator.SimRuntime.iOS-26-4 — searched as raw bytes so
//      binary and XML plists both work, with no plist dependency.
//   3. Classic bundles: .../Profiles/Runtimes/iOS 17.5.simruntime, plus the copies
//      inside <DEVELOPER_DIR>/Platforms/*.platform.

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

var simRuntimeDiskRoots = []string{
	"/Library/Developer/CoreSimulator/Volumes",
	"/Library/Developer/CoreSimulator/Profiles/Runtimes",
}

const simRuntimeImageCatalogue = "/Library/Developer/CoreSimulator/Images/images.plist"

// RuntimeFamiliesFromDisk returns the simulator families present on this machine
// without invoking simctl. Empty on non-darwin hosts.
func RuntimeFamiliesFromDisk() map[string]bool {
	out := map[string]bool{}
	if runtime.GOOS != "darwin" {
		return out
	}
	for _, root := range simRuntimeDiskRoots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range entries {
			AddRuntimeFamilyFromName(out, e.Name())
		}
	}
	if devDir, err := exec.Command("xcode-select", "-p").Output(); err == nil {
		pattern := filepath.Join(strings.TrimSpace(string(devDir)), "Platforms", "*.platform",
			"Library", "Developer", "CoreSimulator", "Profiles", "Runtimes", "*")
		if matches, globErr := filepath.Glob(pattern); globErr == nil {
			for _, m := range matches {
				AddRuntimeFamilyFromName(out, filepath.Base(m))
			}
		}
	}
	if data, err := os.ReadFile(simRuntimeImageCatalogue); err == nil {
		AddRuntimeFamiliesFromImageCatalogue(out, string(data))
	}
	return out
}

// AddRuntimeFamilyFromName reads the family out of a volume or bundle name such
// as "iOS_23E244", "watchOS 26.4.simruntime" or "xrOS_21O5565d".
func AddRuntimeFamilyFromName(out map[string]bool, name string) {
	lower := strings.ToLower(strings.TrimSpace(name))
	switch {
	case strings.HasPrefix(lower, "ios_"), strings.HasPrefix(lower, "ios "):
		out["iOS"] = true
	case strings.HasPrefix(lower, "watchos_"), strings.HasPrefix(lower, "watchos "):
		out["watchOS"] = true
	case strings.HasPrefix(lower, "tvos_"), strings.HasPrefix(lower, "tvos "),
		strings.HasPrefix(lower, "appletvos_"), strings.HasPrefix(lower, "appletvos "):
		out["tvOS"] = true
	case strings.HasPrefix(lower, "visionos_"), strings.HasPrefix(lower, "visionos "),
		// Xcode historically labelled visionOS runtimes `xrOS`; accept both.
		strings.HasPrefix(lower, "xros_"), strings.HasPrefix(lower, "xros "):
		out["visionOS"] = true
	}
}

// AddRuntimeFamiliesFromImageCatalogue scans raw plist bytes for
// com.apple.CoreSimulator.SimRuntime.<Family>-<version> identifiers.
func AddRuntimeFamiliesFromImageCatalogue(out map[string]bool, blob string) {
	const marker = "SimRuntime."
	for idx := 0; ; {
		i := strings.Index(blob[idx:], marker)
		if i < 0 {
			return
		}
		idx += i + len(marker)
		end := idx
		for end < len(blob) && (blob[end] == '-' || isASCIIAlnum(blob[end])) {
			end++
		}
		if end <= idx {
			return
		}
		// "iOS-26-4" → "iOS_26_4" so the shared name parser handles both shapes.
		AddRuntimeFamilyFromName(out, strings.ReplaceAll(blob[idx:end], "-", "_"))
		idx = end
	}
}

func isASCIIAlnum(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// InstalledRuntimeFamiliesDetermined returns the installed families AND whether
// the answer can be trusted.
//
// `determined == false` means "we could not find out" — NOT "nothing is
// installed". Callers must render those differently: the first is a diagnostic
// about this host, the second is an instruction to the user. Collapsing them is
// what produced a confident, wrong "install a runtime" on a machine that had one.
func InstalledRuntimeFamiliesDetermined(ctx context.Context) (map[string]bool, bool) {
	if fromDisk := RuntimeFamiliesFromDisk(); len(fromDisk) > 0 {
		return fromDisk, true // instant, and cannot hang
	}
	if runtime.GOOS != "darwin" {
		return map[string]bool{}, true // definitively none, not a failure to ask
	}
	if _, err := exec.LookPath("xcrun"); err != nil {
		return map[string]bool{}, true
	}
	out, err := runCtx(ctx, "xcrun", "simctl", "list", "runtimes")
	if err != nil {
		// Disk found nothing AND simctl did not answer — we genuinely do not know.
		return map[string]bool{}, false
	}
	return ParseInstalledRuntimeFamilies(out), true
}
