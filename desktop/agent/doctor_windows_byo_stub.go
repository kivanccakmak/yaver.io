//go:build !windows

package main

import "context"

func windowsBYOPlatformChecks(context.Context, WindowsBYODoctorOptions) []WindowsBYOCheck {
	return []WindowsBYOCheck{
		windowsBYOCheck("platform.windows", windowsBYOFail, "WINDOWS_REQUIRED", true, "this doctor must run on the native Windows agent", "Copy/install the signed Windows build and run the probe there."),
	}
}

func windowsBYOLiveChecks(context.Context) []WindowsBYOCheck {
	return []WindowsBYOCheck{
		windowsBYOCheck("desktop.capture-operation", windowsBYOFail, "WINDOWS_REQUIRED", true, "gdigrab is only available on Windows", "Run the live probe on the Windows beta laptop."),
	}
}
