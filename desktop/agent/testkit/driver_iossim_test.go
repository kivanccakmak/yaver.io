package testkit

import "testing"

func TestPickSimulatorFallsBackToVisionProWhenNoIPhoneInstalled(t *testing.T) {
	out := `
-- visionOS 2.4 --
    Apple Vision Pro (11111111-2222-3333-4444-555555555555) (Shutdown)
`
	got, ok := pickSimulatorFromList(out, "")
	if !ok {
		t.Fatal("pickSimulatorFromList() did not find a simulator")
	}
	if got != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("pickSimulatorFromList() = %q, want Vision Pro UDID", got)
	}
}

func TestPickSimulatorPrefersIPhoneWhenAvailable(t *testing.T) {
	out := `
-- visionOS 2.4 --
    Apple Vision Pro (11111111-2222-3333-4444-555555555555) (Booted)
-- iOS 18.4 --
    iPhone 16 Pro (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee) (Shutdown)
`
	got, ok := pickSimulatorFromList(out, "")
	if !ok {
		t.Fatal("pickSimulatorFromList() did not find a simulator")
	}
	if got != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("pickSimulatorFromList() = %q, want already-booted Vision Pro UDID", got)
	}

	got, ok = pickSimulatorFromList(out, "iPhone")
	if !ok {
		t.Fatal("pickSimulatorFromList(iPhone) did not find a simulator")
	}
	if got != "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" {
		t.Fatalf("pickSimulatorFromList(iPhone) = %q, want iPhone UDID", got)
	}
}

// The renamed-simulator case, verbatim from the Mac mini: the only simulator is
// "wrtc-test" — an iPhone-15-type device on iOS 26.4, booted — and matching by
// display name reported `no available simulator matching "iPhone"`. Type
// identifiers are the truth; names are decoration.
func TestRankSimulatorsFromJSONMatchesTypeNotJustName(t *testing.T) {
	jsonOut := `{"devices":{
		"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
			{"name":"wrtc-test","udid":"UDID-WRTC","state":"Booted","isAvailable":true,
			 "deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-15"}],
		"com.apple.CoreSimulator.SimRuntime.watchOS-26-4":[
			{"name":"my watch","udid":"UDID-WATCH","state":"Shutdown","isAvailable":true,
			 "deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-9-45mm"}]}}`

	got := RankSimulatorsFromJSON(jsonOut, "iPhone")
	if len(got) != 1 || got[0] != "UDID-WRTC" {
		t.Fatalf("a renamed iPhone-type simulator must match an iPhone request by TYPE, got %v", got)
	}
	// A watch request finds the watch, not the phone.
	if got := RankSimulatorsFromJSON(jsonOut, "Apple Watch"); len(got) != 1 || got[0] != "UDID-WATCH" {
		t.Fatalf("watch request resolved wrongly: %v", got)
	}
	// No filter: everything, booted first.
	all := RankSimulatorsFromJSON(jsonOut, "")
	if len(all) != 2 || all[0] != "UDID-WRTC" {
		t.Fatalf("unfiltered ranking should lead with the booted device: %v", all)
	}
	// Unavailable devices never rank.
	unavailable := `{"devices":{"r":[{"name":"iPhone 15","udid":"U1","state":"Shutdown","isAvailable":false,
		"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-15"}]}}`
	if got := RankSimulatorsFromJSON(unavailable, "iPhone"); len(got) != 0 {
		t.Fatalf("an unavailable device was ranked: %v", got)
	}
	// Garbage JSON degrades to empty, not panic.
	if got := RankSimulatorsFromJSON("{not json", "iPhone"); got != nil {
		t.Fatalf("garbage input should yield nil, got %v", got)
	}
}

func TestSimulatorCreateSpecFromJSONPicksMatchingRuntimeFamily(t *testing.T) {
	deviceTypes := `{"devicetypes":[
		{"name":"iPad Pro 13-inch (M5) (16GB)","identifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-16GB"},
		{"name":"iPad Pro 13-inch (M5)","identifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB"},
		{"name":"Apple TV 4K","identifier":"com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-1080p"},
		{"name":"Apple Vision Pro","identifier":"com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro"}
	]}`
	runtimes := `{"runtimes":[
		{"name":"iOS 18.6","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-6","isAvailable":true},
		{"name":"iOS 26.2","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-2","isAvailable":true},
		{"name":"tvOS 26.2","identifier":"com.apple.CoreSimulator.SimRuntime.tvOS-26-2","isAvailable":true},
		{"name":"visionOS 26.2","identifier":"com.apple.CoreSimulator.SimRuntime.xrOS-26-2","isAvailable":true}
	]}`

	ipad, ok := simulatorCreateSpecFromJSON(deviceTypes, runtimes, "iPad")
	if !ok {
		t.Fatal("iPad create spec was not found")
	}
	if ipad.DeviceTypeID != "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB" ||
		ipad.RuntimeID != "com.apple.CoreSimulator.SimRuntime.iOS-26-2" {
		t.Fatalf("bad iPad create spec: %+v", ipad)
	}

	tv, ok := simulatorCreateSpecFromJSON(deviceTypes, runtimes, "Apple TV")
	if !ok {
		t.Fatal("Apple TV create spec was not found")
	}
	if tv.RuntimeID != "com.apple.CoreSimulator.SimRuntime.tvOS-26-2" {
		t.Fatalf("Apple TV picked wrong runtime: %+v", tv)
	}

	vision, ok := simulatorCreateSpecFromJSON(deviceTypes, runtimes, "Apple Vision")
	if !ok {
		t.Fatal("Apple Vision create spec was not found")
	}
	if vision.RuntimeID != "com.apple.CoreSimulator.SimRuntime.xrOS-26-2" {
		t.Fatalf("Apple Vision picked wrong runtime: %+v", vision)
	}
}
