package testkit

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"time"
)

// iOS Simulator driver — wraps Apple's `simctl`. macOS only.
//
// What this gives the solo dev today:
//
//   - Boot a named simulator, otherwise the best available Apple simulator.
//   - Install a built .app bundle into the simulator.
//   - Launch the app by bundle identifier.
//   - Capture a screenshot.
//   - Shut the simulator down at the end of the run.
//
// What it does NOT give yet (M5+ work): tap/swipe/type via WebDriverAgent
// or XCUITest. The full UI driver bridge is the next milestone; this
// driver lets users at least confirm "my iOS build boots and launches"
// from CI without renting a BrowserStack device.

// IOSSimDriver is the lifecycle wrapper.
type IOSSimDriver struct {
	UDID       string // optional — defaults to first booted device
	DeviceType string // e.g. "iPhone 15" — optional substring when no UDID is set
	BundleID   string // app bundle id, e.g. "io.yaver.mobile"
	AppPath    string // path to .app bundle

	// Chooser, when set, picks which of the ranked candidate UDIDs to use.
	// Return ok=false to reject them all.
	//
	// This exists so the agent can enforce EXCLUSIVITY (one session per
	// simulator) without testkit having to know what a session is. Ranking —
	// "which simulator is the best fit" — stays here; arbitration — "who already
	// has it" — belongs to the caller. Without a Chooser the behaviour is
	// unchanged: best-ranked candidate wins.
	Chooser func(candidates []string) (string, bool)
}

// Available returns nil if simctl appears usable on the current host.
func (d *IOSSimDriver) Available() error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("ios simulator requires macOS")
	}
	if _, err := exec.LookPath("xcrun"); err != nil {
		return fmt.Errorf("xcrun not found — install Xcode")
	}
	out, err := exec.Command("xcrun", "simctl", "help").CombinedOutput()
	if err != nil {
		return fmt.Errorf("simctl unavailable: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Boot boots the device and returns its UDID. If d.UDID is set, that
// device is booted; otherwise we look up the first available simulator
// matching d.DeviceType (or pick the best available Apple simulator if neither is set).
func (d *IOSSimDriver) Boot(ctx context.Context) (string, error) {
	if err := d.Available(); err != nil {
		return "", err
	}
	udid := d.UDID
	if udid == "" {
		candidates, err := RankSimulators(ctx, d.DeviceType)
		if err != nil {
			if strings.TrimSpace(d.DeviceType) == "" {
				return "", err
			}
			created, createErr := CreateSimulatorForType(ctx, d.DeviceType)
			if createErr != nil {
				return "", fmt.Errorf("%w; could not auto-create simulator: %v", err, createErr)
			}
			candidates = []string{created}
		}
		if d.Chooser != nil {
			chosen, ok := d.Chooser(candidates)
			if !ok {
				return "", fmt.Errorf("no simulator matching %q is available — every candidate is already in use by another session", d.DeviceType)
			}
			udid = chosen
		} else {
			udid = candidates[0]
		}
	}
	// Boot is idempotent — simctl errors on already-booted devices, so
	// we ignore that specific failure.
	out, _ := runCtx(ctx, "xcrun", "simctl", "boot", udid)
	if strings.Contains(out, "Unable to boot device in current state: Booted") {
		return udid, nil
	}
	return udid, nil
}

// Install installs the .app bundle into the booted simulator.
func (d *IOSSimDriver) Install(ctx context.Context, udid string) error {
	if d.AppPath == "" {
		return fmt.Errorf("install: AppPath is empty")
	}
	if _, err := runCtx(ctx, "xcrun", "simctl", "install", udid, d.AppPath); err != nil {
		return fmt.Errorf("simctl install: %w", err)
	}
	return nil
}

// Launch launches the app by its bundle id.
func (d *IOSSimDriver) Launch(ctx context.Context, udid string) error {
	if d.BundleID == "" {
		return fmt.Errorf("launch: BundleID is empty")
	}
	if _, err := runCtx(ctx, "xcrun", "simctl", "launch", udid, d.BundleID); err != nil {
		return fmt.Errorf("simctl launch: %w", err)
	}
	return nil
}

// Screenshot captures a PNG into outPath.
func (d *IOSSimDriver) Screenshot(ctx context.Context, udid, outPath string) error {
	if _, err := runCtx(ctx, "xcrun", "simctl", "io", udid, "screenshot", outPath); err != nil {
		return fmt.Errorf("simctl screenshot: %w", err)
	}
	return nil
}

// Shutdown stops the simulator. Best-effort.
func (d *IOSSimDriver) Shutdown(ctx context.Context, udid string) error {
	_, _ = runCtx(ctx, "xcrun", "simctl", "shutdown", udid)
	return nil
}

// pickSimulator returns the UDID of the best available simulator matching
// `deviceType` (substring). With no requested type it prefers already-booted
// devices, then iPhone/iPad, then any available Apple simulator. That keeps
// headless Mac builders usable even when only visionOS/watch/tv runtimes are
// installed.
// RankSimulators returns every available simulator UDID matching deviceType,
// best fit first. Callers that need exclusivity walk the list; callers that just
// want "a" simulator take element 0.
//
// JSON, not the text listing: the text lines carry only the DISPLAY NAME, and a
// simulator the user renamed ("wrtc-test") stops matching "iPhone" even though
// its device TYPE is an iPhone. On a real Mac mini that made the WebRTC lane
// report `no available simulator matching "iPhone"` with a healthy iPhone-type
// simulator booted on iOS 26.4. The JSON carries deviceTypeIdentifier
// ("com.apple.CoreSimulator.SimDeviceType.iPhone-15"), which names the truth
// regardless of what anyone called the device.
func RankSimulators(ctx context.Context, deviceType string) ([]string, error) {
	out, err := runCtx(ctx, "xcrun", "simctl", "list", "devices", "available", "--json")
	if err != nil {
		return nil, fmt.Errorf("simctl list devices: %w", err)
	}
	ranked := RankSimulatorsFromJSON(out, deviceType)
	if len(ranked) == 0 {
		return nil, fmt.Errorf("no available simulator matching %q (checked device TYPES, not just names)", deviceType)
	}
	return ranked, nil
}

// RankSimulatorsFromJSON ranks devices from `simctl list devices --json` output:
// booted first, then by how specifically they match deviceType (type identifier
// or display name, case-insensitive).
func RankSimulatorsFromJSON(jsonOut, deviceType string) []string {
	var listing struct {
		Devices map[string][]struct {
			Name                 string `json:"name"`
			UDID                 string `json:"udid"`
			State                string `json:"state"`
			IsAvailable          bool   `json:"isAvailable"`
			DeviceTypeIdentifier string `json:"deviceTypeIdentifier"`
		} `json:"devices"`
	}
	if err := json.Unmarshal([]byte(jsonOut), &listing); err != nil {
		return nil
	}
	want := strings.ToLower(strings.TrimSpace(deviceType))
	type candidate struct {
		udid  string
		score int
	}
	var found []candidate
	for runtimeID, devices := range listing.Devices {
		for _, d := range devices {
			if !d.IsAvailable || d.UDID == "" {
				continue
			}
			typeID := strings.ToLower(d.DeviceTypeIdentifier)
			name := strings.ToLower(d.Name)
			if want != "" && !strings.Contains(typeID, strings.ReplaceAll(want, " ", "-")) &&
				!strings.Contains(typeID, want) && !strings.Contains(name, want) {
				continue
			}
			score := 10
			// Prefer phone-class runtimes when nothing was asked for.
			lower := strings.ToLower(runtimeID) + " " + typeID
			switch {
			case strings.Contains(lower, "iphone"):
				score = 40
			case strings.Contains(lower, "ipad"):
				score = 35
			case strings.Contains(lower, "vision"), strings.Contains(lower, "xros"):
				score = 30
			case strings.Contains(lower, "tv"):
				score = 20
			case strings.Contains(lower, "watch"):
				score = 15
			}
			if strings.EqualFold(d.State, "Booted") {
				score += 100 // warm — seconds instead of a cold boot
			}
			found = append(found, candidate{udid: d.UDID, score: score})
		}
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].score > found[j].score })
	out := make([]string, 0, len(found))
	for _, c := range found {
		out = append(out, c.udid)
	}
	return out
}

func pickSimulator(ctx context.Context, deviceType string) (string, error) {
	ranked, err := RankSimulators(ctx, deviceType)
	if err != nil {
		return "", err
	}
	return ranked[0], nil
}

// CreateSimulatorForType creates a simulator instance for an installed Apple
// runtime when the device type exists but no device instance has been created
// yet. This is the iPad dogfood failure mode: Xcode had many iPad device TYPES
// installed, but `simctl list devices` had zero iPad DEVICES, so the product
// reported "tablet unavailable" even though the operation had a deterministic,
// local fix.
func CreateSimulatorForType(ctx context.Context, deviceType string) (string, error) {
	if strings.TrimSpace(deviceType) == "" {
		return "", fmt.Errorf("device type is empty")
	}
	spec, err := simulatorCreatableSpec(ctx, deviceType)
	if err != nil {
		return "", err
	}
	name := "Yaver " + strings.TrimSpace(deviceType)
	out, err := runCtx(ctx, "xcrun", "simctl", "create", name, spec.DeviceTypeID, spec.RuntimeID)
	if err != nil {
		return "", fmt.Errorf("simctl create %s: %w%s", name, err, commandOutputSuffix(out))
	}
	udid := strings.TrimSpace(out)
	if udid == "" {
		return "", fmt.Errorf("simctl create returned an empty UDID")
	}
	return udid, nil
}

func SimulatorTypeCreatable(ctx context.Context, deviceType string) (bool, string) {
	if _, err := simulatorCreatableSpec(ctx, deviceType); err != nil {
		return false, err.Error()
	}
	return true, ""
}

type simulatorCreateSpec struct {
	DeviceTypeID string
	RuntimeID    string
}

func simulatorCreatableSpec(ctx context.Context, deviceType string) (simulatorCreateSpec, error) {
	if strings.TrimSpace(deviceType) == "" {
		return simulatorCreateSpec{}, fmt.Errorf("device type is empty")
	}
	typeOut, err := runCtx(ctx, "xcrun", "simctl", "list", "devicetypes", "--json")
	if err != nil {
		return simulatorCreateSpec{}, fmt.Errorf("simctl list devicetypes: %w", err)
	}
	runtimeOut, err := runCtx(ctx, "xcrun", "simctl", "list", "runtimes", "--json")
	if err != nil {
		return simulatorCreateSpec{}, fmt.Errorf("simctl list runtimes: %w", err)
	}
	spec, ok := simulatorCreateSpecFromJSON(typeOut, runtimeOut, deviceType)
	if !ok {
		return simulatorCreateSpec{}, fmt.Errorf("no installed runtime/device type can create %q", deviceType)
	}
	return spec, nil
}

func simulatorCreateSpecFromJSON(deviceTypesJSON, runtimesJSON, deviceType string) (simulatorCreateSpec, bool) {
	want := strings.ToLower(strings.TrimSpace(deviceType))
	if want == "" {
		return simulatorCreateSpec{}, false
	}
	var types struct {
		DeviceTypes []struct {
			Name       string `json:"name"`
			Identifier string `json:"identifier"`
		} `json:"devicetypes"`
	}
	if err := json.Unmarshal([]byte(deviceTypesJSON), &types); err != nil {
		return simulatorCreateSpec{}, false
	}
	var runtimes struct {
		Runtimes []struct {
			Name        string `json:"name"`
			Identifier  string `json:"identifier"`
			IsAvailable bool   `json:"isAvailable"`
		} `json:"runtimes"`
	}
	if err := json.Unmarshal([]byte(runtimesJSON), &runtimes); err != nil {
		return simulatorCreateSpec{}, false
	}
	typeID := ""
	typeFamily := ""
	for _, dt := range types.DeviceTypes {
		name := strings.ToLower(dt.Name)
		id := strings.ToLower(dt.Identifier)
		if !appleSimulatorTypeMatches(name, id, want) {
			continue
		}
		if typeID != "" && strings.Contains(name+" "+id, "16gb") {
			continue
		}
		typeID = dt.Identifier
		typeFamily = appleRuntimeFamilyForDeviceType(name + " " + id)
		if !strings.Contains(name+" "+id, "16gb") {
			break
		}
	}
	if typeID == "" || typeFamily == "" {
		return simulatorCreateSpec{}, false
	}
	runtimeID := ""
	for _, rt := range runtimes.Runtimes {
		if !rt.IsAvailable || rt.Identifier == "" {
			continue
		}
		if appleRuntimeFamilyForDeviceType(strings.ToLower(rt.Name)+" "+strings.ToLower(rt.Identifier)) == typeFamily {
			runtimeID = rt.Identifier
		}
	}
	if runtimeID == "" {
		return simulatorCreateSpec{}, false
	}
	return simulatorCreateSpec{DeviceTypeID: typeID, RuntimeID: runtimeID}, true
}

func commandOutputSuffix(out string) string {
	out = strings.TrimSpace(out)
	if out == "" {
		return ""
	}
	if len(out) > 500 {
		out = out[len(out)-500:]
	}
	return ": " + out
}

func appleSimulatorTypeMatches(name, id, want string) bool {
	wantDashed := strings.ReplaceAll(want, " ", "-")
	return strings.Contains(id, wantDashed) || strings.Contains(id, want) || strings.Contains(name, want)
}

func appleRuntimeFamilyForDeviceType(s string) string {
	switch {
	case strings.Contains(s, "iphone"), strings.Contains(s, "ipad"), strings.Contains(s, "ios"):
		return "ios"
	case strings.Contains(s, "apple-tv"), strings.Contains(s, "appletv"), strings.Contains(s, "tvos"):
		return "tvos"
	case strings.Contains(s, "apple-watch"), strings.Contains(s, "watchos"):
		return "watchos"
	case strings.Contains(s, "apple-vision"), strings.Contains(s, "visionos"), strings.Contains(s, "xros"):
		return "visionos"
	default:
		return ""
	}
}

// pickSimulatorFromList returns the single best candidate (compatibility
// wrapper — one ranking implementation, not two).
func pickSimulatorFromList(out, deviceType string) (string, bool) {
	ranked := rankSimulatorsFromList(out, deviceType)
	if len(ranked) == 0 {
		return "", false
	}
	return ranked[0], true
}

// rankSimulatorsFromList returns every matching simulator UDID, best fit first.
//
// A ranked LIST (rather than one winner) is what makes exclusive assignment
// possible: an already-booted simulator scores +100 because reusing it is fast,
// but if another session already holds it the caller must be able to fall to the
// next candidate. When only a winner was returned, every session on the machine
// picked the same booted device — two people vibing two projects drove one
// simulator, the second install replacing the first's app, with nothing said.
func rankSimulatorsFromList(out, deviceType string) []string {
	type candidate struct {
		udid  string
		score int
	}
	want := strings.ToLower(strings.TrimSpace(deviceType))
	var found []candidate
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		lower := strings.ToLower(line)
		if want != "" && !strings.Contains(lower, want) {
			continue
		}
		// Find the first "(<UUID>)" segment.
		open := strings.Index(line, "(")
		closeIdx := strings.Index(line, ")")
		if open < 0 || closeIdx <= open {
			continue
		}
		udid := strings.TrimSpace(line[open+1 : closeIdx])
		if udid == "" || strings.Contains(udid, " ") || seen[udid] {
			continue
		}
		// Unavailable devices can't be booted at all — never rank them.
		if strings.Contains(lower, "(unavailable") {
			continue
		}
		seen[udid] = true
		score := 10
		switch {
		case strings.Contains(lower, "iphone"):
			score = 40
		case strings.Contains(lower, "ipad"):
			score = 35
		case strings.Contains(lower, "apple vision"):
			score = 30
		case strings.Contains(lower, "apple tv"):
			score = 20
		case strings.Contains(lower, "apple watch"):
			score = 15
		}
		if strings.Contains(lower, "(booted)") {
			score += 100 // already warm — seconds instead of a cold boot
		}
		found = append(found, candidate{udid: udid, score: score})
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].score > found[j].score })
	udids := make([]string, 0, len(found))
	for _, c := range found {
		udids = append(udids, c.udid)
	}
	return udids
}

// runCtx is a tiny wrapper that returns combined output + error.
func runCtx(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, resolveTestkitCommandPath(name), args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// SendText pushes text into the currently focused field via simctl's
// io keyboard endpoint (available on Xcode 14+). Used by the runner
// for `target: ios-sim` fill steps.
func (d *IOSSimDriver) SendText(ctx context.Context, udid, text string) error {
	// `xcrun simctl io <udid> keyboard text "..."` is the canonical
	// no-WDA way to type into the active app. Falls back to AppleScript
	// keystroke injection on older Xcode.
	if _, err := runCtx(ctx, "xcrun", "simctl", "io", udid, "keyboard", "text", text); err == nil {
		return nil
	}
	// Best-effort AppleScript fallback. Solo dev rarely runs this on
	// older Xcode but the path exists.
	script := fmt.Sprintf(`tell application "System Events" to keystroke %q`, text)
	_, err := runCtx(ctx, "osascript", "-e", script)
	return err
}

// Tap dispatches a tap at (x, y) on the booted simulator via
// `xcrun simctl io ... tap` (Xcode 15+) with an AppleScript fallback.
func (d *IOSSimDriver) Tap(ctx context.Context, udid string, x, y int) error {
	// `simctl io … tap` does not exist on modern Xcode (there is no simctl tap
	// verb), so this always fell through to the error and iOS-sim finger taps
	// never worked. idb (facebook/idb, MIT) is the working HID-injection path:
	// `idb ui tap --udid <udid> <x> <y>` synthesises a real touch the guest app
	// receives. Prefer it; keep the legacy simctl attempt only as a courtesy for
	// any Xcode that ever adds the verb.
	if _, err := runCtx(ctx, "idb", "ui", "tap", "--udid", udid, fmt.Sprintf("%d", x), fmt.Sprintf("%d", y)); err == nil {
		return nil
	}
	if _, err := runCtx(ctx, "xcrun", "simctl", "io", udid, "tap", fmt.Sprintf("%d", x), fmt.Sprintf("%d", y)); err == nil {
		return nil
	}
	return fmt.Errorf("iOS simulator tap needs idb — install it (brew install idb-companion && pip install fb-idb) so finger taps reach the guest app")
}

// Swipe drags from (x1,y1) to (x2,y2) over durationMs via idb — the gesture path
// for scroll/pinch building blocks. Same idb dependency as Tap.
func (d *IOSSimDriver) Swipe(ctx context.Context, udid string, x1, y1, x2, y2, durationMs int) error {
	dur := fmt.Sprintf("%.2f", float64(durationMs)/1000.0)
	if _, err := runCtx(ctx, "idb", "ui", "swipe", "--udid", udid,
		fmt.Sprintf("%d", x1), fmt.Sprintf("%d", y1), fmt.Sprintf("%d", x2), fmt.Sprintf("%d", y2), "--duration", dur); err == nil {
		return nil
	}
	return fmt.Errorf("iOS simulator swipe needs idb (brew install idb-companion && pip install fb-idb)")
}

// ParseInstalledRuntimeFamilies parses `xcrun simctl list runtimes` output and
// returns the set of installed simulator runtime families ("iOS", "watchOS",
// "tvOS", "visionOS"). Lines marked `(unavailable...)` are ignored so callers
// only see runtimes Xcode can actually boot.
//
// Pure — no I/O, safe to unit-test with a captured fixture. Callers that need
// the live host state go through InstalledRuntimeFamilies below.
func ParseInstalledRuntimeFamilies(simctlRuntimesOutput string) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(simctlRuntimesOutput, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.Contains(line, "(unavailable") {
			continue
		}
		// Runtime lines look like `iOS 26.4 (26.4 - 24E246) - com.apple...SimRuntime.iOS-26-4`.
		// We only care about the family prefix (word before the version).
		lower := strings.ToLower(line)
		switch {
		case strings.HasPrefix(lower, "ios "):
			out["iOS"] = true
		case strings.HasPrefix(lower, "watchos "):
			out["watchOS"] = true
		case strings.HasPrefix(lower, "tvos "):
			out["tvOS"] = true
		case strings.HasPrefix(lower, "visionos "), strings.HasPrefix(lower, "xros "):
			// Xcode historically labelled visionOS runtimes `xrOS`; accept both.
			out["visionOS"] = true
		}
	}
	return out
}

// InstalledRuntimeFamilies shells to `xcrun simctl list runtimes` and returns
// the set of installed simulator families. macOS + xcrun only; returns an
// empty map + no error on non-darwin hosts (the caller then treats every
// per-runtime target as `Enabled:false` with the usual macOS-host reason).
func InstalledRuntimeFamilies(ctx context.Context) (map[string]bool, error) {
	if runtime.GOOS != "darwin" {
		return map[string]bool{}, nil
	}
	if _, err := exec.LookPath("xcrun"); err != nil {
		return map[string]bool{}, nil
	}
	out, err := runCtx(ctx, "xcrun", "simctl", "list", "runtimes")
	if err != nil {
		return map[string]bool{}, fmt.Errorf("simctl list runtimes: %w", err)
	}
	return ParseInstalledRuntimeFamilies(out), nil
}

// FullBootSequence is the convenience helper: boot → install → launch
// → screenshot → shutdown. Used by `yaver test run` for `target: ios-sim`
// specs (returned in M5 scaffold). We expose it now so the user can
// already smoke-test "does my build boot at all?" without writing a
// full spec.
func (d *IOSSimDriver) FullBootSequence(ctx context.Context, screenshotPath string) (string, error) {
	udid, err := d.Boot(ctx)
	if err != nil {
		return "", err
	}
	// Boot is async — wait until the device is in "Booted" state.
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		out, _ := runCtx(ctx, "xcrun", "simctl", "list", "devices", "booted")
		if strings.Contains(out, udid) {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if d.AppPath != "" {
		if err := d.Install(ctx, udid); err != nil {
			return udid, err
		}
	}
	if d.BundleID != "" {
		if err := d.Launch(ctx, udid); err != nil {
			return udid, err
		}
	}
	if screenshotPath != "" {
		if err := d.Screenshot(ctx, udid, screenshotPath); err != nil {
			return udid, err
		}
	}
	return udid, nil
}
