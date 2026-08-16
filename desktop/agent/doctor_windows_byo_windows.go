//go:build windows

package main

import (
	"context"
	"fmt"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func windowsBYOPlatformChecks(ctx context.Context, _ WindowsBYODoctorOptions) []WindowsBYOCheck {
	checks := []WindowsBYOCheck{windowsBYOCheck("platform.windows", windowsBYOPass, "NATIVE_WINDOWS_AGENT", true, "native "+runtime.GOOS+"/"+runtime.GOARCH, "")}
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		checks = append(checks, windowsBYOCheck("platform.architecture", windowsBYOFail, "WINDOWS_ARCH_UNSUPPORTED", true, runtime.GOARCH, "Install an amd64 or arm64 Yaver build matching the laptop."))
	} else {
		checks = append(checks, windowsBYOCheck("platform.architecture", windowsBYOPass, "WINDOWS_ARCH_MATCHED", true, runtime.GOARCH, ""))
	}
	checks = append(checks, windowsBYOCheck("runner.native-seat", windowsBYOPass, "NATIVE_CONPTY_SEAT_AVAILABLE", true, "in-process named ConPTY seats are compiled into this agent", ""))

	ps := DiscoverBinary("powershell")
	if ps == "" {
		ps = DiscoverBinary("powershell.exe")
	}
	if ps == "" {
		checks = append(checks, windowsBYOCheck("session.interactive", windowsBYOFail, "POWERSHELL_MISSING", true, "PowerShell was not discovered", "Restore Windows PowerShell so session and Office probes can run."))
		return checks
	}
	sessionScript := `$e=@(Get-Process explorer -ErrorAction SilentlyContinue).Count; $l=@(Get-Process LogonUI -ErrorAction SilentlyContinue).Count; if($e -eq 0){'NO_EXPLORER'}elseif($l -gt 0){'LOCKED'}else{'ACTIVE'}`
	session, sessionErr := runWindowsBYOCommand(ctx, 5*time.Second, ps, "-NoProfile", "-NonInteractive", "-Command", sessionScript)
	switch strings.TrimSpace(session) {
	case "ACTIVE":
		checks = append(checks, windowsBYOCheck("session.interactive", windowsBYOPass, "INTERACTIVE_SESSION_ACTIVE", true, "Explorer is running and LogonUI is absent", ""))
	case "LOCKED":
		checks = append(checks, windowsBYOCheck("session.interactive", windowsBYOFail, "SESSION_LOCKED", true, "Windows lock screen is active", "Unlock the physical Windows session before capture/control testing."))
	case "NO_EXPLORER":
		checks = append(checks, windowsBYOCheck("session.interactive", windowsBYOFail, "NO_INTERACTIVE_EXPLORER", true, "no Explorer process is running", "Sign in interactively; do not run the friend beta as a headless service session."))
	default:
		detail := strings.TrimSpace(session)
		if detail == "" && sessionErr != nil {
			detail = sessionErr.Error()
		}
		checks = append(checks, windowsBYOCheck("session.interactive", windowsBYOFail, "SESSION_STATE_UNPROVEN", true, detail, "Run the agent inside the signed-in user's interactive session."))
	}

	powercfg := DiscoverBinary("powercfg")
	if powercfg == "" {
		checks = append(checks, windowsBYOCheck("power.ac-sleep", windowsBYOFail, "POWERCFG_MISSING", true, "powercfg was not discovered", "Restore the Windows powercfg utility."))
	} else {
		power, powerErr := runWindowsBYOCommand(ctx, 5*time.Second, powercfg, "/query", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE")
		hex := extractWindowsPowerHexValues(power)
		if powerErr != nil || len(hex) < 2 {
			checks = append(checks, windowsBYOCheck("power.ac-sleep", windowsBYOFail, "AC_SLEEP_POLICY_UNPROVEN", true, firstLineRaw(power), "Set AC sleep to Never for tomorrow's unattended test, then rerun."))
		} else if hex[len(hex)-2] != 0 {
			checks = append(checks, windowsBYOCheck("power.ac-sleep", windowsBYOFail, "AC_SLEEP_ENABLED", true, fmt.Sprintf("AC standby timeout is %d seconds", hex[len(hex)-2]), "Set sleep-on-AC to Never during the beta window."))
		} else {
			checks = append(checks, windowsBYOCheck("power.ac-sleep", windowsBYOPass, "AC_SLEEP_DISABLED", true, "AC standby timeout is Never", ""))
		}
	}

	powerPointScript := `(Get-ItemProperty 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\POWERPNT.EXE' -ErrorAction SilentlyContinue).'(default)'`
	powerPoint, _ := runWindowsBYOCommand(ctx, 5*time.Second, ps, "-NoProfile", "-NonInteractive", "-Command", powerPointScript)
	if strings.TrimSpace(powerPoint) == "" {
		checks = append(checks, windowsBYOCheck("office.powerpoint", windowsBYOFail, "POWERPOINT_MISSING", true, "POWERPNT.EXE App Paths registration is absent", "Install/repair desktop PowerPoint and open it locally once."))
	} else {
		checks = append(checks, windowsBYOCheck("office.powerpoint", windowsBYOPass, "POWERPOINT_DISCOVERED", true, strings.TrimSpace(powerPoint), ""))
		checks = append(checks, windowsBYOCheck("office.activation", windowsBYOWarn, "OFFICE_ACTIVATION_REQUIRES_LOCAL_OPEN", false, "binary presence does not prove Microsoft account activation or dismiss first-run dialogs", "Open PowerPoint locally, confirm activation, and close all first-run/privacy dialogs before the remote test."))
	}
	webViewScript := `$p=@('Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*','Registry::HKEY_CURRENT_USER\Software\Microsoft\EdgeUpdate\Clients\*'); $n=Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object {$_.name -like '*WebView2*'} | Select-Object -First 1 -ExpandProperty pv; if($n){$n}`
	webView, _ := runWindowsBYOCommand(ctx, 5*time.Second, ps, "-NoProfile", "-NonInteractive", "-Command", webViewScript)
	if strings.TrimSpace(webView) == "" {
		checks = append(checks, windowsBYOCheck("runtime.webview2", windowsBYOFail, "WEBVIEW2_MISSING", true, "WebView2 Evergreen Runtime was not discovered", "Install or repair Microsoft Edge WebView2 Runtime."))
	} else {
		checks = append(checks, windowsBYOCheck("runtime.webview2", windowsBYOPass, "WEBVIEW2_DISCOVERED", true, strings.TrimSpace(webView), ""))
	}
	return checks
}

func extractWindowsPowerHexValues(raw string) []uint64 {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return !(r >= '0' && r <= '9') && !(r >= 'a' && r <= 'f') && !(r >= 'A' && r <= 'F') && r != 'x' && r != 'X'
	})
	var values []uint64
	for _, field := range fields {
		if len(field) < 3 || !strings.HasPrefix(strings.ToLower(field), "0x") {
			continue
		}
		if value, err := strconv.ParseUint(field[2:], 16, 64); err == nil {
			values = append(values, value)
		}
	}
	return values
}

func windowsBYOLiveChecks(ctx context.Context) []WindowsBYOCheck {
	if err := desktopViewAllowed(); err != nil {
		return []WindowsBYOCheck{windowsBYOCheck(
			"desktop.capture-operation", windowsBYOFail, "DESKTOP_VIEW_CONSENT_REQUIRED", true,
			err.Error(), "Grant screen-view consent locally on this Windows machine, then rerun the live probe.",
		)}
	}
	ffmpeg := DiscoverBinary("ffmpeg")
	if ffmpeg == "" {
		return []WindowsBYOCheck{windowsBYOCheck("desktop.capture-operation", windowsBYOFail, "FFMPEG_MISSING", true, "ffmpeg was not discovered", "Install FFmpeg with gdigrab and libx264 support.")}
	}
	frames, captureErr := runWindowsBYOCommand(ctx, 12*time.Second, ffmpeg,
		"-hide_banner", "-loglevel", "error", "-f", "gdigrab", "-framerate", "2", "-i", "desktop", "-frames:v", "2", "-f", "framemd5", "-")
	if captureErr != nil {
		return []WindowsBYOCheck{windowsBYOCheck("desktop.capture-operation", windowsBYOFail, "GDIGRAB_CAPTURE_FAILED", true, firstLineRaw(frames)+" "+captureErr.Error(), "Unlock the interactive desktop and install an FFmpeg build with gdigrab.")}
	}
	digests := windowsBYOFrameDigests(frames)
	checks := []WindowsBYOCheck{}
	if len(digests) < 2 {
		checks = append(checks, windowsBYOCheck("desktop.capture-operation", windowsBYOFail, "CAPTURE_FRAMES_MISSING", true, "FFmpeg did not return two frame digests", "Keep the desktop unlocked and rerun the live probe."))
	} else if digests[0] == digests[1] {
		checks = append(checks, windowsBYOCheck("desktop.capture-operation", windowsBYOFail, "CAPTURE_FRAME_STATIC", true, "two captured frame digests were identical", "Move the pointer or a window while rerunning so changing pixels are proven."))
	} else {
		checks = append(checks, windowsBYOCheck("desktop.capture-operation", windowsBYOPass, "GDIGRAB_CHANGING_FRAMES_PROVEN", true, "two in-memory frame digests changed; no image was persisted", ""))
	}
	encoded, encodeErr := runWindowsBYOCommand(ctx, 12*time.Second, ffmpeg,
		"-hide_banner", "-loglevel", "error", "-f", "gdigrab", "-framerate", "2", "-i", "desktop", "-frames:v", "1", "-c:v", "libx264", "-f", "null", "-")
	if encodeErr != nil {
		checks = append(checks, windowsBYOCheck("desktop.h264-operation", windowsBYOFail, "H264_ENCODE_FAILED", true, firstLineRaw(encoded)+" "+encodeErr.Error(), "Install an FFmpeg build with libx264 and rerun."))
	} else {
		checks = append(checks, windowsBYOCheck("desktop.h264-operation", windowsBYOPass, "H264_ENCODE_PROVEN", true, "one live desktop frame encoded to a null sink; no image was persisted", ""))
	}
	return checks
}

func windowsBYOFrameDigests(raw string) []string {
	var out []string
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.Split(line, ",")
		if len(parts) >= 6 {
			out = append(out, strings.TrimSpace(parts[len(parts)-1]))
		}
	}
	return out
}
