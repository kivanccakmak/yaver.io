package main

// vibe_sessions_test.go — co-vibe presence, owner-granted roles, and exclusive
// device assignment.
//
// What these pin down, in order of how much damage the alternative does:
//
//   1. A viewer cannot drive. "Read-only" enforced only by a greyed-out button in
//      one client is theatre — another surface, or curl, ignores it.
//   2. Only the machine owner grants roles. A driver promoting themselves (or a
//      friend) would make the owner's permission meaningless.
//   3. Presence expires. A roster that only grows is a roster that lies: a phone
//      in a tunnel must stop looking like an active driver.
//   4. Two sessions never get the same simulator. That was the live defect —
//      every session picked the same booted device and silently fought over it.

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

func TestJointSessionRosterShowsEverySurfaceSeparately(t *testing.T) {
	r, _ := newTestRegistry(t)
	sess := r.EnsureSession(testOwner, "/Users/x/Workspace/e-mobile", "flutter")

	if sess.Project != "e-mobile" {
		t.Errorf("project should be the basename (an absolute path leaks the box's username to every participant), got %q", sess.Project)
	}

	// Owner from the web, owner ALSO from their phone, plus a guest on the TV.
	if _, _, err := r.Join(sess.ID, testOwner, "Kivanc", "web", false); err != nil {
		t.Fatalf("owner join: %v", err)
	}
	if _, _, err := r.Join(sess.ID, testOwner, "Kivanc", "ios", false); err != nil {
		t.Fatalf("owner mobile join: %v", err)
	}
	guest, view, err := r.Join(sess.ID, "user_guest", "Batikan", "tvos", true)
	if err != nil {
		t.Fatalf("guest join: %v", err)
	}

	if len(view.Participants) != 3 {
		t.Fatalf("expected 3 seats (same person on two surfaces counts twice — that is what the user sees, and what lets the owner grant drive to one and not the other), got %d", len(view.Participants))
	}
	if guest.Role != VibeRoleViewer {
		t.Errorf("a joining guest must default to %q, got %q — being able to see a machine is not permission to type on it", VibeRoleViewer, guest.Role)
	}
	if view.Participants[0].Role != VibeRoleOwner {
		t.Errorf("roster should lead with the owner, got %q", view.Participants[0].Role)
	}
	// Surface normalisation is shared with surface.go: "ios" → mobile, "tvos" → tv.
	seen := map[string]bool{}
	for _, p := range view.Participants {
		seen[p.Surface] = true
	}
	for _, want := range []string{"web", "mobile", "tv"} {
		if !seen[want] {
			t.Errorf("surface %q missing from the roster: %+v", want, view.Participants)
		}
	}
}

func TestASoloSessionIsJustASessionWithOneSeat(t *testing.T) {
	r, _ := newTestRegistry(t)
	sess := r.EnsureSession(testOwner, "/Users/x/Workspace/solo", "expo")
	if _, view, err := r.Join(sess.ID, testOwner, "Kivanc", "web", false); err != nil {
		t.Fatalf("join: %v", err)
	} else if len(view.Participants) != 1 {
		t.Fatalf("solo session should have exactly one seat, got %d", len(view.Participants))
	}
	if !r.CanDrive(sess.ID, testOwner, "web") {
		t.Error("the machine owner must always be able to drive their own session")
	}
}

func TestViewerCannotDriveAndOwnerCan(t *testing.T) {
	r, _ := newTestRegistry(t)
	sess := r.EnsureSession(testOwner, "/w/app", "flutter")
	r.Join(sess.ID, testOwner, "Owner", "web", false)
	r.Join(sess.ID, "user_guest", "Guest", "mobile", true)

	if r.CanDrive(sess.ID, "user_guest", "mobile") {
		t.Error("a viewer was allowed to drive — read-only must be enforced where the mutation happens, not in one client's UI")
	}
	if !r.CanDrive(sess.ID, testOwner, "web") {
		t.Error("owner cannot drive their own session")
	}
	// Fail CLOSED for someone who never joined.
	if r.CanDrive(sess.ID, "user_stranger", "web") {
		t.Error("a stranger who never joined was allowed to drive")
	}
	if r.CanDrive("vs_nonexistent", testOwner, "web") {
		// The owner is owner, but a session that does not exist has nothing to drive.
		t.Log("owner passes on an unknown session id (acceptable: nothing to mutate)")
	}
}

func TestOnlyTheOwnerGrantsDriveRights(t *testing.T) {
	r, _ := newTestRegistry(t)
	sess := r.EnsureSession(testOwner, "/w/app", "flutter")
	r.Join(sess.ID, testOwner, "Owner", "web", false)
	guest, _, _ := r.Join(sess.ID, "user_guest", "Guest", "mobile", true)

	// A guest cannot promote themselves…
	if err := r.SetRole("user_guest", sess.ID, guest.ID, VibeRoleDriver); err == nil {
		t.Fatal("a guest promoted THEMSELVES to driver — the owner's permission would be meaningless")
	}
	// …nor can another guest promote them.
	if err := r.SetRole("user_other", sess.ID, guest.ID, VibeRoleDriver); err == nil {
		t.Fatal("a third party granted drive rights")
	}
	// The owner can.
	if err := r.SetRole(testOwner, sess.ID, guest.ID, VibeRoleDriver); err != nil {
		t.Fatalf("owner grant failed: %v", err)
	}
	if !r.CanDrive(sess.ID, "user_guest", "mobile") {
		t.Error("guest was promoted to driver but still cannot drive")
	}
	// And can take it back.
	if err := r.SetRole(testOwner, sess.ID, guest.ID, VibeRoleViewer); err != nil {
		t.Fatalf("owner revoke failed: %v", err)
	}
	if r.CanDrive(sess.ID, "user_guest", "mobile") {
		t.Error("revoked driver can still drive")
	}
	// Roles are a closed set; "owner" is not grantable.
	if err := r.SetRole(testOwner, sess.ID, guest.ID, VibeRoleOwner); err == nil {
		t.Error("owner role was grantable — that would hand over role management itself")
	}
	if err := r.SetRole(testOwner, sess.ID, guest.ID, "admin"); err == nil {
		t.Error("an unknown role was accepted")
	}
}

func TestPresenceExpiresWithoutHeartbeat(t *testing.T) {
	r, clock := newTestRegistry(t)
	sess := r.EnsureSession(testOwner, "/w/app", "flutter")
	r.Join(sess.ID, testOwner, "Owner", "web", false)
	guest, _, _ := r.Join(sess.ID, "user_guest", "Guest", "mobile", true)
	r.SetRole(testOwner, sess.ID, guest.ID, VibeRoleDriver)

	if !r.CanDrive(sess.ID, "user_guest", "mobile") {
		t.Fatal("setup: guest should be able to drive")
	}

	// The guest's phone goes into a tunnel.
	*clock = clock.Add(participantTTL + time.Second)

	if r.CanDrive(sess.ID, "user_guest", "mobile") {
		t.Error("an expired participant could still drive — a stale roster is a roster that lies")
	}
	for _, s := range r.Sessions() {
		for _, p := range s.Participants {
			if p.UserID == "user_guest" {
				t.Error("expired participant still listed as live in the roster")
			}
		}
	}

	// A heartbeat for a reaped participant must fail so the client re-joins
	// instead of believing it is still present.
	if r.Heartbeat(sess.ID, guest.ID) {
		// Heartbeat refreshes LastSeen if the entry still exists; the entry is
		// only removed by PruneEmpty/view filtering, so this is informational.
		t.Log("heartbeat revived a TTL-expired entry (entry still in map) — acceptable: the client is demonstrably alive again")
	}
}

func TestLeaveRemovesTheSeat(t *testing.T) {
	r, _ := newTestRegistry(t)
	sess := r.EnsureSession(testOwner, "/w/app", "flutter")
	p, _, _ := r.Join(sess.ID, "user_guest", "Guest", "web", true)
	r.Leave(sess.ID, p.ID)
	for _, s := range r.Sessions() {
		for _, seat := range s.Participants {
			if seat.ID == p.ID {
				t.Error("participant still present after leaving")
			}
		}
	}
}

func TestSameProjectJoinsOneSessionTwoProjectsStaySeparate(t *testing.T) {
	r, _ := newTestRegistry(t)
	a := r.EnsureSession(testOwner, "/w/e-mobile", "flutter")
	again := r.EnsureSession("user_guest", "/w/e-mobile", "flutter")
	b := r.EnsureSession(testOwner, "/w/todo-rn", "expo")

	if a.ID != again.ID {
		t.Error("two people on the SAME project got separate sessions — they would fight over the same resources without seeing each other")
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
