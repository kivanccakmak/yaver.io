//go:build windows

package main

// Windows has no fork/zombie semantics and no /proc; the warden still runs
// (memory + spawn probe are portable) but these two levers are no-ops.
func reapZombieChildren() int { return 0 }
func countOpenFDs() int       { return 0 }
