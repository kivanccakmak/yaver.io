package testkit

// Every case here comes from the layout of a real Mac mini running Xcode 26.4,
// where `xcrun simctl help` took 17 SECONDS — long enough that the 4s capability
// probe timed out and reported "iOS runtime not installed" for an installed,
// booted iOS 26.4.

import (
	"context"
	"testing"
)

func TestAddRuntimeFamilyFromNameCoversEveryLayout(t *testing.T) {
	cases := map[string]string{
		// Xcode 15+/26 mounted volumes (the shape on the mini).
		"iOS_23E244":      "iOS",
		"watchOS_23T240b": "watchOS",
		"xrOS_21O5565d":   "visionOS",
		"tvOS_21L569":     "tvOS",
		// Classic .simruntime bundles.
		"iOS 17.5.simruntime":     "iOS",
		"watchOS 10.5.simruntime": "watchOS",
		"tvOS 17.5.simruntime":    "tvOS",
		"visionOS 1.2.simruntime": "visionOS",
		// Identifier form, after the '-'→'_' normalisation.
		"iOS_26_4": "iOS",
	}
	for name, want := range cases {
		got := map[string]bool{}
		AddRuntimeFamilyFromName(got, name)
		if !got[want] {
			t.Errorf("%q did not yield family %q (got %v)", name, want, got)
		}
	}

	// Things that must NOT be mistaken for a runtime.
	for _, noise := range []string{"", "DeviceTypes", "Inbox", "mnt", "images.plist", "iOSsomething"} {
		got := map[string]bool{}
		AddRuntimeFamilyFromName(got, noise)
		if len(got) != 0 {
			t.Errorf("%q was misread as a runtime: %v", noise, got)
		}
	}
}

func TestImageCatalogueParsingFindsEveryRuntime(t *testing.T) {
	// Trimmed from the mini's /Library/Developer/CoreSimulator/Images/images.plist
	// (the file is a binary plist; the identifiers appear literally in the bytes,
	// which is why this is a byte scan and not a plist parse).
	blob := "\x00\x08bundleIdentifier\x10com.apple.CoreSimulator.SimRuntime.watchOS-26-4" +
		"\x00relativefile:///Library/Developer/CoreSimulator/Volumes/watchOS_23T240b/…" +
		"bundleIdentifiercom.apple.CoreSimulator.SimRuntime.iOS-26-4\x00"
	got := map[string]bool{}
	AddRuntimeFamiliesFromImageCatalogue(got, blob)
	if !got["iOS"] {
		t.Error("iOS runtime missing from the catalogue scan — this is exactly the runtime the mini had installed while the product said it did not")
	}
	if !got["watchOS"] {
		t.Errorf("watchOS runtime missing: %v", got)
	}
	if got["tvOS"] || got["visionOS"] {
		t.Errorf("invented runtimes that are not in the catalogue: %v", got)
	}
	// Must not loop forever or panic on a truncated identifier.
	AddRuntimeFamiliesFromImageCatalogue(map[string]bool{}, "SimRuntime.")
}

// The distinction that matters: "could not find out" must not render as "absent".
func TestDeterminedFlagSeparatesUnknownFromAbsent(t *testing.T) {
	fams, determined := InstalledRuntimeFamiliesDetermined(context.Background())
	// On this dev machine either outcome is legitimate; what must hold is the
	// invariant: when we DID determine something, an empty set means genuinely
	// none — and when we could not, determined is false rather than a silent lie.
	if determined && fams == nil {
		t.Error("determined=true with a nil map — callers cannot distinguish that from absent")
	}
	if !determined && len(fams) > 0 {
		t.Error("determined=false but families were returned — an unknown answer must not carry data callers might trust")
	}
}
