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
// exactly the fields Convex is allowed to hold. Besides tmux ids/lifecycle it
// carries the bounded structured identity encoded by Yaver's own session name
// (kind, runner, project/task hints, start time, input mode). No pane content,
// no current-path (absolute paths leak the home-dir username), no prompts, no
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
	SessionName string           `json:"sessionName"`
	SessionID   string           `json:"sessionId,omitempty"`
	PaneID      string           `json:"paneId,omitempty"`
	SessionKind string           `json:"sessionKind,omitempty"` // task | autorun | runner | other
	Origin      string           `json:"origin,omitempty"`      // yaver-task | yaver-autorun | yaver-runner | manual
	ProjectHint string           `json:"projectHint,omitempty"` // bounded name component, never a path
	TaskID      string           `json:"taskId,omitempty"`      // exact @yaver-task-id when present
	TaskIDHint  string           `json:"taskIdHint,omitempty"`  // bounded suffix parsed from the name
	InputMode   string           `json:"inputMode,omitempty"`   // interactive | task-followup
	Runner      string           `json:"runner"`                // claude | codex | opencode | shell | unknown
	Status      string           `json:"status"`                // open | closed
	PaneCount   int              `json:"paneCount,omitempty"`
	StartedAt   int64            `json:"startedAt,omitempty"`   // encoded task start, epoch ms
	FirstSeenAt int64            `json:"firstSeenAt,omitempty"` // epoch ms
	ClosedAt    int64            `json:"closedAt,omitempty"`    // epoch ms
	Panes       []tmuxConvexPane `json:"panes,omitempty"`
}

// tmuxConvexPane makes each runner in a split tmux session independently
// discoverable. It deliberately excludes output, paths, titles, models and
// PIDs; those remain on the authenticated live-agent connection only.
type tmuxConvexPane struct {
	PaneID    string `json:"paneId"`
	Runner    string `json:"runner"`
	InputMode string `json:"inputMode,omitempty"`
	Status    string `json:"status"` // open | closed
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
type tmuxConvexSnapshotResult struct {
	Sessions []tmuxConvexSession
	Complete bool
}

// scanTmuxConvexSnapshot distinguishes an authoritative empty snapshot from a
// failed scan. That distinction is load-bearing: Convex may safely close rows
// absent from a complete snapshot, but must preserve them when tmux timed out
// or returned an unexpected error.
func scanTmuxConvexSnapshot(ctx context.Context) tmuxConvexSnapshotResult {
	if !tmuxAvailable() {
		return tmuxConvexSnapshotResult{Sessions: []tmuxConvexSession{}, Complete: true}
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
			"#{@yaver-task-id}", "#{@yaver-runner}", "#{@yaver-input-mode}", "#{@yaver-origin}",
		}, "\t")).CombinedOutput()
	if err != nil {
		if isTmuxNoServer(string(out)) {
			return tmuxConvexSnapshotResult{Sessions: []tmuxConvexSession{}, Complete: true}
		}
		// Cannot enumerate: emit nothing rather than a guessed "all closed".
		return tmuxConvexSnapshotResult{Sessions: []tmuxConvexSession{}, Complete: false}
	}

	type seat struct {
		sessionID string
		paneID    string
		dead      bool
		pid       int
		taskID    string
		runner    string
		inputMode string
		origin    string
	}
	bySession := map[string][]seat{}
	var order []string
	// Trim newlines only. The final three format fields are optional tmux
	// options and therefore commonly empty tabs; TrimSpace would erase those
	// tabs from the last row and make an ordinary user session fail len(f)==8.
	for _, line := range strings.Split(strings.TrimRight(string(out), "\r\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.SplitN(line, "\t", 9)
		if len(f) < 9 {
			continue
		}
		pid, _ := strconv.Atoi(f[4])
		if _, ok := bySession[f[0]]; !ok {
			order = append(order, f[0])
		}
		bySession[f[0]] = append(bySession[f[0]], seat{
			sessionID: f[1], paneID: f[2], dead: f[3] == "1", pid: pid,
			taskID: f[5], runner: normalizeRunnerID(f[6]), inputMode: strings.TrimSpace(f[7]), origin: normalizeTmuxOrigin(f[8]),
		})
	}

	records := make([]tmuxConvexSession, 0, len(order))
	for _, name := range order {
		seats := bySession[name]
		hints := parseYaverTmuxSessionName(name)
		anyLive := false
		runner := hints.Runner
		if !tmuxRunnerEligible(runner) {
			runner = "unknown"
		}
		paneID := ""
		sessionID := ""
		taskID := ""
		inputMode := hints.InputMode
		origin := hints.Origin
		paneRecords := make([]tmuxConvexPane, 0, len(seats))
		for i := range seats {
			if sessionID == "" {
				sessionID = seats[i].sessionID
			}
			if paneID == "" {
				paneID = seats[i].paneID
			}
			if taskID == "" {
				taskID = convexSafeIdentityHint(seats[i].taskID, 80)
			}
			if tmuxRunnerEligible(seats[i].runner) {
				runner = seats[i].runner
			}
			if seats[i].inputMode != "" {
				inputMode = convexSafeIdentityHint(seats[i].inputMode, 32)
			}
			if seats[i].origin != "" {
				origin = seats[i].origin
			}
			paneRunner := "shell"
			paneInputMode := seats[i].inputMode
			if seats[i].dead {
				paneRecords = append(paneRecords, tmuxConvexPane{
					PaneID: seats[i].paneID, Runner: paneRunner,
					InputMode: paneInputMode, Status: "closed",
				})
				continue
			}
			anyLive = true
			if ctx.Err() != nil {
				// Deadline hit: keep scanning for structure but stop forking.
				paneRecords = append(paneRecords, tmuxConvexPane{
					PaneID: seats[i].paneID, Runner: paneRunner,
					InputMode: paneInputMode, Status: "open",
				})
				continue
			}
			if a, mode, ok := detectPaneAgentDetails(ctx, seats[i].pid); ok {
				runner = a
				paneRunner = a
				if mode != "" {
					paneInputMode = mode
				}
			}
			paneRecords = append(paneRecords, tmuxConvexPane{
				PaneID: seats[i].paneID, Runner: paneRunner,
				InputMode: paneInputMode, Status: "open",
			})
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
			SessionKind: hints.Kind,
			Origin:      origin,
			ProjectHint: hints.ProjectHint,
			TaskID:      taskID,
			TaskIDHint:  hints.TaskIDHint,
			InputMode:   inputMode,
			Runner:      runner,
			Status:      status,
			PaneCount:   len(seats),
			Panes:       paneRecords,
			StartedAt: func() int64 {
				if hints.StartedAt.IsZero() {
					return 0
				}
				return hints.StartedAt.UnixMilli()
			}(),
		})
	}
	return tmuxConvexSnapshotResult{Sessions: records, Complete: true}
}

// tmuxConvexSnapshot is kept as the read-only inventory helper used by tests.
// Reconciliation callers must use scanTmuxConvexSnapshot so they cannot flatten
// a scan failure into an authoritative empty list.
func tmuxConvexSnapshot(ctx context.Context) []tmuxConvexSession {
	return scanTmuxConvexSnapshot(ctx).Sessions
}

func convexSafeIdentityHint(s string, max int) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	lastDash := false
	for _, r := range s {
		valid := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '_'
		if valid {
			b.WriteRune(r)
			lastDash = false
		} else if b.Len() > 0 && !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
		if b.Len() >= max {
			break
		}
	}
	return strings.Trim(b.String(), "-")
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
	mu         sync.Mutex
	lastHash   uint64
	lastSentAt time.Time
	sent       bool
}

var globalTmuxSync tmuxSyncState

// A quiet machine still refreshes its observation periodically so clients can
// distinguish a current open seat from abandoned cloud state. This is only 12
// writes/day/device; state changes still publish on the next minute tick (or
// immediately through requestConvexLifecycleSync).
const tmuxConvexForcedRefreshInterval = 2 * time.Hour

// syncTmuxSessionsToConvex reconciles the live snapshot against the persisted
// cache and pushes open + newly-closed records to Convex when anything
// changed. Best-effort: failures are swallowed (the cache is only pruned on
// success, so a lost closure retries next tick).
func syncTmuxSessionsToConvex(ctx context.Context) {
	if globalConvexSync == nil {
		return // not signed in; nothing to sync to
	}
	scan := scanTmuxConvexSnapshot(ctx)
	if !scan.Complete {
		return // never turn a failed inventory scan into "everything closed"
	}
	snap := scan.Sessions

	cache := loadTmuxSessionCache()
	now := time.Now().UnixMilli()

	live := map[string]tmuxConvexSession{}
	out := make([]tmuxConvexSession, 0, len(snap)+len(cache.sessions))
	seen := map[string]bool{}

	for _, s := range snap {
		seen[s.SessionName] = true
		e, wasKnown := cache.sessions[s.SessionName]
		if wasKnown {
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
		} else if wasKnown {
			// Session exists but every pane is dead — the runner exited
			// (/exit etc.) or crashed. Emit its transition ONCE. Previously
			// ClosedAt=now changed the payload hash every minute and billed one
			// Convex mutation forever for an already-dead pane.
			if s.FirstSeenAt == 0 {
				s.FirstSeenAt = e.FirstSeenAt
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
		closed := tmuxConvexSession{
			SessionName: name,
			Runner:      runner,
			Status:      "closed",
			FirstSeenAt: e.FirstSeenAt,
			ClosedAt:    now,
		}
		hints := parseYaverTmuxSessionName(name)
		closed.SessionKind = hints.Kind
		closed.Origin = hints.Origin
		closed.ProjectHint = hints.ProjectHint
		closed.TaskIDHint = hints.TaskIDHint
		closed.InputMode = hints.InputMode
		if !hints.StartedAt.IsZero() {
			closed.StartedAt = hints.StartedAt.UnixMilli()
		}
		out = append(out, closed)
	}

	// A complete empty scan is intentionally sent once per process. It is the
	// only authoritative way for Convex to close stale open rows after the
	// agent-side cache was lost or corrupted.
	fullSnapshot := len(snap) <= 200
	payload, err := json.Marshal(struct {
		Sessions     []tmuxConvexSession `json:"sessions"`
		FullSnapshot bool                `json:"fullSnapshot"`
	}{Sessions: out, FullSnapshot: fullSnapshot})
	if err != nil {
		return
	}
	h := hashBytes(payload)

	globalTmuxSync.mu.Lock()
	if globalTmuxSync.sent && h == globalTmuxSync.lastHash && time.Since(globalTmuxSync.lastSentAt) < tmuxConvexForcedRefreshInterval {
		globalTmuxSync.mu.Unlock()
		return // unchanged since last successful send
	}
	globalTmuxSync.mu.Unlock()

	args := map[string]interface{}{
		"deviceId":     globalConvexSync.deviceID,
		"sessions":     out,
		"fullSnapshot": fullSnapshot,
	}
	if !globalConvexSync.callMutationOK("tmuxSessions:syncTmuxSessions", args) {
		return // cache NOT pruned → the closure is re-emitted next tick
	}

	globalTmuxSync.mu.Lock()
	globalTmuxSync.lastHash = h
	globalTmuxSync.lastSentAt = time.Now()
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
