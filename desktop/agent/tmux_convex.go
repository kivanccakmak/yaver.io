package main

// tmux_convex.go — privacy-safe tmux runner-session ledger synced to Convex.
//
// Why this exists: tmux adoption state is in-memory on the agent, so a runner
// session survives an agent restart while Yaver's knowledge of it does not —
// and the mobile Tasks list can only show the tmux sessions of the ONE box it
// is connected to. This file pushes a minimal per-session record to the
// tmuxRunnerSessions Convex table on every state-sync tick: session name,
// tmux session/pane ids, the runner living in it, and whether that seat is
// OPEN or CLOSED (the runner exited via /exit //quit, its pane went dead, or
// the whole session was torn down).
//
// PRIVACY — identifiers + lifecycle ONLY. The tmuxConvexSession struct has
// exactly the fields Convex is allowed to hold. No pane content, no
// current-path (absolute paths leak the home-dir username), no prompts, no
// titles, no models. convex_privacy_test.go asserts the payload is clean.
//
// Liveness is decided from TMUX TRUTH, never from our classifier: a session is
// CLOSED only when tmux reports it gone, or when every pane it lists has
// pane_dead=1 (the /exit end state). A pane whose agent probe times out under
// the wall-clock deadline stays "open" — a slow box must not make a live seat
// look gone.
//
// Restart survival: a tiny JSON cache (~/.yaver/tmux-sessions.json) remembers
// firstSeenAt + lastRunner per session. When the agent comes back and a cached
// session is no longer in tmux, we emit a closed record for it — so a session
// that died while the agent was down still lands in Convex. The cache entry is
// only pruned after the Convex call succeeds, so a failed sync retries the
// closure on the next tick instead of forgetting it.

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// tmuxConvexSession is the privacy-safe per-session record pushed to Convex.
// The field names double as the mutation arg keys — keep them in the
// allow-list of convex_privacy_test.go (they all are: identifiers + lifecycle).
type tmuxConvexSession struct {
	SessionName string `json:"sessionName"`
	SessionID   string `json:"sessionId,omitempty"`
	PaneID      string `json:"paneId,omitempty"`
	Runner      string `json:"runner"` // claude | codex | opencode | shell | unknown
	Status      string `json:"status"` // open | closed
	PaneCount   int    `json:"paneCount,omitempty"`
	FirstSeenAt int64  `json:"firstSeenAt,omitempty"` // epoch ms
	ClosedAt    int64  `json:"closedAt,omitempty"`    // epoch ms
}

// tmuxSessionCacheEntry is the persisted per-session memory that lets a
// restarting agent still report closures. Not secret; lives on the box.
type tmuxSessionCacheEntry struct {
	FirstSeenAt int64  `json:"firstSeenAt"`
	LastRunner  string `json:"lastRunner,omitempty"`
}

// tmuxSessionCache is the on-disk known-session ledger (~/.yaver/...).
type tmuxSessionCache struct {
	mu       sync.Mutex
	path     string
	sessions map[string]tmuxSessionCacheEntry
}

// tmuxCacheFile is the cache path under ~/.yaver.
func tmuxCacheFile() string {
	if dir, err := yaverDir(); err == nil {
		return filepath.Join(dir, "tmux-sessions.json")
	}
	return ""
}

// loadTmuxSessionCache reads the cache, tolerating absence/corruption
// (a fresh agent on a fresh box starts empty; a corrupt file is a bug, not a
// reason to refuse to serve).
func loadTmuxSessionCache() *tmuxSessionCache {
	c := &tmuxSessionCache{path: tmuxCacheFile(), sessions: map[string]tmuxSessionCacheEntry{}}
	if c.path == "" {
		return c
	}
	raw, err := os.ReadFile(c.path)
	if err != nil {
		return c
	}
	var stored map[string]tmuxSessionCacheEntry
	if json.Unmarshal(raw, &stored) == nil {
		c.sessions = stored
	}
	return c
}

func (c *tmuxSessionCache) save() {
	if c == nil || c.path == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	raw, err := json.Marshal(c.sessions)
	if err != nil {
		return
	}
	_ = os.WriteFile(c.path, raw, 0o600)
}

// tmuxConvexSnapshot enumerates every live tmux session and reduces it to the
// privacy-safe record Convex is allowed to hold. Bounded like ListVibePanes:
// the whole scan runs under a wall-clock deadline.
func tmuxConvexSnapshot(ctx context.Context) []tmuxConvexSession {
	if !tmuxAvailable() {
		return nil
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, vibeDefaultDeadline)
		defer cancel()
	}

	// One spine call lists every pane with its session + dead flags. A session
	// cannot exist without a pane, so this doubles as the session enumeration.
	out, err := exec.CommandContext(ctx, tmuxCmdName(), "list-panes", "-a", "-F",
		strings.Join([]string{
			"#{session_name}", "#{session_id}", "#{pane_id}", "#{pane_dead}", "#{pane_pid}",
		}, "\t")).CombinedOutput()
	if err != nil {
		if isTmuxNoServer(string(out)) {
			return nil
		}
		// Cannot enumerate: emit nothing rather than a guessed "all closed".
		return nil
	}

	type seat struct {
		sessionID string
		paneID    string
		dead      bool
		pid       int
	}
	bySession := map[string][]seat{}
	var order []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.SplitN(line, "\t", 5)
		if len(f) < 5 {
			continue
		}
		pid, _ := strconv.Atoi(f[4])
		if _, ok := bySession[f[0]]; !ok {
			order = append(order, f[0])
		}
		bySession[f[0]] = append(bySession[f[0]], seat{
			sessionID: f[1], paneID: f[2], dead: f[3] == "1", pid: pid,
		})
	}

	records := make([]tmuxConvexSession, 0, len(order))
	for _, name := range order {
		seats := bySession[name]
		anyLive := false
		runner := "unknown"
		paneID := ""
		sessionID := ""
		for i := range seats {
			if sessionID == "" {
				sessionID = seats[i].sessionID
			}
			if paneID == "" {
				paneID = seats[i].paneID
			}
			if seats[i].dead {
				continue
			}
			anyLive = true
			if ctx.Err() != nil {
				// Deadline hit: keep scanning for structure but stop forking.
				continue
			}
			if a, ok := detectPaneAgent(ctx, seats[i].pid); ok {
				runner = a
			}
		}
		status := "closed"
		if anyLive {
			status = "open"
		}
		if runner == "unknown" && anyLive {
			runner = "shell"
		}
		records = append(records, tmuxConvexSession{
			SessionName: convexSafeSessionName(name),
			SessionID:   sessionID,
			PaneID:      paneID,
			Runner:      runner,
			Status:      status,
			PaneCount:   len(seats),
		})
	}
	return records
}

// convexSafeSessionName makes a tmux session name safe for Convex. tmux names
// are identifiers, but a user could name a session something path-shaped
// ("/Users/me/proj") — and Convex must never hold an absolute path (the
// privacy fence in convex_privacy_test.go walks VALUES, not just keys). Same
// spirit as taskPlacement.ts's normalizeProjectSlug: collapse separators, trim
// leading dot/dash (tmux itself forbids leading "." and any ":"), cap length.
//
// Distinct from runner_pty.go's sanitizeTmuxSessionName, which is a strict
// REJECT (returns "") for names Yaver itself spawns. Reporting must be lossy
// instead: a real session named "my session" still lands as a safe label.
// Applied at the snapshot boundary so cache keys and payloads agree.
func convexSafeSessionName(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return '-'
		}
		if r < 32 || r == 127 {
			return '-'
		}
		return r
	}, s)
	for len(s) > 0 && (s[0] == '-' || s[0] == '.') {
		s = s[1:]
	}
	if len(s) > 80 {
		s = s[:80]
	}
	if strings.TrimSpace(s) == "" {
		return "unknown-session"
	}
	return s
}

// tmuxSyncState tracks the last-sent payload so a quiet box makes zero Convex
// calls, and only advances on SUCCESS so a failed call retries next tick.
type tmuxSyncState struct {
	mu       sync.Mutex
	lastHash uint64
	sent     bool
}

var globalTmuxSync tmuxSyncState

// syncTmuxSessionsToConvex reconciles the live snapshot against the persisted
// cache and pushes open + newly-closed records to Convex when anything
// changed. Best-effort: failures are swallowed (the cache is only pruned on
// success, so a lost closure retries next tick).
func syncTmuxSessionsToConvex(ctx context.Context) {
	if globalConvexSync == nil {
		return // not signed in; nothing to sync to
	}
	snap := tmuxConvexSnapshot(ctx)

	cache := loadTmuxSessionCache()
	// Nothing alive and nothing ever known → nothing to do. The empty case
	// alone must not clear the ledger: old closed rows stay meaningful.
	if len(snap) == 0 && len(cache.sessions) == 0 {
		return
	}
	now := time.Now().UnixMilli()

	live := map[string]tmuxConvexSession{}
	var out []tmuxConvexSession
	seen := map[string]bool{}

	for _, s := range snap {
		seen[s.SessionName] = true
		if e, ok := cache.sessions[s.SessionName]; ok {
			if s.FirstSeenAt == 0 {
				s.FirstSeenAt = e.FirstSeenAt
			}
			// Prefer the last known runner when today's probe cannot see one:
			// a /exit'd pane goes dead and detectPaneAgent finds nothing, but
			// the row should still say "claude · closed".
			if (s.Runner == "unknown" || s.Runner == "shell") && e.LastRunner != "" {
				s.Runner = e.LastRunner
			}
		}
		if s.Status == "open" {
			if s.FirstSeenAt == 0 {
				s.FirstSeenAt = now
			}
			live[s.SessionName] = s
			out = append(out, s)
		} else {
			// Session exists but every pane is dead — the runner exited
			// (/exit etc.) or crashed. Close the seat.
			if s.FirstSeenAt == 0 {
				s.FirstSeenAt = now
			}
			s.ClosedAt = now
			out = append(out, s)
		}
	}

	// Sessions we knew about that are now entirely gone from tmux.
	for name, e := range cache.sessions {
		if seen[name] {
			continue
		}
		runner := e.LastRunner
		if runner == "" {
			runner = "unknown"
		}
		out = append(out, tmuxConvexSession{
			SessionName: name,
			Runner:      runner,
			Status:      "closed",
			FirstSeenAt: e.FirstSeenAt,
			ClosedAt:    now,
		})
	}

	if len(out) == 0 {
		return
	}

	payload, err := json.Marshal(out)
	if err != nil {
		return
	}
	h := hashBytes(payload)

	globalTmuxSync.mu.Lock()
	if globalTmuxSync.sent && h == globalTmuxSync.lastHash {
		globalTmuxSync.mu.Unlock()
		return // unchanged since last successful send
	}
	globalTmuxSync.mu.Unlock()

	args := map[string]interface{}{
		"deviceId": globalConvexSync.deviceID,
		"sessions": out,
	}
	if !globalConvexSync.callMutationOK("tmuxSessions:syncTmuxSessions", args) {
		return // cache NOT pruned → the closure is re-emitted next tick
	}

	globalTmuxSync.mu.Lock()
	globalTmuxSync.lastHash = h
	globalTmuxSync.sent = true
	globalTmuxSync.mu.Unlock()

	// Prune the cache to live seats only — closures have landed in Convex.
	cache.sessions = map[string]tmuxSessionCacheEntry{}
	for name, s := range live {
		cache.sessions[name] = tmuxSessionCacheEntry{
			FirstSeenAt: s.FirstSeenAt,
			LastRunner:  s.Runner,
		}
	}
	cache.save()
}
