package main

// vibe_sessions_test.go — owner workload resource attribution and exclusive
// device assignment.
//
// What these pin down, in order of how much damage the alternative does:
//
//   1. Two sessions never get the same simulator. That was the live defect —
//      every session picked the same booted device and silently fought over it.
//   2. Reports join the ports and devices belonging to one owner workload.

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

const testOwner = "user_owner"

func newTestRegistry(t *testing.T) (*VibeSessionRegistry, *time.Time) {
	t.Helper()
	clock := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	r := NewVibeSessionRegistry(testOwner)
	r.now = func() time.Time { return clock }
	return r, &clock
}

func TestSessionReportsOnlyProjectBasename(t *testing.T) {
	r, _ := newTestRegistry(t)
	sess := r.EnsureSession(testOwner, "/Users/x/Workspace/e-mobile", "flutter")

	if sess.Project != "e-mobile" {
		t.Errorf("project should be the basename (an absolute path leaks the box's username), got %q", sess.Project)
	}
}

func TestSameProjectReusesOneSessionTwoProjectsStaySeparate(t *testing.T) {
	r, _ := newTestRegistry(t)
	a := r.EnsureSession(testOwner, "/w/e-mobile", "flutter")
	again := r.EnsureSession(testOwner, "/w/e-mobile", "flutter")
	b := r.EnsureSession(testOwner, "/w/todo-rn", "expo")

	if a.ID != again.ID {
		t.Error("the same project got separate sessions — its resources could collide")
	}
	if a.ID == b.ID {
		t.Error("two different projects share one session — their exclusive resources would collide by construction")
	}
}

// ─── exclusive devices (the live defect) ─────────────────────────────────────

func TestTwoSessionsNeverGetTheSameSimulator(t *testing.T) {
	ranked := []string{"UDID-BOOTED-iphone15", "UDID-COLD-iphone15", "UDID-COLD-ipad"}

	first, release1, err := AcquireRuntimeDevice("ios-simulator", "sess:vs_a", ranked)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer release1()
	if first != ranked[0] {
		t.Errorf("first session should get the warm (booted) device %q, got %q", ranked[0], first)
	}

	second, release2, err := AcquireRuntimeDevice("ios-simulator", "sess:vs_b", ranked)
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	defer release2()
	if second == first {
		t.Fatal("two sessions were handed the SAME simulator — the second install replaces the first's app, both video streams show one screen, and taps cross over")
	}
}

func TestExhaustedDevicesNameWhoHoldsThem(t *testing.T) {
	ranked := []string{"UDID-only-one"}
	_, release, err := AcquireRuntimeDevice("ios-simulator", "sess:vs_holder", ranked)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer release()

	_, _, err = AcquireRuntimeDevice("ios-simulator", "sess:vs_second", ranked)
	if err == nil {
		t.Fatal("a claimed device was handed out twice")
	}
	if !strings.Contains(err.Error(), "vs_holder") {
		t.Errorf("error does not name the holder, so the user cannot act on it: %v", err)
	}
}

func TestDeviceReleaseReturnsItToThePool(t *testing.T) {
	ranked := []string{"UDID-recycle"}
	_, release, err := AcquireRuntimeDevice("android-emulator", "sess:vs_a", ranked)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	release()
	release() // idempotent

	got, release2, err := AcquireRuntimeDevice("android-emulator", "sess:vs_b", ranked)
	if err != nil {
		t.Fatalf("after release the device should be free again: %v", err)
	}
	defer release2()
	if got != "UDID-recycle" {
		t.Errorf("unexpected device %q", got)
	}
}

func TestSessionReportJoinsPortsAndDevices(t *testing.T) {
	r, _ := newTestRegistry(t)
	sess := r.EnsureSession(testOwner, "/w/e-mobile", "flutter")
	owner := vibeOwnerTag(sess.ID)

	port := unusedPort(t)
	gotPort, _, releasePort := AcquireDevPort("flutter", owner, port)
	defer releasePort()
	_, releaseDev, err := AcquireRuntimeDevice("ios-simulator", owner, []string{"UDID-report"})
	if err != nil {
		t.Fatalf("device acquire: %v", err)
	}
	defer releaseDev()

	var found *VibeSessionView
	for _, s := range r.Sessions() {
		if s.ID == sess.ID {
			ss := s
			found = &ss
		}
	}
	if found == nil {
		t.Fatal("session missing from the report")
	}
	var sawPort, sawDevice bool
	for _, res := range found.Resources {
		switch res.Type {
		case "port":
			sawPort = true
			if res.Value != strconv.Itoa(gotPort) {
				t.Errorf("port resource has value %q, want %d", res.Value, gotPort)
			}
		case "device":
			sawDevice = true
		}
	}
	if !sawPort || !sawDevice {
		t.Errorf("the session report must show BOTH the port and the device it holds "+
			"(port=%v device=%v) — two lists that can disagree is how the UI ends up lying", sawPort, sawDevice)
	}
}

// (string helpers come from the standard library — `strings.Contains` /
// `strconv.Itoa`. Hand-rolled copies were the first draft's mistake.)
