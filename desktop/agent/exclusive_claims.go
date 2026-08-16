package main

// exclusive_claims.go — the one mechanism for "this machine has a resource only
// ONE session may hold at a time".
//
// Yaver's shape is many projects and many people on one good machine. Two kinds
// of resource make that a correctness problem rather than a capacity problem,
// and both failed the same way on the Mac mini on 2026-07-25:
//
//   PORTS       every lane hard-coded its canonical port (Metro 8081, Expo Web
//               19006, Flutter 9100, Vite 5173, Next 3000). A second project got
//               a collision; a foreign listener (freeswitch on :8081 for four
//               days, an orphan `flutter run` on :9100) got mistaken for our own
//               healthy dev server.
//
//   DEVICES     pickSimulator() scores an already-booted simulator +100, so
//               EVERY session picks the SAME simulator. Two users vibing two
//               different projects both drive one device: the second install
//               replaces the first's app, both video streams show the same
//               screen, and nobody is told. An emulator serial has the identical
//               problem.
//
// The failure they share is not "we ran out". It is that choosing and using are
// separate moments, and nothing remembered the choice in between. So this file
// remembers. A claim is taken at CHOICE time (before any process/boot exists),
// is attributed to an owner, and is released when the session ends.
//
// What a claim does NOT do: make the resource safe from the rest of the machine.
// Nothing stops a non-Yaver process binding a port or a human opening
// Simulator.app. That is why users of this registry must ALSO verify the resource
// is theirs when they start using it — readiness that proves the listener is our
// process, a device check that the app we installed is the app running. Claim to
// avoid colliding with ourselves; verify to survive everyone else.

import (
	"sort"
	"sync"
	"time"
)

// claim is one held resource.
type claim[K comparable] struct {
	Key   K
	Kind  string // "metro" | "flutter" | "ios-simulator" | "android-emulator" | …
	Owner string // userID:workDir, or whatever identifies the session
	Since time.Time
}

// claimRegistry hands out exclusive claims on comparable keys (int ports, string
// device UDIDs). Process-global by design: the OS port space and the set of
// booted simulators are machine-wide, so a per-user registry could not see what
// another user's session is about to take.
type claimRegistry[K comparable] struct {
	mu   sync.Mutex
	held map[K]*claim[K]
}

func newClaimRegistry[K comparable]() *claimRegistry[K] {
	return &claimRegistry[K]{held: map[K]*claim[K]{}}
}

// tryClaim takes `key` for `owner` if nobody holds it. The returned release is
// idempotent — a double stop must not free a claim a later session has taken, so
// release only deletes the entry when it is still the SAME claim.
func (r *claimRegistry[K]) tryClaim(key K, kind, owner string) (release func(), ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, taken := r.held[key]; taken {
		return nil, false
	}
	c := &claim[K]{Key: key, Kind: kind, Owner: owner, Since: time.Now()}
	r.held[key] = c
	var once sync.Once
	return func() {
		once.Do(func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			if cur, exists := r.held[key]; exists && cur == c {
				delete(r.held, key)
			}
		})
	}, true
}

func (r *claimRegistry[K]) heldBy(key K) (owner string, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, exists := r.held[key]
	if !exists {
		return "", false
	}
	return c.Owner, true
}

// snapshot returns the current claims for reporting, oldest first, so a user
// asking "who has the simulator?" or "why is my preview on :8083?" can be told.
func (r *claimRegistry[K]) snapshot() []claim[K] {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]claim[K], 0, len(r.held))
	for _, c := range r.held {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Since.Before(out[j].Since) })
	return out
}

func (r *claimRegistry[K]) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.held)
}
