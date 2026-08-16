package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func fullDisk(free int64) machineHeadroom {
	return machineHeadroom{Path: "/opt", FreeBytes: free, TotalBytes: 100 * gib, RAMBytes: 16 * gib, Measured: true}
}

// THE HEADLINE RESOURCE DEFECT: "Install Flutter · ~1.2 GB" offered on a box
// with 340 MB free. The user waits eight minutes, fills the disk, and the box
// can no longer write a log line explaining why.
//
// BREAK IT: flip the comparison in evaluateCapabilityResources to
// `h.FreeBytes > need` and this fails; claim 10 GB free where there are 100 MB
// (change fullDisk below) and TestVerdictIsOKWhenTheBoxHasRoom fails instead.
// Both directions are guarded on purpose.
func TestInstallIsRefusedWhenTheVolumeCannotHoldIt(t *testing.T) {
	v := evaluateCapabilityResources("flutter", fullDisk(340*mib))
	if v.Level != capabilityResourceInsufficient {
		t.Fatalf("340 MB free must refuse a ~2 GB SDK; got level %q", v.Level)
	}
	if v.Refusal == "" {
		t.Fatal("a refusal with no sentence is a dead end")
	}
	// The numbers must be IN the sentence — "not enough space" is the vague
	// error class that costs whole sessions.
	for _, want := range []string{"340", "/opt", "Flutter"} {
		if !strings.Contains(v.Refusal, want) {
			t.Errorf("refusal must name %q, got %q", want, v.Refusal)
		}
	}
	if v.Resource == nil || v.Resource.Level != capabilityResourceInsufficient {
		t.Fatalf("the measurement must ride along, got %+v", v.Resource)
	}
	if v.Resource.NeedBytes <= v.Resource.FreeBytes {
		t.Error("NeedBytes must exceed FreeBytes in a refusal — the client renders the difference")
	}
}

func TestVerdictIsOKWhenTheBoxHasRoom(t *testing.T) {
	v := evaluateCapabilityResources("flutter", fullDisk(80*gib))
	if v.Level != capabilityResourceOK {
		t.Fatalf("80 GB free must not refuse or warn for a 2 GB SDK; got %q (%s%s)", v.Level, v.Refusal, v.Warning)
	}
	if v.EstSuffix == "" {
		t.Error("the headroom belongs on the button even when everything is fine")
	}
}

// THE THIRD VERDICT — the one fits/doesn't-fit misses. The SDK fits; the first
// build after it does not. Refusing withholds a working install; starting
// silently is a ten-minute wait that ends in disk-full.
func TestTightHeadroomWarnsAndStillOffersTheFix(t *testing.T) {
	// flutter: install 2 GB + 1 GB floor = 3 GB to start, +2 GB first build.
	v := evaluateCapabilityResources("flutter", fullDisk(3200*mib))
	if v.Level != capabilityResourceTight {
		t.Fatalf("3.2 GB free fits the install but not the first build; want tight, got %q", v.Level)
	}
	if v.Refusal != "" {
		t.Errorf("tight is a WARNING, never a refusal: %q", v.Refusal)
	}
	if !strings.Contains(v.Warning, "mid-build") {
		t.Errorf("the warning must say what may go wrong, got %q", v.Warning)
	}
}

// RAM warns and never refuses: it cannot be reclaimed, and the install itself
// almost always succeeds. Telling the user their 2 GB box will swap through an
// Android build is honest; refusing the download is not.
func TestLowRAMWarnsAndNeverRefuses(t *testing.T) {
	h := machineHeadroom{Path: "/opt", FreeBytes: 200 * gib, TotalBytes: 500 * gib, RAMBytes: 2 * gib, Measured: true}
	v := evaluateCapabilityResources("android-sdk", h)
	if v.Level != capabilityResourceTight {
		t.Fatalf("2 GB RAM under a 4 GB floor must warn; got %q", v.Level)
	}
	if v.Refusal != "" {
		t.Errorf("RAM must never refuse an install: %q", v.Refusal)
	}
	if !strings.Contains(strings.ToLower(v.Warning), "ram") {
		t.Errorf("the warning must name RAM, got %q", v.Warning)
	}
}

// A failed measurement is not a full disk. Turning a broken probe into a
// refusal would break installs that work — the false-green rule pointing the
// other way.
func TestAnUnmeasuredVolumeRefusesNothing(t *testing.T) {
	v := evaluateCapabilityResources("flutter", machineHeadroom{Path: "/opt", Measured: false})
	if v.Level != capabilityResourceOK {
		t.Fatalf("an unreadable volume must not refuse: %q / %q", v.Level, v.Refusal)
	}
	if v.Resource != nil {
		t.Error("no measurement ⇒ no numbers to publish; a zero here reads as 'no space'")
	}
}

// Every tool gets a verdict, including ones with no row. A tool that opts out
// of sizing still must not be startable on a full disk.
func TestToolsWithNoRowStillGetADiskFloor(t *testing.T) {
	v := evaluateCapabilityResources("some-tool-yaver-never-heard-of", fullDisk(10*mib))
	if v.Level != capabilityResourceInsufficient {
		t.Fatalf("10 MB free must refuse even an unsized tool; got %q", v.Level)
	}
}

// THE PRODUCER wires it together: a disk-blocked gap is a DIFFERENT code, has
// no install button, and carries the reclaim route.
//
// BREAK IT: drop the insufficient branch in capabilityGapForMissingTools and
// this fails with an Install button on a full disk.
func TestProducerRefusesOnDiskAndOffersReclaim(t *testing.T) {
	restore := probeHeadroomFn
	probeHeadroomFn = func(string) machineHeadroom { return fullDisk(120 * mib) }
	defer func() { probeHeadroomFn = restore }()

	gap := DetectCapabilityGap(CapabilityGapContext{Framework: "flutter", MissingTools: []string{"flutter"}})
	if gap == nil {
		t.Fatal("a full disk must still be named")
	}
	if gap.Fix != nil {
		t.Fatalf("an install button on a disk that cannot hold the install: %+v", gap.Fix)
	}
	if gap.Code != ReasonCapabilityInsufficientDisk {
		t.Errorf("Code = %q, want %q — a client that reads toolchain_missing sends the user to press Install",
			gap.Code, ReasonCapabilityInsufficientDisk)
	}
	if gap.Constraint == "" {
		t.Error("no fix AND no constraint is the dead end this type forbids")
	}
	if gap.Reclaim == nil {
		t.Fatal("a refusal that is only a refusal is a dead end — the reclaim route must ride along")
	}
	if gap.Reclaim.Confirm == nil {
		t.Fatal("a destructive route with no preview gate would delete without showing what")
	}
	if gap.Reclaim.Method != "POST" || gap.Reclaim.Path != "/storage/reclaim" {
		t.Errorf("reclaim route = %s %s, want the engine this repo already ships", gap.Reclaim.Method, gap.Reclaim.Path)
	}
	if gap.Reclaim.Confirm.Path != "/storage/scan" {
		t.Errorf("preview route = %q, want /storage/scan", gap.Reclaim.Confirm.Path)
	}
	if gap.Resource == nil || gap.Resource.FreeBytes != 120*mib {
		t.Errorf("the measurement must be published for the UI to render, got %+v", gap.Resource)
	}
}

// The warning lane end-to-end: the button SURVIVES, and the advisory rides
// beside it. This is the "warn, don't only refuse" requirement.
func TestProducerWarnsWithoutRemovingTheButton(t *testing.T) {
	restore := probeHeadroomFn
	probeHeadroomFn = func(string) machineHeadroom { return fullDisk(3200 * mib) }
	defer func() { probeHeadroomFn = restore }()

	gap := DetectCapabilityGap(CapabilityGapContext{Framework: "flutter", MissingTools: []string{"flutter"}})
	if gap == nil || gap.Fix == nil {
		t.Fatalf("a tight box can still install — the button must stay: %+v", gap)
	}
	if gap.Warning == "" {
		t.Fatal("a ten-minute download that may not finish must say so BEFORE it starts")
	}
	if gap.Constraint != "" {
		t.Errorf("a warning is not a constraint: %q", gap.Constraint)
	}
	if gap.Reclaim == nil {
		t.Error("when space is nearly the blocker, the reclaim route must be offered pre-emptively")
	}
	// The headroom belongs ON the control the user is about to press.
	if !strings.Contains(gap.Fix.Est, "free on") {
		t.Errorf("Fix.Est = %q — must carry the current headroom, not just the download size", gap.Fix.Est)
	}
	if !strings.Contains(gap.Fix.Est, "1.2 GB") {
		t.Errorf("Fix.Est = %q — must still carry the download size the clients pin", gap.Fix.Est)
	}
}

// The wire shape the two capabilityGap.ts twins parse.
func TestResourceWireShape(t *testing.T) {
	restore := probeHeadroomFn
	probeHeadroomFn = func(string) machineHeadroom { return fullDisk(120 * mib) }
	defer func() { probeHeadroomFn = restore }()

	gap := DetectCapabilityGap(CapabilityGapContext{Framework: "flutter", MissingTools: []string{"flutter"}})
	raw, err := json.Marshal(gap)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"code", "capability", "summary", "constraint", "resource", "reclaim"} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("wire key %q missing from %s", key, raw)
		}
	}
	res, _ := decoded["resource"].(map[string]any)
	for _, key := range []string{"freeBytes", "freeHuman", "needBytes", "level"} {
		if _, ok := res[key]; !ok {
			t.Errorf("wire key resource.%q missing", key)
		}
	}
	rec, _ := decoded["reclaim"].(map[string]any)
	if _, ok := rec["confirm"]; !ok {
		t.Error("reclaim.confirm missing — the client would delete without a preview")
	}
}

// existingAncestor is what makes a resource check possible on a FRESH box: the
// install root does not exist yet (that is the point), so statfs on it is
// ENOENT and the naive reading degrades to no check at all.
func TestExistingAncestorFindsTheVolumeOfAPathThatDoesNotExistYet(t *testing.T) {
	dir := t.TempDir()
	deep := dir + "/not/created/yet/flutter"
	if got := existingAncestor(deep); got != dir {
		t.Errorf("existingAncestor(%q) = %q, want %q", deep, got, dir)
	}
	if got := existingAncestor(dir); got != dir {
		t.Errorf("an existing path must be its own ancestor, got %q", got)
	}
}
