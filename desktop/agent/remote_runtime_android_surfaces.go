package main

// remote_runtime_android_surfaces.go — P6 Android surface targets.
//
// Wear OS, Android TV, Android XR, and Android Auto emulators all
// speak adb + expose the same runtimeTarget contract as
// androidEmulatorTarget — the difference is which AVD you boot. We
// wrap `androidTarget` (same tap/screenshot/dims) and only override
// Attach to hint the AVD name to the driver. Callers get four new
// picker entries; each shows as its own Surface (watch/tv/vision/car)
// so the n2n picker can address them independently. The Wear-OS
// crown / TV D-pad remap already lives in `androidKeycodeForName`.

import (
	"context"
	"fmt"
	"runtime"
	"strings"

	"github.com/yaver-io/agent/testkit"
)

// androidSurfaceTarget is an AVD-hinted variant of androidEmulatorTarget.
// The `avdHint` is a substring the driver's `pickEmulator` step matches
// against `emulator -list-avds`. Empty means "first AVD" (i.e. legacy
// behaviour) — the Enabled flag is what matters at the picker level.
type androidSurfaceTarget struct {
	androidTarget
	avdHint string
}

func (t androidSurfaceTarget) Attach(ctx context.Context) (string, error) {
	// The current AndroidEmuDriver.Boot uses the first online emulator
	// if one exists, otherwise the first AVD. We pass the hint as the
	// AVD name — the driver treats it as an exact match. If no AVD
	// matches, the driver's own error message surfaces
	// (`no AVDs configured …`) which is the right user-facing text.
	return (&testkit.AndroidEmuDriver{AVD: t.avdHint}).Boot(ctx)
}

func androidTargetDisplay(surface string) (string, *RemoteRuntimeViewport) {
	switch surface {
	case "phone":
		return "Android phone emulator", &RemoteRuntimeViewport{Label: "Android Phone", Width: 393, Height: 852}
	case "watch":
		return "Wear OS emulator", &RemoteRuntimeViewport{Label: "Wear OS", Width: 390, Height: 390}
	case "tv":
		return "Android TV emulator", &RemoteRuntimeViewport{Label: "TV", Width: 1920, Height: 1080}
	case "vision":
		return "Android XR emulator", &RemoteRuntimeViewport{Label: "XR", Width: 1440, Height: 1440}
	case "car":
		return "Android Auto emulator", &RemoteRuntimeViewport{Label: "Car", Width: 1280, Height: 720}
	default:
		return "", nil
	}
}

func androidRuntimeChecks(adbOK, emulatorOK bool, avdName string, avdOK bool, avdReason string) []RemoteRuntimeCheck {
	avdLabel := "Bootable Android AVD"
	if name := strings.TrimSpace(avdName); name != "" {
		avdLabel = fmt.Sprintf("AVD %s", name)
	}
	return []RemoteRuntimeCheck{
		{ID: "android-adb", Label: "adb", OK: adbOK, Reason: func() string {
			if adbOK {
				return ""
			}
			return "adb not found. Install Android platform-tools."
		}()},
		{ID: "android-emulator", Label: "Android emulator", OK: emulatorOK, Reason: func() string {
			if emulatorOK {
				return ""
			}
			return "Android emulator binary not found."
		}()},
		{ID: "android-avd", Label: avdLabel, OK: avdOK, Reason: avdReason},
	}
}

// probeAndroidSurfaceTarget mirrors probeAndroidEmulatorTarget but
// stamps a Surface badge + friendly label for the specific surface.
// Enablement is identical (adb + emulator on PATH).
func probeAndroidSurfaceTarget(id, surface, label, avdName string) RemoteRuntimeTarget {
	display, viewport := androidTargetDisplay(surface)
	target := RemoteRuntimeTarget{
		ID:               id,
		Label:            label,
		Surface:          surface,
		Platform:         "android",
		RuntimeHostClass: runtimeHostClassForAndroid(),
		HostOS:           runtime.GOOS,
		RequiredCLI:      "adb + emulator",
		DisplaySurface:   display,
		Viewport:         viewport,
	}
	if findAndroidToolPath("adb") == "" {
		target.Enabled = false
		target.Reason = "adb not found. Install Android platform-tools."
		target.Checks = androidRuntimeChecks(false, false, avdName, false, "Not probed because adb is missing.")
		return target
	}
	if findAndroidToolPath("emulator") == "" {
		target.Enabled = false
		if !androidEmulatorHostSupported() {
			target.Reason = fmt.Sprintf(
				"Google ships no Android emulator binary for %s/%s. Stream from a physical %s device (`yaver wire`) or a macOS / x86-64-Linux host.",
				runtime.GOOS, runtime.GOARCH, strings.ToLower(surface))
		} else {
			target.Reason = "Android emulator binary not found. Run `yaver install remote-runtime`."
		}
		target.Checks = androidRuntimeChecks(true, false, avdName, false, "Not probed because the emulator binary is missing.")
		return target
	}
	if ok, reason := testkit.AndroidAVDUsable(avdName); !ok {
		target.Enabled = false
		target.Reason = reason
		target.Checks = androidRuntimeChecks(true, true, avdName, false, reason)
		return target
	}
	target.Enabled = true
	target.Checks = androidRuntimeChecks(true, true, avdName, true, "")
	return target
}

func probeAndroidWearTarget() RemoteRuntimeTarget {
	return probeAndroidSurfaceTarget("android-wear", "watch", "Wear OS Emulator over WebRTC", "wear")
}
func probeAndroidTVTarget() RemoteRuntimeTarget {
	return probeAndroidSurfaceTarget("android-tv", "tv", "Android TV Emulator over WebRTC", "tv")
}
func probeAndroidXRTarget() RemoteRuntimeTarget {
	return probeAndroidSurfaceTarget("android-xr", "vision", "Android XR Emulator over WebRTC", "xr")
}
func probeAndroidAutoTarget() RemoteRuntimeTarget {
	return probeAndroidSurfaceTarget("android-auto", "car", "Android Auto Emulator over WebRTC", "auto")
}
