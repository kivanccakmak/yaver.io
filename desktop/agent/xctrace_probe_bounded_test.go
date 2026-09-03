package main

import (
	"context"
	"testing"
)

// 2026-09-03: the all-package test run reached its ten-minute timeout while
// xcrun xctrace held an output pipe open after the probe context expired. A
// context kill alone does not release pipes inherited by grandchildren.
func TestXctraceListDevicesCommandHasWaitDelay(t *testing.T) {
	cmd := xctraceListDevicesCommand(context.Background())
	if cmd.WaitDelay <= 0 {
		t.Fatal("xctrace device inventory has no WaitDelay; a grandchild can hold its output pipe and wedge capability discovery")
	}
}
