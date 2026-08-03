package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// release_announce.go — tell owned boxes a release exists.
//
// ─── The gap this closes ───────────────────────────────────────────────────
//
// `agent_update_request.go` already implements the receiving half: a surface
// writes `desiredAgentVersion` onto a device row, and the box claims it on its
// next heartbeat. That is deliberately desired-state rather than a command, so
// a box that is offline, asleep, on cellular or behind an unpunchable NAT still
// converges. tvOS, watchOS and Wear OS have no path to a box at all, so it is
// the ONLY trigger they have.
//
// And nothing in Go ever called it. Not the release script, not `deploy.sh`,
// not the CLI. The producer existed and had no consumer — the exact pattern
// CLAUDE.md names ("a signal with no consumer is not shipped").
//
// The measured cost, twice in one day (2026-08-03): the box sat on 1.99.397
// while the fix was in 1.99.399, and again on 1.99.398 while 1.99.400 shipped.
// Three manual `npm i -g yaver-cli@latest` over ssh were the real update
// mechanism. A product whose update path is "the maintainer ssh's in" does not
// have an update path.
//
// ─── Why this is not the same as the auto-update timer ─────────────────────
//
// Two different needs, and one timer cannot serve both:
//
//	fleet keeps current                    1-2h jittered   ← autoUpdateCheckInterval
//	a box under active development         seconds         ← THIS
//
// The timer is right for the first and useless for the second, which is why
// tightening it (6-12h → 1-2h) helped and did not fix anything. Announcing is
// the answer to "I just cut a fix and I need it on that box now".
//
// It still respects the receiving box's judgement: the box decides WHEN to
// apply, so an announce does not kill a running coding turn — see
// agent_update_idle.go. Announce is "there is something new", not "restart now".

// AnnounceReleaseResult is one device's outcome, so the caller can print a
// per-box line rather than a count.
type AnnounceReleaseResult struct {
	DeviceID string `json:"deviceId"`
	Name     string `json:"name,omitempty"`
	Version  string `json:"version,omitempty"`
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
}

// RequestAgentUpdateForDevice sets desiredAgentVersion on one device.
//
// version is "latest" (resolve at apply time) or a concrete release to pin.
// Note the agent currently only honours "latest" — it says so rather than
// silently installing something else — so a pin here will be reported back as
// an error by the box, not applied.
func RequestAgentUpdateForDevice(baseURL, token, deviceID, version string) error {
	if strings.TrimSpace(deviceID) == "" {
		return fmt.Errorf("deviceId is required")
	}
	if strings.TrimSpace(version) == "" {
		version = "latest"
	}
	body, err := json.Marshal(map[string]string{"deviceId": deviceID, "version": version})
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", strings.TrimRight(baseURL, "/")+"/devices/request-update", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return ErrAuthExpired
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("request-update returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// AnnounceReleaseToOwnedDevices asks every owned device to take `version`.
//
// Best-effort per device, and it returns EVERY outcome including the failures.
// A partial announce that reports only successes is how a fleet ends up with
// three boxes nobody knows are stale.
func AnnounceReleaseToOwnedDevices(baseURL, token, version string, onlyDeviceIDs []string) ([]AnnounceReleaseResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	devices, err := listDevicesForStatus(ctx, baseURL, token)
	if err != nil {
		return nil, fmt.Errorf("could not list devices: %w", err)
	}

	want := map[string]bool{}
	for _, id := range onlyDeviceIDs {
		if id = strings.TrimSpace(id); id != "" {
			want[id] = true
		}
	}

	var out []AnnounceReleaseResult
	for _, d := range devices {
		if len(want) > 0 && !want[d.DeviceID] {
			continue
		}
		// A GUEST device is somebody else's box shared with us. Setting desired
		// state on it would be updating a machine we do not own, which the
		// Convex mutation rejects anyway (userId check) — skipping it keeps the
		// release log free of guaranteed failures.
		if d.IsGuest {
			continue
		}
		// Phones and tablets carry no agent binary. Announcing to them is
		// harmless but noisy, and noise in a release log is how the one line
		// that matters gets missed.
		if isNonAgentPlatform(d.Platform) {
			continue
		}
		name := d.Alias
		if name == "" {
			name = d.Name
		}
		r := AnnounceReleaseResult{DeviceID: d.DeviceID, Name: name, Version: version}
		if err := RequestAgentUpdateForDevice(baseURL, token, d.DeviceID, version); err != nil {
			r.Error = err.Error()
		} else {
			r.OK = true
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// runAnnounceRelease implements `yaver announce-release [version] [--device id]`.
//
// Deliberately a first-class verb rather than a flag on `deploy`: the release
// and the announce are separable, and the case that hurts most is "the release
// already happened and a box is still stale", which needs to be runnable on its
// own. It is also what the release script calls, so there is ONE implementation
// rather than a script that shells out to curl.
func runAnnounceRelease(args []string) {
	version := "latest"
	var only []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--device", "-d":
			if i+1 < len(args) {
				only = append(only, args[i+1])
				i++
			}
		case "-h", "--help":
			fmt.Println("Usage: yaver announce-release [version] [--device <deviceId>]...")
			fmt.Println()
			fmt.Println("Tells owned boxes that a release exists, so they take it on their next")
			fmt.Println("heartbeat instead of waiting out the 1-2h auto-update cycle.")
			fmt.Println("The box still decides WHEN to apply it — a running coding turn is not killed.")
			fmt.Println()
			fmt.Println("  version   'latest' (default) or a concrete release. NOTE: the agent")
			fmt.Println("            currently only honours 'latest' and will report a pin as an error.")
			return
		default:
			if !strings.HasPrefix(args[i], "-") {
				version = args[i]
			}
		}
	}

	cfg, err := LoadConfig()
	if err != nil || cfg.AuthToken == "" {
		fmt.Fprintln(os.Stderr, "Not signed in. Run `yaver auth` first.")
		os.Exit(1)
	}

	results, err := AnnounceReleaseToOwnedDevices(cfg.ConvexSiteURL, cfg.AuthToken, version, only)
	if err != nil {
		fmt.Fprintf(os.Stderr, "announce failed: %v\n", err)
		os.Exit(1)
	}
	if len(results) == 0 {
		fmt.Println("No agent-running devices to announce to.")
		return
	}

	failures := 0
	for _, r := range results {
		label := r.Name
		if label == "" {
			label = r.DeviceID
		}
		if r.OK {
			fmt.Printf("  ✓ %s — will take %s on its next heartbeat\n", label, r.Version)
			continue
		}
		failures++
		fmt.Printf("  ✗ %s — %s\n", label, r.Error)
	}
	fmt.Printf("\nAnnounced %s to %d/%d device(s).\n", version, len(results)-failures, len(results))
	if failures > 0 {
		// Non-zero so a release script does not treat a half-announce as done.
		os.Exit(1)
	}
}

// isNonAgentPlatform reports platforms that never run the Go agent, so an
// announce skips them instead of logging a guaranteed no-op.
//
// Keyed on the platform string the device registered with. Unknown platforms
// are treated as agent-capable: a box we cannot classify is far more likely to
// be a new server type than a new phone, and missing a real box is the failure
// that costs something.
func isNonAgentPlatform(platform string) bool {
	switch strings.ToLower(strings.TrimSpace(platform)) {
	case "ios", "iphone", "ipad", "android", "tvos", "watchos", "wearos", "visionos", "web", "browser":
		return true
	default:
		return false
	}
}
