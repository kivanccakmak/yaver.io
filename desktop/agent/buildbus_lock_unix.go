//go:build !windows

package main

// buildbus_lock_unix.go — flock(2) backend for the build-bus lease.
// buildbus.go uses it to take a NON-BLOCKING exclusive lock on a
// per-key lock file so two agent processes can't run the same build
// stage at once.
//
// The 2026-08-10 incident: buildbus.go called unix.Flock directly,
// so the Windows cross-compile (`GOOS=windows go build`) failed with
// `undefined: unix.Flock` — the CLI release build died on the 5th of
// 5 targets. The vault lock already solves this with build tags; the
// build bus gets the same split.

import (
	"os"

	"golang.org/x/sys/unix"
)

// openBusFlock opens the lock file and tries a NON-BLOCKING exclusive
// flock. Returns (file, held=true) when another process owns it —
// caller must Close the returned file in every path.
func openBusFlock(path string) (*os.File, bool, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, false, err
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		if err == unix.EWOULDBLOCK || err == unix.EAGAIN {
			return nil, true, nil
		}
		return nil, false, err
	}
	return f, false, nil
}

// closeBusFlock releases the flock and closes the handle.
func closeBusFlock(f *os.File) {
	if f == nil {
		return
	}
	_ = unix.Flock(int(f.Fd()), unix.LOCK_UN)
	_ = f.Close()
}
