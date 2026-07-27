package main

// capability_resources.go — the RESOURCE half of "don't give hope if it isn't
// possible", and the reason a fix can never wedge the box it is fixing.
//
// THE DEFECT THIS REMOVES. capability_gap.go could offer "Install Flutter ·
// ~1.2 GB" on a machine with 340 MB free. The user taps it, waits eight
// minutes watching a real download, and gets ENOSPC — after the partial SDK has
// consumed the last of the disk. A box at zero free space cannot write a
// command's output, so it cannot even report why it died (the same fact that
// made autorun_resources.go necessary on 2026-07-16). The button was honest
// about the SIZE and silent about the HEADROOM, which is the inventory
// answering for the operation one more time.
//
// THREE VERDICTS, not two. The obvious design is fits/doesn't-fit, and it is
// wrong: the interesting case is the box that has room for the SDK and not for
// the first build after it. Refusing that box withholds a working install;
// starting it silently is the ten-minute wait that ends in disk-full. So:
//
//	ok           — start it, and put the headroom on the button anyway.
//	tight        — start it, AND say why it might not finish. The fix stays
//	               available; warning is not refusal.
//	insufficient — refuse, name the numbers, and offer a RECLAIM route.
//
// A refusal that is only a refusal is still a dead end. Every insufficient
// verdict carries `Reclaim` — a GapFix-shaped route to /storage/scan +
// /storage/reclaim, the reclaim engine this repo already ships — so "not enough
// space" comes with the specific caches that would fix it, with sizes.
//
// TWO HARD CONSTRAINTS ON RECLAIM, both inherited from CLAUDE.md's
// destructive-path rule and both enforced by the engine we delegate to
// (storage_reclaim.go), never re-implemented here:
//  1. The client MUST preview first. GapFix.Confirm names the preview route;
//     the apply route refuses without {"confirm":true} and lists every path
//     with its size and what regenerating it costs.
//  2. Only provably-regenerable caches. reclaimPathAllowed() refuses the
//     filesystem root, $HOME itself, anything outside $HOME, and — the one that
//     matters — any directory containing a .git. A "clean up" that eats
//     something the user wanted is a far worse bug than a full disk.
//
// ADVISORY WORK STAYS OFF THE CRITICAL PATH. Sizing reclaimable space is a
// 45-second IO storm. This file NEVER blocks a gap on it: it reads the warm
// scan cache if one exists, kicks a background scan if one does not, and
// degrades to "the route without the number". A label is not worth making a
// user wait (CLAUDE.md: advisory work must never sit in the critical path of
// the operation it annotates).

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// capabilityDiskFloorBytes is the headroom that must SURVIVE the install. Not
// a style preference: a box at zero free cannot write a log line, so it cannot
// tell anyone why it stopped — the failure mode that is indistinguishable from
// a hang, on a machine the user is not sitting in front of.
const capabilityDiskFloorBytes = int64(1) << 30 // 1 GB

// capabilityDefaultInstallBytes is the assumption for a tool whose row declares
// no size. Small on purpose: guessing large refuses installs that would have
// worked, and this lane's whole job is to not lie in either direction.
const capabilityDefaultInstallBytes = 200 * mib

// Resource verdict levels — the wire values clients branch on.
const (
	capabilityResourceOK           = "ok"
	capabilityResourceTight        = "tight"
	capabilityResourceInsufficient = "insufficient"
)

// CapabilityResource is the headroom fact, carried on the gap so every surface
// renders the same numbers. Bytes AND a human string: clients must not each
// invent their own formatter, which is how "1.2 GB" and "1288490188" ended up
// on two screens of the same app.
type CapabilityResource struct {
	// Path is the directory whose VOLUME was measured. Free space on / is not
	// free space on the volume holding /opt; probing the wrong one is a false
	// green with extra steps.
	Path      string `json:"path,omitempty"`
	FreeBytes int64  `json:"freeBytes"`
	FreeHuman string `json:"freeHuman"`
	// NeedBytes is install + the surviving floor — what must be free to START.
	NeedBytes int64  `json:"needBytes,omitempty"`
	NeedHuman string `json:"needHuman,omitempty"`
	// FirstBuildBytes is what the first build after the install needs ON TOP.
	FirstBuildBytes int64 `json:"firstBuildBytes,omitempty"`
	RAMTotalBytes   int64 `json:"ramTotalBytes,omitempty"`
	RAMNeedBytes    int64 `json:"ramNeedBytes,omitempty"`
	// ReclaimableBytes is 0 when no scan is warm — absent, not "nothing".
	ReclaimableBytes int64  `json:"reclaimableBytes,omitempty"`
	ReclaimableHuman string `json:"reclaimableHuman,omitempty"`
	// Level is ok | tight | insufficient.
	Level string `json:"level"`
}

// machineHeadroom is a point-in-time measurement. Measured=false means we could
// not read the volume — in which case NOTHING is refused. Refusing on a failed
// probe would turn a broken measurement into a broken product, which is the
// false-green rule pointing the other way.
type machineHeadroom struct {
	Path       string
	FreeBytes  int64
	TotalBytes int64
	RAMBytes   int64
	Measured   bool
}

// probeHeadroomFn is the measurement seam. Same reason as
// capabilityHostPlatform: a guard nobody has watched fail is a guess, and you
// cannot fill a test machine's disk to watch this one fail.
var probeHeadroomFn = probeMachineHeadroom

// probeMachineHeadroom measures the REAL free bytes on the volume holding
// path, plus total RAM. Reuses statfsGB (diskhealth_unix.go / _windows.go) and
// getSystemMemoryMB (process_unix.go / _windows.go) rather than adding a third
// way to ask the same kernel.
func probeMachineHeadroom(path string) machineHeadroom {
	h := machineHeadroom{Path: strings.TrimSpace(path)}
	if h.Path == "" {
		h.Path = capabilityHomeDir()
	}
	if mb, err := getSystemMemoryMB(); err == nil && mb > 0 {
		h.RAMBytes = mb * mib
	}
	if h.Path == "" {
		return h
	}
	// statfs needs an EXISTING path. An install root that does not exist yet
	// (the whole point — we are about to create it) statfs's to ENOENT, so walk
	// up to the nearest existing ancestor: that is the same volume.
	probe := existingAncestor(h.Path)
	if probe == "" {
		return h
	}
	totalGB, freeGB, ok := statfsGB(probe)
	if !ok {
		return h
	}
	h.Path = probe
	h.TotalBytes = int64(totalGB * float64(gib))
	h.FreeBytes = int64(freeGB * float64(gib))
	h.Measured = true
	return h
}

// capabilityResourceVerdict is what the producer acts on.
type capabilityResourceVerdict struct {
	Level string
	// Refusal is the named constraint when Level == insufficient. Never a
	// generic "not enough space" — it carries the numbers, because a vague
	// error costs whole sessions (CLAUDE.md, errSecInternalComponent).
	Refusal string
	// Warning is the named advisory when Level == tight. The fix STAYS
	// available; this rides beside it.
	Warning string
	// EstSuffix is appended to the button so the headroom is on the control the
	// user is about to press, not in a log they will not open.
	EstSuffix string
	Resource  *CapabilityResource
}

// evaluateCapabilityResources is THE resource predicate.
//
// Deliberately total: every tool gets a verdict, including tools with no row
// (they take capabilityDefaultInstallBytes). A tool that opts out of sizing
// still must not be startable on a full disk.
func evaluateCapabilityResources(tool string, h machineHeadroom) capabilityResourceVerdict {
	spec, _ := capabilityToolSpecFor(tool)

	install := spec.InstallBytes
	if install <= 0 {
		install = capabilityDefaultInstallBytes
	}
	need := install + capabilityDiskFloorBytes

	res := &CapabilityResource{
		Path:            h.Path,
		FreeBytes:       h.FreeBytes,
		FreeHuman:       humanBytesDG(h.FreeBytes),
		NeedBytes:       need,
		NeedHuman:       humanBytesDG(need),
		FirstBuildBytes: spec.FirstBuildBytes,
		RAMTotalBytes:   h.RAMBytes,
		RAMNeedBytes:    spec.RAMBytes,
		Level:           capabilityResourceOK,
	}

	if !h.Measured {
		// Could not read the volume. Say nothing and refuse nothing — an
		// unmeasured box is not a full box, and turning a probe failure into a
		// refusal would break installs that work.
		return capabilityResourceVerdict{Level: capabilityResourceOK, Resource: nil}
	}

	verdict := capabilityResourceVerdict{Level: capabilityResourceOK, Resource: res}
	verdict.EstSuffix = fmt.Sprintf("%s free on %s", humanBytesDG(h.FreeBytes), h.Path)

	if h.FreeBytes < need {
		res.Level = capabilityResourceInsufficient
		verdict.Level = capabilityResourceInsufficient
		verdict.Refusal = fmt.Sprintf(
			"%s needs about %s to install and %s of headroom to keep this machine usable — %s has %s free. "+
				"Yaver will not start a download it cannot finish: filling this disk would take the box "+
				"offline mid-install, and a machine with no free space cannot even log why it stopped.",
			capabilityDisplayName(tool), humanBytesDG(install), humanBytesDG(capabilityDiskFloorBytes),
			h.Path, humanBytesDG(h.FreeBytes))
		attachReclaimNumbers(res)
		return verdict
	}

	var warnings []string
	if spec.FirstBuildBytes > 0 && h.FreeBytes < need+spec.FirstBuildBytes {
		warnings = append(warnings, fmt.Sprintf(
			"the install fits (%s needed, %s free on %s) but the FIRST build after it typically needs "+
				"another %s — you may run out mid-build",
			humanBytesDG(install), humanBytesDG(h.FreeBytes), h.Path, humanBytesDG(spec.FirstBuildBytes)))
	}
	if spec.RAMBytes > 0 && h.RAMBytes > 0 && h.RAMBytes < spec.RAMBytes {
		warnings = append(warnings, fmt.Sprintf(
			"%s wants about %s of RAM and this machine has %s — expect swapping or an OOM kill during "+
				"builds rather than a clean failure",
			capabilityDisplayName(tool), humanBytesDG(spec.RAMBytes), humanBytesDG(h.RAMBytes)))
	}

	if len(warnings) > 0 {
		res.Level = capabilityResourceTight
		verdict.Level = capabilityResourceTight
		verdict.Warning = "Heads up — " + strings.Join(warnings, "; ") + "."
		attachReclaimNumbers(res)
	}
	return verdict
}

// capabilityReclaimFix is the space-freeing ROUTE, GapFix-shaped so every
// surface renders it with the code it already has for a fix.
//
// Two-step by construction. Method/Path is the APPLY route and it refuses
// without {"confirm":true} (storage_reclaim_http.go); Confirm names the PREVIEW
// route the client must call first, whose response lists every target with its
// size and what regenerating it costs. A client that skips the preview cannot
// delete anything — the gate is server-side, not a UI convention.
func capabilityReclaimFix(res *CapabilityResource) *GapFix {
	label := "Free up space"
	est := "shows every cache and build artifact with its size before anything is deleted"
	if res != nil && res.ReclaimableBytes > 0 {
		label = fmt.Sprintf("Free up space — about %s reclaimable", res.ReclaimableHuman)
		est = fmt.Sprintf("%s in caches and build artifacts · you approve each item", res.ReclaimableHuman)
	}
	return &GapFix{
		Label:  label,
		Method: "POST",
		Path:   "/storage/reclaim",
		// No stream: this route answers synchronously with a per-target result.
		// The preview below is what makes it visible, and the parser accepts a
		// streamless fix only when it is confirm-gated for exactly that reason.
		Est:   est,
		Retry: true,
		Confirm: &GapConfirm{
			Method: "GET",
			Path:   "/storage/scan",
			Field:  "confirm",
			Prompt: "Review every path and size first. Yaver only ever proposes caches and build " +
				"artifacts it can prove are regenerable — never source, never a directory containing a " +
				"git repository, never anything outside your home directory.",
		},
	}
}

// --- reclaimable sizing, strictly off the critical path --------------------

var (
	reclaimWarmMu   sync.Mutex
	reclaimWarmAt   time.Time
	reclaimWarmBusy bool
)

// attachReclaimNumbers fills the reclaimable figure from a WARM scan only, and
// kicks a background scan when there is none.
//
// It must never block: scanStorage takes up to scanDeadline (45s) of du storm,
// and a user staring at "why can't I install this" is not going to wait 45s for
// a nicer label. First failure gets the route without the number; the next poll
// gets both.
func attachReclaimNumbers(res *CapabilityResource) {
	if res == nil {
		return
	}
	if bytes, ok := cachedReclaimableBytes(); ok {
		res.ReclaimableBytes = bytes
		res.ReclaimableHuman = humanBytesDG(bytes)
		return
	}
	warmReclaimScanInBackground()
}

// cachedReclaimableBytes reads the reclaim engine's existing scan cache
// WITHOUT triggering a scan. Deliberately a direct read of scanCache rather
// than scanStorage(false): scanStorage rescans on a cold cache, which is the
// blocking call this whole helper exists to avoid.
func cachedReclaimableBytes() (int64, bool) {
	scanCacheMu.Lock()
	defer scanCacheMu.Unlock()
	if scanCache == nil || time.Since(scanCacheAt) > 30*time.Minute {
		return 0, false
	}
	return scanCache.TotalReclaimableBytes, true
}

// warmReclaimScanInBackground starts at most one scan, at most every 5 minutes.
// Unbounded kicks would let a polling client turn a status endpoint into a
// permanent du storm on the user's box — the advisory work becoming the outage.
func warmReclaimScanInBackground() {
	reclaimWarmMu.Lock()
	if reclaimWarmBusy || time.Since(reclaimWarmAt) < 5*time.Minute {
		reclaimWarmMu.Unlock()
		return
	}
	reclaimWarmBusy = true
	reclaimWarmAt = time.Now()
	reclaimWarmMu.Unlock()

	go func() {
		defer func() {
			reclaimWarmMu.Lock()
			reclaimWarmBusy = false
			reclaimWarmMu.Unlock()
			// A panic in an advisory warm-up must not take the agent with it.
			_ = recover()
		}()
		_ = scanStorage(false)
	}()
}
