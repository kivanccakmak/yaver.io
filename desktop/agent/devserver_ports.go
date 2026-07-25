package main

// devserver_ports.go — ONE authoritative answer to "which port may this dev
// server bind?", for every framework, every user, every project on the machine.
//
// ── Why this exists ───────────────────────────────────────────────────────────
//
// Yaver's whole pitch is that one good machine (a Mac mini today, a Mac Studio
// later) serves many projects and many people at once. Every lane instead hard-
// coded the framework's canonical port — Metro 8081, Expo Web 19006, Flutter
// 9100, Vite 5173, Next 3000 — and then decided "ready" by GETting that port.
// Three ways that fails, all observed on one box on 2026-07-25:
//
//  1. **A foreign listener answers.** `freeswitch` had owned :8081 for four days
//     on the Mac mini. Metro would fail to bind, and the readiness probe would be
//     answered by freeswitch — so the agent would report a healthy dev server and
//     hand the phone a bundle URL served by a telephony daemon. Earlier the same
//     day, an orphaned `flutter run` from an unrelated project owned :9100 and did
//     exactly this: `serving:true` while the real process was dead.
//
//  2. **Two projects cannot coexist.** Second project → same port → collision, or
//     (worse) it "succeeds" by proxying to the first project's app. On a machine
//     whose purpose is parallel work that is a correctness bug, not a limit.
//
//  3. **Two concurrent starts race.** Probing a port for freeness and then
//     spawning a process that binds it a second later is a TOCTOU window. Two
//     simultaneous starts both see 8082 free and both pick it; one dies. A
//     probe alone cannot close this — the winner must be recorded the moment it
//     is chosen, before any process exists.
//
// The broker answers all three: probe the port, refuse anything another session
// holds in flight, hand out the first usable port in a bounded span, and remember
// the owner until they release it. Reservations are process-global because the OS
// port space is process-global — a per-user allocator cannot see a port a
// different user's session is about to bind.
//
// ── What it deliberately does NOT do ─────────────────────────────────────────
//
// It does not make a port "safe" by itself. A reservation says "no other Yaver
// session may take this port"; it says nothing about a process outside Yaver
// grabbing it in the same millisecond. That is why readiness ALSO has to prove
// the listener is ours (see baseDevServer.startProcess / startProcessWithStdin):
// reserve to avoid self-collisions, verify to survive the rest of the machine.

import (
	"fmt"
	"log"
	"sort"
	"strings"
	"time"
)

// devPortSpan is how far past the preferred port the broker will walk. 40 is
// wide enough for a Mac Studio running a dozen previews per user and narrow
// enough that a substituted port stays recognisable (8081 → 8083, not 8081 →
// 47120).
const devPortSpan = 40

// devPortReservation records who holds a port and why, so /info and the UI can
// answer "what is on 8083?" without shelling out to lsof.
type devPortReservation struct {
	Port  int
	Kind  string // "metro" | "web" | "flutter" | "vite" | "next" | …
	Owner string // userID:workDir — whatever the caller can identify itself by
	Since time.Time
}

// Ports and devices (simulators/emulators) are the same problem — an exclusive
// machine resource chosen in one moment and used in another — so they share one
// registry implementation (exclusive_claims.go) rather than two lookalikes that
// drift.
var devPortClaims = newClaimRegistry[int]()

// AcquireDevPort reserves a usable port at or after `preferred` for `owner`.
//
// Returns the port and a release function. The release is idempotent and MUST be
// called when the dev server stops — a leaked reservation shrinks the pool for
// everything else on the machine (bounded only by agent restart).
//
// `substituted` reports whether the caller got something other than what it
// asked for, so the caller can say so in a log line the user will later grep.
func AcquireDevPort(kind, owner string, preferred int) (port int, substituted bool, release func()) {
	return acquireDevPort(kind, owner, preferred, devPortSpan)
}

func acquireDevPort(kind, owner string, preferred, span int) (int, bool, func()) {
	if preferred <= 0 {
		return preferred, false, func() {}
	}
	for p := preferred; p <= preferred+span && p <= 65535; p++ {
		// portBusy first: an OS-level listener is the cheaper, more common
		// disqualifier, and checking it before claiming keeps the registry free
		// of entries we would immediately have to drop.
		if portBusy(p) {
			continue // something on the machine already owns it
		}
		release, ok := devPortClaims.tryClaim(p, kind, owner)
		if !ok {
			continue // another Yaver session is about to bind this
		}
		if p != preferred {
			log.Printf("[devports] %s for %s: :%d is unavailable — reserved :%d instead (the client loads /dev/, so the port is an implementation detail)",
				kind, ownerLabel(owner), preferred, p)
		}
		return p, p != preferred, release
	}

	// Everything in the span is busy. Hand back the preferred port with no
	// reservation and let the bind fail with the framework's own error — an
	// honest failure beats silently landing outside the range we advertise.
	log.Printf("[devports] %s for %s: every port in %d..%d is busy — falling through to :%d, which will fail to bind",
		kind, ownerLabel(owner), preferred, preferred+span, preferred)
	return preferred, false, func() {}
}

// DevPortSnapshot returns the current reservations for /dev/status and /info, so
// a user staring at "why is my preview on :8083?" gets an answer without lsof.
func DevPortSnapshot() []devPortReservation {
	claims := devPortClaims.snapshot()
	out := make([]devPortReservation, 0, len(claims))
	for _, c := range claims {
		out = append(out, devPortReservation{Port: c.Key, Kind: c.Kind, Owner: c.Owner, Since: c.Since})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}

// devPortHeld reports whether a Yaver session holds a reservation on this port.
// The multi-user slot allocator consults it so the two mechanisms cannot disagree
// during the window between choosing a port and binding it.
func devPortHeld(port int) bool {
	_, ok := devPortClaims.heldBy(port)
	return ok
}

// ownerLabel keeps log lines readable (and never prints a whole home path when a
// basename identifies the project).
func ownerLabel(owner string) string {
	owner = strings.TrimSpace(owner)
	if owner == "" {
		return "(unattributed)"
	}
	if i := strings.LastIndex(owner, "/"); i >= 0 && i < len(owner)-1 {
		return owner[i+1:]
	}
	return owner
}

// devPortOwner builds the owner label for a dev-server session. userID may be
// empty in single-user mode; the workDir basename is what a human recognises.
func devPortOwner(userID, workDir string) string {
	uid := strings.TrimSpace(userID)
	if len(uid) > 8 {
		uid = uid[:8]
	}
	if uid == "" {
		return workDir
	}
	return fmt.Sprintf("%s:%s", uid, workDir)
}
