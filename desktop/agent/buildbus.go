package main

// buildbus.go — the build/upload coordination bus.
//
// Problem (2026-08-09): every opencode/claude/codex process spawns its OWN
// `yaver mcp` stdio process, each with its own TaskManager and managers and
// NO shared memory. N AI processes on one machine can therefore launch N
// independent builds/uploads of the SAME thing simultaneously — two
// TestFlight archives clobbering /tmp/Yaver.xcarchive, two Info.plist
// version bumps, two Play uploads of one versionCode, two npm tags
// cli/vX.Y.Z, two Convex/Cloudflare pushes. In-process mutexes cannot fix
// this by construction: the codebase itself says so in vault_lock_unix.go
// ("an in-process mutex is not enough if a user runs two terminals").
//
// The bus is the CROSS-PROCESS answer. It has two backends that share one
// API so call sites never care which one is active:
//
//  1. The SQLite lease table (`~/.yaver/autoruns.db` build_leases, WAL +
//     busy_timeout + single-writer conn): the durable, queryable bus used
//     when the store opens (daemon and CLI paths). Rows carry
//     holder/workdir/branch/build/stage/TTL, so `yaver autorun build-bus
//     status` and the web/mobile surfaces can show WHO is building WHAT.
//     Same machine = same file = same bus. Cross-machine is a follow-up
//     (the Acquire API stays identical).
//
//  2. flock(2) sidecar files (`~/.yaver/build-bus/<key>.lock`, the
//     vault_lock_unix.go pattern): the zero-dependency fallback when the
//     store cannot open. flock is kernel-enforced and cross-process by
//     definition.
//
// Keying: `{app}@{target}` — e.g. medici.ai@testflight, yaver.io@npm,
// yaver.io@convex, yaver.io@cloudflare-web, yaver.io@go-agent,
// medici.ai@playstore. App distinguishes two projects shipping to the same
// channel; bare "@target" means the whole-machine channel slot.
//
// Modes:
//   - Wait (default for MCP): poll the holder; return when the lease is
//     free (or ctx done). The caller sees the BuildBusHeld details while
//     waiting.
//   - FailFast: return the structured BuildBusHeld error immediately so a
//     CLI can exit with a named code instead of queueing invisibly.
//
// Every acquire MUST be paired with a Release (defer) — a leaked lease
// expires via TTL+heartbeat, but a long stale lock on a hot channel is
// exactly the failure this bus exists to prevent.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// buildBusTTL is how long a lease lives without a heartbeat. Defaults for a
// typical archive+upload; heartbeats push it forward.
const buildBusTTL = 60 * time.Minute

// buildBusHeartbeatInterval is how often a held lease refreshes its TTL.
const buildBusHeartbeatInterval = 30 * time.Second

// buildBusWaitPollInterval is how often a Wait-mode acquire re-checks the
// holder.
const buildBusWaitPollInterval = 5 * time.Second

// BuildBusHeld is the structured "someone else owns this resource" result.
// It is the SIGNAL half of the failure contract: stable code + typed fields
// so every surface (MCP tool result, CLI exit, HTTP body, web/mobile
// banner) renders the same meaning without regexing prose.
type BuildBusHeld struct {
	Code        string `json:"code"`                   // "build_bus_held"
	Key         string `json:"key"`                    // "{app}@{target}"
	Holder      string `json:"holder,omitempty"`       // "hostname/pidN"
	Workdir     string `json:"workdir,omitempty"`      // checkout the holder builds from
	Branch      string `json:"branch,omitempty"`       // git branch being shipped
	Build       string `json:"build,omitempty"`        // CFBundleVersion / versionCode / sha
	Stage       string `json:"stage,omitempty"`        // archiving|exporting|uploading|...
	StartedAt   int64  `json:"started_at,omitempty"`   // unix seconds
	ExpiresAt   int64  `json:"expires_at,omitempty"`   // unix seconds
	WaitSeconds int64  `json:"wait_seconds,omitempty"` // TTL remaining
}

func (e *BuildBusHeld) Error() string {
	wait := ""
	if e.WaitSeconds > 0 {
		wait = fmt.Sprintf(" (~%dm left)", e.WaitSeconds/60)
	}
	holder := e.Holder
	if holder == "" {
		holder = "another session"
	}
	return fmt.Sprintf("%s is being built/deployed by %s (stage %s) since %s%s",
		e.Key, holder, e.Stage,
		time.Unix(e.StartedAt, 0).Format(time.RFC3339), wait)
}

// BuildBusAcquireMode controls what Acquire does when the resource is held.
type BuildBusAcquireMode int

const (
	// BuildBusWait polls the holder and returns once the lease is free.
	BuildBusWait BuildBusAcquireMode = iota
	// BuildBusFailFast returns the BuildBusHeld error immediately.
	BuildBusFailFast
)

// BuildBusStatus is a snapshot of a held lease (for status surfaces).
type BuildBusStatus struct {
	Key       string `json:"key"`
	Holder    string `json:"holder"`
	Workdir   string `json:"workdir"`
	Branch    string `json:"branch"`
	Build     string `json:"build"`
	Stage     string `json:"stage"`
	StartedAt int64  `json:"started_at"`
	ExpiresAt int64  `json:"expires_at"`
}

// buildBusKey builds the "{app}@{target}" lease key. App empty → the
// whole-machine channel slot ("@testflight").
func buildBusKey(app, target string) string {
	app = strings.TrimSpace(app)
	target = strings.TrimSpace(target)
	if target == "" {
		target = "unknown"
	}
	if app == "" {
		return "@" + target
	}
	return app + "@" + target
}

// errBuildBusNoStore is returned when the store is unavailable; callers
// fall back to flock.
var errBuildBusNoStore = errors.New("build bus: autorun store unavailable")

// ---- store-backed backend ---------------------------------------------

// buildBusStore is the store-backed implementation of the bus. It opens
// ~/.yaver/autoruns.db lazily and reuses it for the process lifetime.
type buildBusStore struct {
	mu sync.Mutex
	st *AutorunStore
}

var (
	buildBusStoreOnceMu sync.Mutex
	buildBusStoreOnceS  *buildBusStore
)

// globalBuildBus returns the process-wide bus. Opening the store is lazy:
// if it fails (no home, read-only FS), the flock backend is used instead.
func globalBuildBus() *buildBusStore {
	buildBusStoreOnceMu.Lock()
	defer buildBusStoreOnceMu.Unlock()
	if buildBusStoreOnceS != nil {
		return buildBusStoreOnceS
	}
	s := &buildBusStore{}
	// Opportunistic: opening the store is NOT a hard requirement (the flock
	// backend covers the no-store case), but when it works we get durable,
	// queryable, quota-aware leases.
	if st, err := openAutorunStore(); err == nil {
		s.st = st
	}
	buildBusStoreOnceS = s
	return s
}

// acquire acquires the lease for key. Returns (held != nil) when someone
// else owns it, or an error for store/IO failures. A store that cannot BEGIN
// (closed db, locked file) is treated as unavailable so callers fall back to
// the flock backend rather than failing the whole build.
func (b *buildBusStore) acquire(key, holder, workdir, branch, build, stage string, ttl time.Duration) (*BuildBusHeld, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.st == nil {
		return nil, errBuildBusNoStore
	}
	held, err := b.acquireLocked(key, holder, workdir, branch, build, stage, ttl)
	if err != nil && (errors.Is(err, sql.ErrConnDone) || strings.Contains(err.Error(), "database is closed")) {
		return nil, errBuildBusNoStore
	}
	return held, err
}

// acquireLocked claims the lease for key. The atomic primitive is a single
// INSERT OR IGNORE: SQLite enforces the target PRIMARY KEY, so exactly one
// concurrent acquirer's INSERT affects a row — every other one ignores.
// A "live row exists" read then distinguishes "someone else holds it" (→
// BuildBusHeld) from "the row is dead/expired" (→ take over). This is race-
// free where a read-then-write would double-claim under a single-writer conn
// (proven by TestBuildBusConcurrentRaceOneWinner: 20 goroutines, 1 winner).
func (b *buildBusStore) acquireLocked(key, holder, workdir, branch, build, stage string, ttl time.Duration) (*BuildBusHeld, error) {
	if ttl <= 0 {
		ttl = buildBusTTL
	}
	now := nowUnix()

	// Atomic claim: only the first acquirer for this key inserts a row.
	res, err := b.st.db.Exec(`INSERT OR IGNORE INTO build_leases(target, autorun_id, holder, workdir, branch, build_number, stage, started_at, updated_at, expires_at)
	  VALUES(?,?,?,?,?,?,?,?,?,?)`,
		key, holder, holder, workdir, nullStr(branch), nullStr(build), stage, now, now, now+int64(ttl.Seconds()))
	if err != nil {
		return nil, fmt.Errorf("build bus claim %s: %w", key, err)
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return nil, nil // we own it
	}

	// A row already exists — is it a live holder or a dead one we can take?
	// Single-conn serialisation makes the read AFTER the failed insert see the
	// row, and only the true holder passes the live check.
	var h BuildBusHeld
	var endedAt sql.NullInt64
	var existingAutorun string
	err = b.st.db.QueryRow(`SELECT autorun_id, holder, workdir, COALESCE(branch,''), COALESCE(build_number,''), stage, started_at, expires_at, ended_at
	  FROM build_leases WHERE target=?`, key).
		Scan(&existingAutorun, &h.Holder, &h.Workdir, &h.Branch, &h.Build, &h.Stage, &h.StartedAt, &h.ExpiresAt, &endedAt)
	if err != nil {
		return nil, fmt.Errorf("build bus read %s: %w", key, err)
	}
	live := !endedAt.Valid && h.ExpiresAt > now
	if live {
		h.Key = key
		h.Code = "build_bus_held"
		h.WaitSeconds = h.ExpiresAt - now
		return &h, nil
	}
	// Dead/expired → take over with an UPDATE guarded by the same expiry
	// predicate so a concurrent take-over can't both succeed.
	if _, err := b.st.db.Exec(`UPDATE build_leases SET autorun_id=?, holder=?, workdir=?, branch=?, build_number=?, stage=?, started_at=?, updated_at=?, expires_at=?, ended_at=NULL, outcome=NULL
	  WHERE target=? AND (ended_at IS NOT NULL OR expires_at <= ?)`,
		holder, holder, workdir, nullStr(branch), nullStr(build), stage, now, now, now+int64(ttl.Seconds()), key, now); err != nil {
		return nil, fmt.Errorf("build bus take-over %s: %w", key, err)
	}
	// The UPDATE may have matched 0 rows if another acquirer took it over
	// between our read and write — re-check who owns it now.
	var h2 BuildBusHeld
	var endedAt2 sql.NullInt64
	err = b.st.db.QueryRow(`SELECT holder, workdir, COALESCE(branch,''), COALESCE(build_number,''), stage, started_at, expires_at, ended_at
	  FROM build_leases WHERE target=?`, key).
		Scan(&h2.Holder, &h2.Workdir, &h2.Branch, &h2.Build, &h2.Stage, &h2.StartedAt, &h2.ExpiresAt, &endedAt2)
	if err != nil {
		return nil, fmt.Errorf("build bus re-read %s: %w", key, err)
	}
	if !endedAt2.Valid && h2.ExpiresAt > now && h2.Holder != holder {
		h2.Key = key
		h2.Code = "build_bus_held"
		h2.WaitSeconds = h2.ExpiresAt - now
		return &h2, nil
	}
	return nil, nil
}

func (b *buildBusStore) heartbeat(key, holder, stage string, ttl time.Duration) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.st == nil {
		return errBuildBusNoStore
	}
	return b.st.HeartbeatBuildLease(key, holder, stage, ttl)
}

func (b *buildBusStore) release(key, holder, outcome string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.st == nil {
		return errBuildBusNoStore
	}
	return b.st.ReleaseBuildLease(key, holder, outcome)
}

func (b *buildBusStore) current(key string) (*BuildBusStatus, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.st == nil {
		return nil, errBuildBusNoStore
	}
	h, err := b.st.CurrentBuildLease(key)
	if err != nil || h == nil {
		return nil, err
	}
	return &BuildBusStatus{
		Key: key, Holder: h.Holder, Workdir: h.Workdir, Branch: h.Branch,
		Build: h.Build, Stage: h.Stage, StartedAt: h.StartedAt, ExpiresAt: h.ExpiresAt,
	}, nil
}

// ---- flock backend -----------------------------------------------------

// buildBusLockDir is where flock sidecars live. Per-key file + flock(2):
// kernel-enforced, cross-process, works with no store.
func buildBusLockDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", fmt.Errorf("build bus: resolve home: %v", err)
	}
	dir := filepath.Join(home, ".yaver", "build-bus")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// openFlock opens (creating) the per-key lock file and takes a NON-BLOCKING
// exclusive flock. Returns (nil, nil) when acquired — the caller MUST keep
// the *os.File alive for the lease duration and release with LOCK_UN.
// Returns (nil, held=true) when another process owns it.
func openFlock(key string) (f *os.File, held bool, err error) {
	dir, err := buildBusLockDir()
	if err != nil {
		return nil, false, err
	}
	lockPath := filepath.Join(dir, sanitizeBusKey(key)+".lock")
	// Platform split lives in buildbus_lock_{unix,windows}.go: unix takes a
	// NON-BLOCKING exclusive flock (EWOULDBLOCK => held by a sibling),
	// windows degrades to always-free (the store row is the real authority).
	// Direct unix.Flock here broke the windows cross-compile and killed the
	// 5th-of-5 release target on 2026-08-10.
	locked, held, lerr := openBusFlock(lockPath)
	if lerr != nil {
		return nil, false, lerr
	}
	if held {
		return nil, true, nil
	}
	return locked, false, nil
}

// sanitizeBusKey makes a lease key safe as a filename.
func sanitizeBusKey(key string) string {
	var b strings.Builder
	for i := 0; i < len(key); i++ {
		c := key[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_' || c == '@' {
			b.WriteByte(c)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

// ---- lease handle ------------------------------------------------------

// BuildBusLease is a held lease. Call Release (defer) to free it; the
// background heartbeat keeps it alive until then.
type BuildBusLease struct {
	Key       string
	Holder    string
	Workdir   string
	Branch    string
	Build     string
	Stage     string
	store     *buildBusStore
	flockFile *os.File // non-nil when the flock backend is in use
	done      chan struct{}
	heartbeat chan struct{}
	closeOnce sync.Once
	mu        sync.Mutex
	ttl       time.Duration
}

// Release frees the lease (idempotent). Outcome is recorded for the store
// backend; flock just unlocks.
func (l *BuildBusLease) Release(outcome string) {
	l.closeOnce.Do(func() {
		close(l.done)
		<-l.heartbeat
		l.mu.Lock()
		store, key, holder := l.store, l.Key, l.Holder
		flockFile := l.flockFile
		l.mu.Unlock()
		if store != nil && store.st != nil {
			_ = store.release(key, holder, outcome)
		}
		if flockFile != nil {
			closeBusFlock(flockFile)
		}
	})
}

// SetStage reports progress on a held lease (store backend updates the row).
func (l *BuildBusLease) SetStage(stage string) {
	l.mu.Lock()
	l.Stage = stage
	store, key, holder, ttl := l.store, l.Key, l.Holder, l.ttl
	l.mu.Unlock()
	if store != nil && store.st != nil {
		_ = store.heartbeat(key, holder, stage, ttl)
	}
}

func (l *BuildBusLease) heartbeatLoop() {
	defer close(l.heartbeat)
	t := time.NewTicker(buildBusHeartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-l.done:
			return
		case <-t.C:
			l.mu.Lock()
			store, key, holder, stage, ttl := l.store, l.Key, l.Holder, l.Stage, l.ttl
			l.mu.Unlock()
			if store != nil && store.st != nil {
				_ = store.heartbeat(key, holder, stage, ttl)
			}
		}
	}
}

// buildBusHolder describes who this process is, for the holder column.
func buildBusHolder() string {
	host, _ := os.Hostname()
	pid := os.Getpid()
	if host == "" {
		host = "unknown"
	}
	return fmt.Sprintf("%s/pid%d", host, pid)
}

// ---- public API --------------------------------------------------------

// AcquireBuildBus is the single entry point every build/upload path uses.
//
//	ctx     — cancel to abandon a Wait.
//	app     — project name ("medici.ai"); empty for whole-machine channels.
//	target  — the channel ("testflight", "playstore", "npm", "convex",
//	          "cloudflare-web", "go-agent", ...).
//	workdir — the checkout the build runs from (shown in status).
//	build   — CFBundleVersion / versionCode / sha (shown in status).
//	mode    — Wait or FailFast.
//
// Returns (lease, nil, nil) when acquired — call lease.Release in defer.
// Returns (nil, held, nil) when someone else owns it.
// Returns (nil, nil, err) on infrastructure failure.
func AcquireBuildBus(ctx context.Context, app, target, workdir, branch, build string, mode BuildBusAcquireMode) (*BuildBusLease, *BuildBusHeld, error) {
	key := buildBusKey(app, target)
	holder := buildBusHolder()

	bus := globalBuildBus()
	for {
		held, err := bus.acquire(key, holder, workdir, branch, build, "preparing", buildBusTTL)
		switch {
		case err == nil && held == nil:
			return newStoreLease(bus, key, holder, workdir, branch, build, "preparing", buildBusTTL), nil, nil
		case err == nil && held != nil:
			if mode == BuildBusFailFast {
				return nil, held, nil
			}
			select {
			case <-ctx.Done():
				held.Code = "build_bus_wait_timeout"
				return nil, held, nil
			case <-time.After(buildBusWaitPollInterval):
				continue
			}
		case errors.Is(err, errBuildBusNoStore):
			f, flockHeld, ferr := openFlock(key)
			if ferr != nil {
				return nil, nil, fmt.Errorf("build bus %s: %w", key, ferr)
			}
			if flockHeld {
				if mode == BuildBusFailFast {
					return nil, &BuildBusHeld{Code: "build_bus_held", Key: key, Holder: "another session", Stage: "unknown"}, nil
				}
				select {
				case <-ctx.Done():
					return nil, &BuildBusHeld{Code: "build_bus_wait_timeout", Key: key}, nil
				case <-time.After(buildBusWaitPollInterval):
					continue
				}
			}
			return newFlockLease(key, holder, f), nil, nil
		default:
			return nil, nil, fmt.Errorf("build bus %s: %w", key, err)
		}
	}
}

func newStoreLease(bus *buildBusStore, key, holder, workdir, branch, build, stage string, ttl time.Duration) *BuildBusLease {
	l := &BuildBusLease{
		Key: key, Holder: holder, Workdir: workdir, Branch: branch, Build: build,
		Stage: stage, store: bus, ttl: ttl,
		done: make(chan struct{}), heartbeat: make(chan struct{}),
	}
	go l.heartbeatLoop()
	return l
}

func newFlockLease(key, holder string, f *os.File) *BuildBusLease {
	l := &BuildBusLease{
		Key: key, Holder: holder, flockFile: f,
		done: make(chan struct{}), heartbeat: make(chan struct{}),
	}
	go l.heartbeatLoop()
	return l
}

// BuildBusStatusAll returns every live lease (for `yaver autorun build-bus
// status` and the /build-bus HTTP surface).
func BuildBusStatusAll() ([]BuildBusStatus, error) {
	bus := globalBuildBus()
	bus.mu.Lock()
	defer bus.mu.Unlock()
	if bus.st == nil {
		return nil, nil
	}
	return bus.st.ListBuildLeases()
}

// BuildBusCurrent returns the live holder of one key, or nil when free.
func BuildBusCurrent(app, target string) (*BuildBusStatus, error) {
	return globalBuildBus().current(buildBusKey(app, target))
}
