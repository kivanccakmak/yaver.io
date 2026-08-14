package main

import (
	"context"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// PreviewCapabilities deliberately reports usable runtimes, rather than tools
// merely installed somewhere on PATH. It is safe to expose to an authenticated
// owner and lets Vibing filter its target chooser to this box's real capacity.
type PreviewCapabilities struct {
	Browser       bool `json:"browser"`
	Android       bool `json:"android"`
	IOSSimulator  bool `json:"iosSimulator"`
	TVOSSimulator bool `json:"tvosSimulator"`
	XR            bool `json:"xr"`
}

func detectPreviewCapabilities() PreviewCapabilities {
	caps := PreviewCapabilities{
		Browser: hasBinary("google-chrome") || hasBinary("google-chrome-stable") || hasBinary("chromium") || hasBinary("chromium-browser"),
	}

	// An installed adb alone is not a launch target. Require one authorised
	// emulator/device so selecting Android in Vibing can actually succeed.
	caps.Android = hasAndroidTarget()
	if runtime.GOOS == "darwin" {
		ios, tvos := simulatorTargets()
		caps.IOSSimulator = ios
		caps.TVOSSimulator = tvos
	}
	// Keep XR false until an explicit, launchable XR runtime is integrated.
	// This prevents a speculative option from disappointing the user.
	return caps
}

func hasBinary(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func hasAndroidTarget() bool {
	if !hasBinary("adb") {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "adb", "devices").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == "device" {
			return true
		}
	}
	return false
}

func simulatorTargets() (ios, tvos bool) {
	if !hasBinary("xcrun") {
		return false, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "xcrun", "simctl", "list", "devices", "available").Output()
	if err != nil {
		return false, false
	}
	for _, line := range strings.Split(string(out), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "iPhone") || strings.HasPrefix(trimmed, "iPad") {
			ios = true
		}
		if strings.HasPrefix(trimmed, "Apple TV") {
			tvos = true
		}
	}
	return ios, tvos
}
