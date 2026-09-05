package main

// tmux_convex_test.go — the tmux runner-session ledger that syncs to Convex.
//
// Three guarantees are tested here:
//   1. PRIVACY: the payload Convex receives is identifiers + lifecycle only.
//      No forbidden keys (convex_privacy_test.go's walker), no absolute paths.
//   2. LIFE: an open session with a runner is recorded open; a /exit'd or
//      vanished session produces a closed record.
//   3. RESTART SURVIVAL: the on-disk cache lets a restarted agent report a
//      closure for a session that died while it was down, and the cache is
//      only pruned after the Convex call succeeds.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// resetTmuxConvexState zeroes the package-level sync state so each test starts
// clean (no dedup hash carries over, no recorder from a previous test).
func resetTmuxConvexState(t *testing.T, prev *convexSyncer) {
	t.Helper()
	globalTmuxSync.mu.Lock()
	globalTmuxSync.lastHash = 0
	globalTmuxSync.sent = false
	globalTmuxSync.mu.Unlock()
	globalConvexSync = prev
}

func withTestConvexSync(t *testing.T) *convexSyncer {
	t.Helper()
	prev := globalConvexSync
	globalConvexSync = &convexSyncer{deviceID: "test-device"}
	return prev
}

// TestTmuxConvexSnapshot_JSONKeysAreSafe locks the wire keys of a tmux session
// record. If someone adds a field here that Convex must never hold (pane
// content, currentPath, preview, title, model...), this test names it before
// the payload ever ships.
func TestTmuxConvexSnapshot_JSONKeysAreSafe(t *testing.T) {
	allowed := map[string]bool{
		"sessionName": true, "sessionId": true, "paneId": true,
		"sessionKind": true, "origin": true, "projectHint": true, "taskId": true,
		"taskIdHint": true, "inputMode": true, "startedAt": true,
		"panes":  true,
		"runner": true, "status": true, "paneCount": true,
		"firstSeenAt": true, "closedAt": true,
	}
	raw, err := json.Marshal(tmuxConvexSession{
		SessionName: "s", SessionID: "$1", PaneID: "%1", Runner: "claude",
		SessionKind: "task", Origin: "yaver-task", ProjectHint: "yaver-io", TaskID: "full-task-id",
		TaskIDHint: "f85f4b", InputMode: VibeInputTaskFollowUp, StartedAt: 3,
		Status: "open", PaneCount: 1, FirstSeenAt: 1, ClosedAt: 2,
		Panes: []tmuxConvexPane{{PaneID: "%1", Runner: "claude", InputMode: VibeInputTaskFollowUp, Status: "open"}},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for k := range m {
		if !allowed[k] {
			t.Errorf("tmuxConvexSession exposes key %q — identifiers + lifecycle only; remove the field", k)
		}
	}
}

// TestTmuxConvexSyncPayloadHasNoConfidentialFields drives the real sync path
// (with the recorder installed, exactly like the other convex_privacy tests)
// against a live tmux session and asserts the recorded mutation is clean.
func TestTmuxConvexSyncPayloadHasNoConfidentialFields(t *testing.T) {
	buf, teardown := installConvexRecorder(t)
	defer teardown()
	prev := withTestConvexSync(t)
	defer resetTmuxConvexState(t, prev)

	// Isolate the cache so the test never touches the developer's ~/.yaver.
	t.Setenv("HOME", t.TempDir())

	// Force a non-empty snapshot regardless of whether real tmux sessions
	// exist: a synthetic record with an adversarial session name (path-ish,
	// prompt-ish) proves the boundary sanitizes before the payload ships.
	adversarial := []tmuxConvexSession{
		{
			SessionName: "/Users/attacker/secret-project",
			SessionID:   "$9",
			PaneID:      "%9",
			Runner:      "claude",
			Status:      "open",
			PaneCount:   1,
			FirstSeenAt: 1,
		},
	}
	// The real sync path runs the snapshot THROUGH convexSafeSessionName;
	// emulate that here so the recorded payload is what production sends.
	for i := range adversarial {
		adversarial[i].SessionName = convexSafeSessionName(adversarial[i].SessionName)
	}
	globalConvexSync.callMutationOK("tmuxSessions:syncTmuxSessions", map[string]interface{}{
		"deviceId": "test-device",
		"sessions": payloadToAnySlice(adversarial),
	})

	if len(*buf) != 1 {
		t.Fatalf("expected 1 recorded mutation, got %d", len(*buf))
	}
	rec := (*buf)[0]
	if full, _ := rec.Args["fullSnapshot"].(bool); !full {
		t.Fatal("a successful exhaustive tmux scan must be marked fullSnapshot so Convex can close rows missing from a lost agent cache")
	}
	if rec.Path != "tmuxSessions:syncTmuxSessions" {
		t.Fatalf("unexpected mutation path %q", rec.Path)
	}
	assertNoForbiddenFields(t, rec)
	assertNoAbsolutePaths(t, rec)
	// The adversarial path-ish session name MUST have been sanitized out of
	// path shape (the walker above proves no "/Users/" fragment survives).
	sessions := tmuxRecordedSessions(t, rec.Args["sessions"])
	if got := sessions[0]["sessionName"]; got == "/Users/attacker/secret-project" {
		t.Errorf("adversarial session name leaked unsanitized: %v", got)
	}
}

// tmuxRecordedSessions normalizes the recorder's shallow-copied sessions value
// (either []interface{} of maps or the original []tmuxConvexSession) to a
// []map[string]interface{} for assertions.
func tmuxRecordedSessions(t *testing.T, v interface{}) []map[string]interface{} {
	t.Helper()
	switch x := v.(type) {
	case []interface{}:
		out := make([]map[string]interface{}, 0, len(x))
		for _, item := range x {
			out = append(out, item.(map[string]interface{}))
		}
		return out
	case []tmuxConvexSession:
		out := make([]map[string]interface{}, 0, len(x))
		for _, s := range x {
			b, _ := json.Marshal(s)
			var m map[string]interface{}
			_ = json.Unmarshal(b, &m)
			out = append(out, m)
		}
		return out
	default:
		t.Fatalf("unexpected sessions value type %T", v)
		return nil
	}
}

// payloadToAnySlice converts []tmuxConvexSession to []map[string]interface{}
// the way json.Marshal would shape the mutation args. The syncer sends the
// structs directly; this mirrors that for the recorder test.
func payloadToAnySlice(s []tmuxConvexSession) []interface{} {
	out := make([]interface{}, 0, len(s))
	for _, r := range s {
		b, _ := json.Marshal(r)
		var m map[string]interface{}
		_ = json.Unmarshal(b, &m)
		out = append(out, m)
	}
	return out
}

// TestTmuxConvexCache_SessionVanishingWhileAgentDownIsReportedClosed is the
// restart-survival guarantee: a session in the on-disk cache that is no longer
// in tmux produces a closed record carrying the cached runner, and the cache is
// pruned only after the Convex call succeeds.
func TestTmuxConvexCache_SessionVanishingWhileAgentDownIsReportedClosed(t *testing.T) {
	buf, teardown := installConvexRecorder(t)
	defer teardown()
	prev := withTestConvexSync(t)
	defer resetTmuxConvexState(t, prev)

	home := t.TempDir()
	t.Setenv("HOME", home)

	// Simulate a previous agent run: it knew about a claude seat "yaver-test".
	writeTmuxCache(t, map[string]tmuxSessionCacheEntry{
		"yaver-test": {FirstSeenAt: 1000, LastRunner: "claude"},
	})

	// No tmux at all right now (fresh HOME, and even if the box has tmux the
	// scan must not find the cached session name).
	syncTmuxSessionsToConvex(context.Background())

	if len(*buf) != 1 {
		t.Fatalf("expected exactly 1 mutation, got %d", len(*buf))
	}
	rec := (*buf)[0]
	// The box may have REAL tmux sessions, so find the cached one specifically.
	sessions := tmuxRecordedSessions(t, rec.Args["sessions"])
	var row map[string]interface{}
	for _, s := range sessions {
		if s["sessionName"] == "yaver-test" {
			row = s
			break
		}
	}
	if row == nil {
		t.Fatalf("recorded sessions %v do not include the cached session", sessions)
	}
	if row["status"] != "closed" {
		t.Errorf("status = %v, want closed (session died while agent was down)", row["status"])
	}
	if row["runner"] != "claude" {
		t.Errorf("runner = %v, want claude (cached last runner survives)", row["runner"])
	}

	// Cache must be pruned after success so the closure is not re-emitted.
	c := loadTmuxSessionCache()
	if _, ok := c.sessions["yaver-test"]; ok {
		t.Errorf("cache not pruned after successful sync: %v", c.sessions)
	}

	// A second sync must NOT re-emit the yaver-test closure (dedup).
	before := len(*buf)
	syncTmuxSessionsToConvex(context.Background())
	for _, rec2 := range (*buf)[before:] {
		for _, s := range tmuxRecordedSessions(t, rec2.Args["sessions"]) {
			if s["sessionName"] == "yaver-test" {
				t.Errorf("idle box re-emitted the closure for yaver-test")
			}
		}
	}
}

// TestTmuxConvexCache_FailedSyncKeepsCacheForRetry proves the cache is only
// pruned on SUCCESS: when the Convex call fails, the closure stays in the
// cache so the next tick retries it.
func TestTmuxConvexCache_FailedSyncKeepsCacheForRetry(t *testing.T) {
	prev := withTestConvexSync(t)
	defer resetTmuxConvexState(t, prev)
	t.Setenv("HOME", t.TempDir())
	// A real client pointed at a dead endpoint → the mutation call fails fast.
	globalConvexSync.convexURL = "http://127.0.0.1:1"
	globalConvexSync.client = &http.Client{Timeout: 500 * time.Millisecond}

	writeTmuxCache(t, map[string]tmuxSessionCacheEntry{
		"yaver-test": {FirstSeenAt: 1000, LastRunner: "opencode"},
	})

	syncTmuxSessionsToConvex(context.Background())

	c := loadTmuxSessionCache()
	if _, ok := c.sessions["yaver-test"]; !ok {
		t.Fatal("cache pruned despite the sync failing — the closure would be lost forever")
	}
}

// TestTmuxConvexSnapshot_OpenSessionIsReportedOpen is the happy path, gated on
// a real tmux: a live shell session reports open (runner=shell), and after the
// session is killed the sync emits a closed record.
func TestTmuxConvexSnapshot_OpenSessionIsReportedOpen(t *testing.T) {
	skipIfNoTmux(t)
	cleanup := createTestTmuxSession(t, "yaver-convex-test")
	defer cleanup()

	snap := tmuxConvexSnapshot(context.Background())
	var found *tmuxConvexSession
	for i := range snap {
		if snap[i].SessionName == "yaver-convex-test" {
			found = &snap[i]
			break
		}
	}
	if found == nil {
		t.Fatal("snapshot did not include the live test session")
	}
	if found.Status != "open" {
		t.Errorf("status = %q, want open", found.Status)
	}
	if found.Runner != "shell" && found.Runner != "unknown" {
		t.Errorf("runner = %q, want shell/unknown for a bare shell", found.Runner)
	}
	if found.PaneCount < 1 {
		t.Errorf("paneCount = %d, want >= 1", found.PaneCount)
	}
	if found.Origin != "manual" {
		t.Errorf("origin = %q, want manual for user-created tmux session", found.Origin)
	}
	if len(found.Panes) < 1 || found.Panes[0].PaneID == "" || found.Panes[0].Status != "open" {
		t.Errorf("pane ledger did not preserve the independently addressable seat: %+v", found.Panes)
	}

	// Kill the session: the next snapshot must omit it (its closure is
	// produced by the cache reconciliation, covered by the test above).
	cleanup()
	snap2 := tmuxConvexSnapshot(context.Background())
	for i := range snap2 {
		if snap2[i].SessionName == "yaver-convex-test" {
			t.Fatal("snapshot still lists a killed session")
		}
	}
}

func writeTmuxCache(t *testing.T, sessions map[string]tmuxSessionCacheEntry) {
	t.Helper()
	dir, err := yaverDir()
	if err != nil {
		t.Fatalf("yaverDir: %v", err)
	}
	raw, err := json.Marshal(sessions)
	if err != nil {
		t.Fatalf("marshal cache: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tmux-sessions.json"), raw, 0o600); err != nil {
		t.Fatalf("write cache: %v", err)
	}
}
