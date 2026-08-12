package main

// windows_seat_test.go — the Windows seat-index contract, tested on every
// platform (the !windows stub in windows_seat_stub.go implements the same
// no-op semantics, so the map logic itself is exercised wherever this runs).
//
// The seat index is the persistence layer that replaces tmux's
// `new-session -A` on native Windows (2026-08-12): a runner PTY claimed under
// a seat name must be resumable by that name, and a released session must
// free the name so a fresh spawn can take it. The three invariants that
// matter for the runner-pty path:
//   1. claim then lookup returns the session — a reconnect with the same name
//      resumes the live ConPTY instead of spawning a second runner.
//   2. release frees the name — the next spawn owns it.
//   3. a stale release (an already-superseded session) does NOT unseat the
//      current holder — otherwise a racing old session's close would steal
//      the seat from under the new one.
import (
	"testing"
)

func TestWindowsSeatIndexClaimLookupRelease(t *testing.T) {
	idx := newWindowsSeatIndex()

	// Fresh seat: lookup is empty.
	if got := idx.lookup("yaver-opencode"); got != "" {
		t.Fatalf("lookup on empty seat = %q, want \"\"", got)
	}

	// Claim → lookup returns the session (reconnect resumes it).
	idx.register("yaver-opencode", "sess-1")
	if got := idx.lookup("yaver-opencode"); got != "sess-1" {
		t.Fatalf("lookup after claim = %q, want sess-1", got)
	}
	if got := idx.seatNameFor("sess-1"); got != "yaver-opencode" {
		t.Fatalf("seatNameFor = %q, want yaver-opencode", got)
	}

	// Release → seat is free again.
	idx.release("sess-1")
	if got := idx.lookup("yaver-opencode"); got != "" {
		t.Fatalf("lookup after release = %q, want \"\"", got)
	}
	if got := idx.seatNameFor("sess-1"); got != "" {
		t.Fatalf("seatNameFor after release = %q, want \"\"", got)
	}
}

func TestWindowsSeatIndexReplacementSurvivesStaleRelease(t *testing.T) {
	idx := newWindowsSeatIndex()

	// First runner owns the seat.
	idx.register("yaver-codex", "sess-old")

	// A reconnect finds it (the resume path).
	if got := idx.lookup("yaver-codex"); got != "sess-old" {
		t.Fatalf("lookup = %q, want sess-old", got)
	}

	// The old session is superseded by a fresh spawn (e.g. ?fresh=1 or a
	// stale-dead seat). register returns the previous holder so the caller
	// can decide to retire it; the NEW session must own the name now.
	prev := idx.register("yaver-codex", "sess-new")
	if prev != "sess-old" {
		t.Fatalf("register prev holder = %q, want sess-old", prev)
	}
	if got := idx.lookup("yaver-codex"); got != "sess-new" {
		t.Fatalf("lookup after replacement = %q, want sess-new", got)
	}

	// The OLD session finally closes and calls release("sess-old"). Its
	// release must NOT unseat the current holder ("sess-new") — otherwise a
	// racing old-session close would steal the seat out from under the live
	// runner, and the next reconnect would spawn a duplicate.
	idx.release("sess-old")
	if got := idx.lookup("yaver-codex"); got != "sess-new" {
		t.Fatalf("lookup after stale release = %q, want sess-new (stale release must not unseat the holder)", got)
	}

	// The current holder's own release does free it.
	idx.release("sess-new")
	if got := idx.lookup("yaver-codex"); got != "" {
		t.Fatalf("lookup after holder release = %q, want \"\"", got)
	}
}

func TestWindowsSeatIndexReleaseIsIdempotent(t *testing.T) {
	idx := newWindowsSeatIndex()
	idx.register("yaver-claude", "sess-1")
	idx.release("sess-1")
	idx.release("sess-1") // double release must not panic or corrupt
	idx.release("never-claimed")
	if got := idx.lookup("yaver-claude"); got != "" {
		t.Fatalf("lookup = %q, want \"\" after double release", got)
	}
}
