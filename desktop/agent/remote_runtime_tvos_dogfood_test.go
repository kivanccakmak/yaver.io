package main

import (
	"strings"
	"testing"
)

func TestTVOSDogfoodBuildPinsClaimedSimulatorAndLowMemoryJobs(t *testing.T) {
	args := tvOSSimulatorBuildArgs("/work/tvos/YaverTV.xcodeproj", "TV-UDID", "/tmp/yaver-tvos")
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"-project /work/tvos/YaverTV.xcodeproj",
		"-scheme YaverTV",
		"-sdk appletvsimulator",
		"-destination id=TV-UDID",
		"-derivedDataPath /tmp/yaver-tvos",
		"-jobs 2",
		"-packageAuthorizationProvider netrc",
		"-onlyUsePackageVersionsFromResolvedFile",
		"CODE_SIGNING_ALLOWED=NO",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("tvOS Dogfood build lost %q: %s", want, joined)
		}
	}
	if strings.Contains(joined, "iphonesimulator") {
		t.Fatalf("tvOS Dogfood was routed through the iPhone build lane: %s", joined)
	}
}
