//go:build windows

package main

// buildbus_lock_windows.go — Windows backend for the build-bus lease.
//
// The 2026-08-10 incident: buildbus.go called unix.Flock directly, so
// `GOOS=windows go build` failed with `undefined: unix.Flock` and the
// CLI release died on the 5th of 5 targets — every platform build after
// linux/arm64 was never produced, and the release could not ship.
//
// Windows has no flock(2). The build bus's flock is a COORDINATION
// optimization (two agents must not run the same stage at once); the
// lease's real authority is the store backend row, which works on every
// platform. On Windows the flock backend degrades to "always free" —
// correctness is preserved (store still guards), only the extra
// cross-process guard is absent. That is strictly better than not
// shipping the binary.

import "os"

// openBusFlock is a Windows no-op: never held, no file left behind.
func openBusFlock(path string) (*os.File, bool, error) {
	return nil, false, nil
}

// closeBusFlock is a Windows no-op.
func closeBusFlock(f *os.File) {}
