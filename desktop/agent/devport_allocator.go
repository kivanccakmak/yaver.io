package main

import (
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

// DevPortAllocator hands out (Metro, ExpoWeb) port pairs to user
// sessions on a shared box so two simultaneous users can run their
// own dev servers without colliding on the canonical 8081/19006.
//
// Ranges (chosen to not collide with the typical dev ecosystem):
//
//	Metro    : 8081 + offset       — base 8081, range 8081..8090
//	ExpoWeb  : 19006 + offset      — base 19006, range 19006..19015
//
// In single-user mode the allocator is unused; the legacy singleton
// path keeps using 8081 / 19006. In multi-user mode each UserSession
// reserves a slot on first dev-server start and holds it until the
// session is stopped or evicted.
type DevPortAllocator struct {
	mu        sync.Mutex
	metroBase int
	webBase   int
	maxSlots  int
	taken     map[int]string // slot index → userID that owns it
}

// NewDevPortAllocator creates an allocator with the default ranges.
func NewDevPortAllocator() *DevPortAllocator {
	return &DevPortAllocator{
		metroBase: 8081,
		webBase:   19006,
		maxSlots:  10,
		taken:     make(map[int]string),
	}
}

// DevPortPair holds the two ports allocated to one user session.
type DevPortPair struct {
	Slot      int
	MetroPort int
	WebPort   int
}

// Reserve picks the lowest free slot, marks it owned by userID,
// and returns the corresponding (Metro, ExpoWeb) ports. Returns
// the existing slot if userID already holds one.
func (a *DevPortAllocator) Reserve(userID string) (DevPortPair, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for slot, owner := range a.taken {
		if owner == userID {
			return DevPortPair{
				Slot:      slot,
				MetroPort: a.metroBase + slot,
				WebPort:   a.webBase + slot,
			}, nil
		}
	}
	for slot := 0; slot < a.maxSlots; slot++ {
		if _, used := a.taken[slot]; used {
			continue
		}
		metro := a.metroBase + slot
		web := a.webBase + slot
		// Probe the OS — slot may be free in our table but a stale
		// process is squatting the port. Skip in that case.
		if portBusy(metro) || portBusy(web) {
			continue
		}
		// …and consult the broker, which knows about ports a session has
		// RESERVED but not yet bound. Without this the two mechanisms disagree
		// for exactly as long as a dev server takes to start: the OS still sees
		// the port as free, so this slot looks available, and both sessions end
		// up pointed at the same port. One source of truth or none.
		if devPortHeld(metro) || devPortHeld(web) {
			continue
		}
		a.taken[slot] = userID
		return DevPortPair{
			Slot:      slot,
			MetroPort: metro,
			WebPort:   web,
		}, nil
	}
	return DevPortPair{}, fmt.Errorf("no free dev-server port slot (limit=%d)", a.maxSlots)
}

// Release frees the slot held by userID, if any. Idempotent.
func (a *DevPortAllocator) Release(userID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for slot, owner := range a.taken {
		if owner == userID {
			delete(a.taken, slot)
			return
		}
	}
}

// Snapshot returns a copy of the current allocations for /info-style
// reporting. Slots without an owner are omitted.
func (a *DevPortAllocator) Snapshot() []DevPortPair {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]DevPortPair, 0, len(a.taken))
	for slot := range a.taken {
		out = append(out, DevPortPair{
			Slot:      slot,
			MetroPort: a.metroBase + slot,
			WebPort:   a.webBase + slot,
		})
	}
	return out
}

// portBusy reports whether this port is unusable for a dev server on this machine.
//
// Two probes, because neither alone is honest:
//
//  1. **Can anything be CONNECTED to?** Unambiguous evidence of occupation, and
//     it is the question that actually matters: the agent's /dev/ proxy dials
//     127.0.0.1:<port>, so a loopback listener would receive OUR users' traffic
//     even if our dev server also managed to bind the wildcard. A "free" port
//     whose loopback is answered by someone else is the false-green this whole
//     file exists to prevent.
//
//  2. **Can the WILDCARD be bound, in each family?** Catches the reverse case
//     measured on a Mac mini (2026-07-25): `node` held `*:8081` (IPv6 wildcard)
//     while binding 127.0.0.1:8081 still SUCCEEDED, so a loopback-bind probe
//     called Metro's port free when Metro could not possibly take it.
//
// Go's listeners set SO_REUSEADDR, which is precisely why a single bind test
// cannot predict the outcome: a wildcard bind can succeed alongside a
// specific-address listener and vice versa. Connect-then-bind covers both.
func portBusy(port int) bool {
	for _, addr := range []string{
		fmt.Sprintf("127.0.0.1:%d", port),
		fmt.Sprintf("[::1]:%d", port),
	} {
		if conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond); err == nil {
			_ = conn.Close()
			return true
		}
	}
	for _, network := range []string{"tcp4", "tcp6"} {
		l, err := net.Listen(network, fmt.Sprintf(":%d", port))
		if err != nil {
			// An unsupported family (IPv6 disabled) is not evidence of a listener.
			if isUnsupportedNetwork(err) {
				continue
			}
			return true
		}
		_ = l.Close()
	}
	return false
}

// isUnsupportedNetwork distinguishes "this host has no IPv6" from "somebody is
// listening". Without it, a machine with IPv6 disabled would report every port
// busy and no dev server could ever start.
func isUnsupportedNetwork(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "address family not supported") ||
		strings.Contains(msg, "protocol not supported") ||
		strings.Contains(msg, "cannot assign requested address")
}

// ─── Dev-server port pre-flight ────────────────────────────────────────
//
// Why this exists (2026-07-25): the browser lane hard-coded :9100 for Flutter,
// and an orphaned dev server from an unrelated project — 23 hours old, left by
// an autorun run — still held it. The new preview's `flutter run` died with
// "Failed to bind web development server: Address already in use", while the
// agent's readiness probe (a plain GET on :9100) was happily answered by the
// ORPHAN. Result: /dev/status said `running:true, serving:true` and the phone
// was pointed at a DIFFERENT project's app.
//
// Two guards come out of that, and they belong together: pick a port nobody
// holds, and treat "the port answers" as insufficient proof of readiness (see
// startProcessWithStdin).

// NOTE: port CHOICE now lives in devserver_ports.go (AcquireDevPort), which adds
// the one thing a probe cannot do — remembering a port between choosing it and
// binding it, so two concurrent starts can't pick the same "free" port. What
// stays here is the OS-level primitive (portBusy) and the failure classifier
// below, both of which the broker builds on.

// portBindFailure reports whether a dev-server log tail contains a
// port-already-bound failure. Framework-agnostic on purpose: Flutter/Dart,
// Node/Vite/Next and Python servers all phrase it differently, and the whole
// point is to name the cause instead of waiting out a 180s readiness deadline
// that reports nothing.
func portBindFailure(tail string) bool {
	if tail == "" {
		return false
	}
	lower := strings.ToLower(tail)
	for _, needle := range []string{
		"address already in use", // Dart/Flutter SocketException, Python
		"eaddrinuse",             // Node (Vite, Next, Metro)
		"failed to bind",         // Flutter's own summary line
		"port is already in use",
		"address in use",
	} {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}
