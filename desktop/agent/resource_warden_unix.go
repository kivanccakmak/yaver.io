//go:build !windows

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

// reapZombieChildren calls wait4(-1, WNOHANG) until the kernel has no more
// exited children to report, freeing the process-table slots held by every
// leaked Start()-without-Wait() child in one sweep. Only invoked by the
// resource warden under confirmed fork exhaustion — it can steal exit
// statuses from live exec.Cmd.Wait() calls (they see ECHILD), which is an
// acceptable trade only when the box is already refusing to spawn.
func reapZombieChildren() int {
	reaped := 0
	for {
		var ws unix.WaitStatus
		pid, err := unix.Wait4(-1, &ws, unix.WNOHANG, nil)
		if err != nil || pid <= 0 {
			return reaped
		}
		reaped++
		if reaped > 10000 { // defensive bound; a table can't hold more anyway
			return reaped
		}
	}
}

// countOpenFDs counts this process's open descriptors without forking:
// /proc/self/fd on Linux, /dev/fd on macOS. Best-effort — 0 means unknown.
func countOpenFDs() int {
	for _, dir := range []string{"/proc/self/fd", "/dev/fd"} {
		if entries, err := os.ReadDir(dir); err == nil {
			return len(entries)
		}
	}
	return 0
}
