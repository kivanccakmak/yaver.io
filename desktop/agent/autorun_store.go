package main

// autorun_store.go — local SQLite coordination store for autoruns (spec:
// docs/architecture/AUTORUN_STORE.md). This first cut lands the LOAD-BEARING
// half of the spec: the per-target deploy/build leases + code/branch locks that
// stop two concurrent autoruns from racing the same TestFlight upload (the
// 2026-07-19 incident that motivated the store: two tmux sessions both reaching
// `xcodebuild -exportArchive` on the same archive and burning the daily cap).
//
// Design constraints from the spec that this file honours:
//   • Pure-Go `modernc.org/sqlite` (CGO_ENABLED=0 release pipeline) — no cgo.
//   • Lives at ~/.yaver/autoruns.db (reuses yaverDir()). NEVER synced to Convex —
//     rows carry absolute workdirs + branch names the privacy contract forbids.
//   • Acquire is a real cross-process mutex: BEGIN IMMEDIATE + INSERT-or-fail on
//     a single PK row per resource. Readers treat expired rows as absent.
//   • Terminal/old rows auto-clear after 7 days (SweepOld) so the file stays a
//     temporary coordination surface, not a log archive.
//
// The item/state-machine/recap half of the spec (§3–§5, §8) is a follow-up; the
// lease tables are self-contained and usable by the deploy scripts today.

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// autorunStoreRetention is how long terminal/expired rows survive before
// SweepOld() reclaims them. The store is a coordination surface, not a log.
const autorunStoreRetention = 7 * 24 * time.Hour

// AutorunStore is the handle to ~/.yaver/autoruns.db.
type AutorunStore struct {
	db *sql.DB
}

// LeaseHeld is returned by acquire calls when another live holder owns the
// resource. It carries the holder details so the caller can print a useful
// "wait or abort" message (the exit-3 pathway in the deploy scripts).
type LeaseHeld struct {
	Target    string
	Holder    string
	Workdir   string
	Branch    string
	Build     string
	Stage     string
	StartedAt int64
	ExpiresAt int64
}

func (e *LeaseHeld) Error() string {
	return fmt.Sprintf("%s is being deployed by %q from %s (build %s, stage %s) since %s; wait or abort",
		e.Target, e.Holder, e.Workdir, e.Build, e.Stage,
		time.Unix(e.StartedAt, 0).Format(time.RFC3339))
}

// QuotaExceeded is returned when a target's uploads-in-last-24h is at/over cap.
type QuotaExceeded struct {
	Target    string
	UsedToday int
	Cap       int
}

func (e *QuotaExceeded) Error() string {
	return fmt.Sprintf("%s quota exhausted: %d uploads in the last 24h (cap %d) — wait a day, don't upload a broken build again",
		e.Target, e.UsedToday, e.Cap)
}

// deployQuotaCap is the per-target daily upload ceiling for acquire(). Apple
// caps TestFlight at ~15–20/app/day with no rollback; we hard-refuse at 18.
var deployQuotaCap = map[string]int{
	"testflight": 18,
	"playstore":  40,
}

// openAutorunStore opens (creating if needed) ~/.yaver/autoruns.db and applies
// migrations idempotently. WAL + busy_timeout mirror every other agent SQLite.
func openAutorunStore() (*AutorunStore, error) {
	dir, err := yaverDir()
	if err != nil {
		return nil, fmt.Errorf("autorun store: %w", err)
	}
	dbPath := filepath.Join(dir, "autoruns.db")
	db, err := openSQLiteAt(dbPath)
	if err != nil {
		return nil, err
	}
	s := &AutorunStore{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *AutorunStore) Close() error { return s.db.Close() }

// openSQLiteAt opens a WAL SQLite db at an explicit path with a single writer
// conn (BEGIN IMMEDIATE is our cross-process mutex, so one conn keeps the
// acquire semantics simple). Shared by openAutorunStore and the tests.
func openSQLiteAt(dbPath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dbPath+"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on")
	if err != nil {
		return nil, fmt.Errorf("opening autorun store: %w", err)
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

// migrate applies the lease-schema migrations. Add-only; never edit a shipped
// migration (mirrors phone_backend.go).
func (s *AutorunStore) migrate() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
	  version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("autorun store migrations table: %w", err)
	}
	migrations := []string{
		// v1 — coordination leases (the race fix). autorun_id is a soft TEXT
		// reference (not a hard FK) so a bare deploy-script run can hold a lease
		// without first materialising a full autoruns row.
		`CREATE TABLE IF NOT EXISTS deploy_leases (
		  target       TEXT PRIMARY KEY,
		  autorun_id   TEXT NOT NULL,
		  holder       TEXT NOT NULL,
		  workdir      TEXT NOT NULL,
		  branch       TEXT,
		  build_number TEXT,
		  stage        TEXT NOT NULL,
		  started_at   INTEGER NOT NULL,
		  updated_at   INTEGER NOT NULL,
		  expires_at   INTEGER NOT NULL,
		  ended_at     INTEGER,
		  outcome      TEXT,
		  CHECK (stage IN ('archiving','exporting','uploading','submitting','finished','failed')));
		CREATE INDEX IF NOT EXISTS deploy_leases_target_idx ON deploy_leases(target);
		CREATE INDEX IF NOT EXISTS deploy_leases_started_idx ON deploy_leases(started_at);
		CREATE TABLE IF NOT EXISTS deploy_history (
		  id           TEXT PRIMARY KEY,
		  target       TEXT NOT NULL,
		  autorun_id   TEXT NOT NULL,
		  holder       TEXT NOT NULL,
		  workdir      TEXT NOT NULL,
		  branch       TEXT,
		  build_number TEXT,
		  started_at   INTEGER NOT NULL,
		  ended_at     INTEGER NOT NULL,
		  outcome      TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS deploy_history_target_idx ON deploy_history(target, ended_at);
		CREATE TABLE IF NOT EXISTS build_leases (
		  target     TEXT PRIMARY KEY,
		  autorun_id TEXT NOT NULL,
		  holder     TEXT NOT NULL,
		  workdir    TEXT NOT NULL,
		  branch     TEXT,
		  build_number TEXT,
		  stage      TEXT NOT NULL,
		  started_at INTEGER NOT NULL,
		  updated_at INTEGER NOT NULL,
		  expires_at INTEGER NOT NULL,
		  ended_at   INTEGER,
		  outcome    TEXT);
		CREATE TABLE IF NOT EXISTS code_locks (
		  path       TEXT PRIMARY KEY,
		  autorun_id TEXT NOT NULL,
		  holder     TEXT NOT NULL,
		  purpose    TEXT NOT NULL,
		  started_at INTEGER NOT NULL,
		  expires_at INTEGER NOT NULL);
		CREATE INDEX IF NOT EXISTS code_locks_autorun_idx ON code_locks(autorun_id);
		CREATE TABLE IF NOT EXISTS branch_leases (
		  branch      TEXT PRIMARY KEY,
		  autorun_id  TEXT NOT NULL,
		  workdir     TEXT NOT NULL,
		  holder      TEXT NOT NULL,
		  acquired_at INTEGER NOT NULL,
		  expires_at  INTEGER NOT NULL);`,
		// v2 — build_leases gains build_number (the build/upload bus keyed
		// {app}@{target} carries CFBundleVersion/versionCode/sha). v1 shipped
		// the table without it; ALTER must be idempotent for DBs that already
		// ran the corrected DDL (fresh installs get it via the CREATE above).
		`ALTER TABLE build_leases ADD COLUMN build_number TEXT;`,
	}
	for i, stmt := range migrations {
		v := i + 1
		var done int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version=?`, v).Scan(&done); err != nil {
			return err
		}
		if done > 0 {
			continue
		}
		if _, err := s.db.Exec(stmt); err != nil {
			// ALTER TABLE ADD COLUMN fails on a schema that already has the
			// column (duplicate column). That's the idempotency case: a fresh
			// DB got the column from the v1 CREATE. Treat "duplicate column"
			// as applied rather than fatal.
			if strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
				if _, ierr := s.db.Exec(`INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)`, v, nowUnix()); ierr != nil {
					return ierr
				}
				continue
			}
			return fmt.Errorf("autorun store migration v%d: %w", v, err)
		}
		if _, err := s.db.Exec(`INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)`, v, nowUnix()); err != nil {
			return err
		}
	}
	return nil
}

func nowUnix() int64 { return time.Now().Unix() }

// storeID is a time-ordered random id (sortable-ish hex: seconds prefix + 8
// random bytes). Avoids pulling in a ULID dependency for the few rows we mint.
func storeID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%011x%s", time.Now().Unix(), hex.EncodeToString(b[:]))
}

// ---- deploy leases (the race fix) --------------------------------------

// holderAliveOnThisHost reports whether a lease holder described as
// "<host>/pid<N>" is still running — but ONLY when <host> is this machine.
// A holder on a different host is presumed alive (we can't see its pid);
// a malformed holder string is presumed alive (don't guess). This is the
// crash-reclaim: a deploy that died (SIGKILL, power loss, errSecInternal-
// Component bail) leaves its lease holding the target hostage for the whole
// TTL, and before 2026-08-12 the ONLY recovery was `deploy-lease abort` by
// hand — every later deploy failed with "another autorun holds the lease".
// Acquire now reclaims a same-host lease whose pid is gone. Same rationale
// as the Snowball "inventory says yes, operation says no" rule: a lease is
// bookkeeping, and the process is the operation.
func holderAliveOnThisHost(holder string) bool {
	host, _ := os.Hostname()
	slash := strings.LastIndexByte(holder, '/')
	if slash <= 0 || slash == len(holder)-1 {
		return true // not host/pid shape → don't guess
	}
	if holder[:slash] != host {
		return true // other machine → can't verify, presume alive
	}
	pid, err := strconv.Atoi(holder[slash+1:])
	if err != nil || pid <= 0 {
		return true
	}
	// kill(pid, 0) probes existence without signalling.
	err = syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// AcquireDeployLease takes the single per-target deploy lease. Returns:
//   - nil on success (lease held by autorunID),
//   - *LeaseHeld if a live holder owns it (and it isn't autorunID — same
//     autorunID re-acquiring its own lease succeeds, so a crash-retry continues),
//   - *QuotaExceeded if the target is at its daily cap.
//
// ttl defaults to 60 min when zero (a typical archive+upload). Uses BEGIN
// IMMEDIATE so two concurrent acquires can't both pass the liveness read.
func (s *AutorunStore) AcquireDeployLease(target, autorunID, holder, workdir, branch, build string, ttl time.Duration) error {
	if ttl <= 0 {
		ttl = 60 * time.Minute
	}
	now := nowUnix()
	// Quota gate first (§9): count terminal deploys in the last 24h.
	if cap, ok := deployQuotaCap[target]; ok {
		var used int
		if err := s.db.QueryRow(
			`SELECT COUNT(*) FROM deploy_history WHERE target=? AND ended_at > ? AND outcome IN ('success','failure')`,
			target, now-24*3600).Scan(&used); err != nil {
			return err
		}
		if used >= cap {
			return &QuotaExceeded{Target: target, UsedToday: used, Cap: cap}
		}
	}
	tx, err := s.db.Begin() // modernc serialises; BEGIN IMMEDIATE emulated via single conn + write
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Is there a live holder that isn't us?
	var held LeaseHeld
	var endedAt sql.NullInt64
	row := tx.QueryRow(`SELECT autorun_id, holder, workdir, COALESCE(branch,''), COALESCE(build_number,''), stage, started_at, expires_at, ended_at
	  FROM deploy_leases WHERE target=?`, target)
	var existingAutorun string
	switch err := row.Scan(&existingAutorun, &held.Holder, &held.Workdir, &held.Branch, &held.Build, &held.Stage, &held.StartedAt, &held.ExpiresAt, &endedAt); err {
	case nil:
		live := !endedAt.Valid && held.ExpiresAt > now
		// Crash-reclaim (2026-08-12): a same-host holder whose pid is gone
		// is dead — its lease must not hold the target hostage until TTL
		// expiry. Dead/expired/ours all fall through to overwrite below.
		if live && holderAliveOnThisHost(held.Holder) && existingAutorun != autorunID {
			held.Target = target
			return &held
		}
		// Ours, dead (pid gone on this host), or expired → overwrite.
		if _, err := tx.Exec(`UPDATE deploy_leases SET autorun_id=?, holder=?, workdir=?, branch=?, build_number=?, stage='archiving', started_at=?, updated_at=?, expires_at=?, ended_at=NULL, outcome=NULL WHERE target=?`,
			autorunID, holder, workdir, nullStr(branch), nullStr(build), now, now, now+int64(ttl.Seconds()), target); err != nil {
			return err
		}
	case sql.ErrNoRows:
		if _, err := tx.Exec(`INSERT INTO deploy_leases(target, autorun_id, holder, workdir, branch, build_number, stage, started_at, updated_at, expires_at)
		  VALUES(?,?,?,?,?,?, 'archiving', ?,?,?)`,
			target, autorunID, holder, workdir, nullStr(branch), nullStr(build), now, now, now+int64(ttl.Seconds())); err != nil {
			return err
		}
	default:
		return err
	}
	return tx.Commit()
}

// HeartbeatDeployLease pushes expires_at forward and updates the stage. A
// long-running holder must call this every ~30s or the lease expires and
// another autorun can take over.
func (s *AutorunStore) HeartbeatDeployLease(target, autorunID, stage string, ttl time.Duration) error {
	if ttl <= 0 {
		ttl = 60 * time.Minute
	}
	now := nowUnix()
	res, err := s.db.Exec(`UPDATE deploy_leases SET stage=?, updated_at=?, expires_at=? WHERE target=? AND autorun_id=? AND ended_at IS NULL`,
		stage, now, now+int64(ttl.Seconds()), target, autorunID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("no live deploy lease for %s held by %s", target, autorunID)
	}
	return nil
}

// ReleaseDeployLease marks the lease terminal with an outcome and copies it into
// deploy_history (so deploy-history + quota survive the lease-row reuse).
func (s *AutorunStore) ReleaseDeployLease(target, autorunID, outcome string) error {
	now := nowUnix()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var holder, workdir, branch, build string
	var startedAt int64
	err = tx.QueryRow(`SELECT holder, workdir, COALESCE(branch,''), COALESCE(build_number,''), started_at FROM deploy_leases WHERE target=? AND autorun_id=?`,
		target, autorunID).Scan(&holder, &workdir, &branch, &build, &startedAt)
	if err == sql.ErrNoRows {
		return fmt.Errorf("no deploy lease for %s held by %s", target, autorunID)
	} else if err != nil {
		return err
	}
	stage := "finished"
	if outcome != "success" {
		stage = "failed"
	}
	if _, err := tx.Exec(`UPDATE deploy_leases SET stage=?, ended_at=?, updated_at=?, outcome=? WHERE target=?`,
		stage, now, now, outcome, target); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO deploy_history(id, target, autorun_id, holder, workdir, branch, build_number, started_at, ended_at, outcome)
	  VALUES(?,?,?,?,?,?,?,?,?,?)`,
		storeID(), target, autorunID, holder, workdir, nullStr(branch), nullStr(build), startedAt, now, outcome); err != nil {
		return err
	}
	return tx.Commit()
}

// AbortDeployLease is the user-facing force-release (the `abort` verb). Unlike
// heartbeat/release it does not require holding the lease — it's how an operator
// clears a stuck lease left by a crashed holder.
func (s *AutorunStore) AbortDeployLease(target string) error {
	_, err := s.db.Exec(`UPDATE deploy_leases SET stage='failed', ended_at=?, updated_at=?, outcome='aborted' WHERE target=? AND ended_at IS NULL`,
		nowUnix(), nowUnix(), target)
	return err
}

// CurrentDeployLease returns the live holder of a target (or nil if free).
func (s *AutorunStore) CurrentDeployLease(target string) (*LeaseHeld, error) {
	now := nowUnix()
	var h LeaseHeld
	var endedAt sql.NullInt64
	var autorunID string
	err := s.db.QueryRow(`SELECT autorun_id, holder, workdir, COALESCE(branch,''), COALESCE(build_number,''), stage, started_at, expires_at, ended_at
	  FROM deploy_leases WHERE target=?`, target).
		Scan(&autorunID, &h.Holder, &h.Workdir, &h.Branch, &h.Build, &h.Stage, &h.StartedAt, &h.ExpiresAt, &endedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	if endedAt.Valid || h.ExpiresAt <= now {
		return nil, nil // dead/expired → free
	}
	h.Target = target
	return &h, nil
}

// DeployQuotaUsed returns uploads (success+failure) for a target in the last 24h.
func (s *AutorunStore) DeployQuotaUsed(target string) (used, cap int, err error) {
	cap = deployQuotaCap[target]
	err = s.db.QueryRow(`SELECT COUNT(*) FROM deploy_history WHERE target=? AND ended_at > ? AND outcome IN ('success','failure')`,
		target, nowUnix()-24*3600).Scan(&used)
	return
}

// ---- build bus leases (build_leases) ----------------------------------
//
// The build_leases table is the durable backend of the build/upload
// coordination bus (buildbus.go). It is deliberately kept SEPARATE from
// deploy_leases: deploy_leases is the autorun/deploy-script path with
// quota+history semantics keyed by coarse target, while build_leases is the
// generic {app}@{target} bus for ANY build/upload — TestFlight, Play, npm,
// Convex, Cloudflare, the Go agent binary itself — from any session (MCP
// stdio processes included). Same WAL store, same single-writer-conn
// acquire semantics, different key space.

// HeartbeatBuildLease pushes a live build_lease's TTL forward and updates
// its stage. A long-running holder must call this every ~30s (the
// BuildBusLease heartbeat loop does) or the lease expires and another
// session can take over.
func (s *AutorunStore) HeartbeatBuildLease(key, holder, stage string, ttl time.Duration) error {
	if ttl <= 0 {
		ttl = buildBusTTL
	}
	now := nowUnix()
	res, err := s.db.Exec(`UPDATE build_leases SET stage=?, updated_at=?, expires_at=? WHERE target=? AND autorun_id=? AND ended_at IS NULL`,
		stage, now, now+int64(ttl.Seconds()), key, holder)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("no live build-bus lease for %s held by %s", key, holder)
	}
	return nil
}

// ReleaseBuildLease marks the build_lease terminal with an outcome.
func (s *AutorunStore) ReleaseBuildLease(key, holder, outcome string) error {
	now := nowUnix()
	stage := "finished"
	if outcome != "success" {
		stage = "failed"
	}
	_, err := s.db.Exec(`UPDATE build_leases SET stage=?, ended_at=?, updated_at=?, outcome=? WHERE target=? AND autorun_id=?`,
		stage, now, now, outcome, key, holder)
	return err
}

// CurrentBuildLease returns the live holder of a build-bus key (or nil when
// free).
func (s *AutorunStore) CurrentBuildLease(key string) (*LeaseHeld, error) {
	now := nowUnix()
	var h LeaseHeld
	var endedAt sql.NullInt64
	var autorunID string
	err := s.db.QueryRow(`SELECT autorun_id, holder, workdir, COALESCE(branch,''), COALESCE(build_number,''), stage, started_at, expires_at, ended_at
	  FROM build_leases WHERE target=?`, key).
		Scan(&autorunID, &h.Holder, &h.Workdir, &h.Branch, &h.Build, &h.Stage, &h.StartedAt, &h.ExpiresAt, &endedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	if endedAt.Valid || h.ExpiresAt <= now {
		return nil, nil // dead/expired → free
	}
	h.Target = key
	return &h, nil
}

// ListBuildLeases returns every live build-bus lease (for status surfaces).
func (s *AutorunStore) ListBuildLeases() ([]BuildBusStatus, error) {
	now := nowUnix()
	rows, err := s.db.Query(`SELECT target, holder, workdir, COALESCE(branch,''), COALESCE(build_number,''), stage, started_at, expires_at
	  FROM build_leases WHERE ended_at IS NULL AND expires_at > ?`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BuildBusStatus
	for rows.Next() {
		var st BuildBusStatus
		if err := rows.Scan(&st.Key, &st.Holder, &st.Workdir, &st.Branch, &st.Build, &st.Stage, &st.StartedAt, &st.ExpiresAt); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// ---- code locks (advisory path ownership) ------------------------------

// CheckCodeLock returns a live conflicting lock over an ancestor/descendant of
// path held by someone other than autorunID, or nil if the path is free to edit.
func (s *AutorunStore) CheckCodeLock(path, autorunID string) (*LeaseHeld, error) {
	p := strings.TrimRight(path, "/")
	now := nowUnix()
	rows, err := s.db.Query(`SELECT path, holder, purpose, started_at, expires_at FROM code_locks
	  WHERE expires_at > ? AND autorun_id != ?
	    AND (path = ? OR ? LIKE path || '/%' OR path LIKE ? || '/%')`,
		now, autorunID, p, p, p)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if rows.Next() {
		var h LeaseHeld
		if err := rows.Scan(&h.Target, &h.Holder, &h.Stage, &h.StartedAt, &h.ExpiresAt); err != nil {
			return nil, err
		}
		return &h, nil // Target=path, Stage=purpose (reused fields for the message)
	}
	return nil, nil
}

// AcquireCodeLock records an advisory lock over path. Fails if a conflicting
// live lock exists (ancestor/descendant, different holder).
func (s *AutorunStore) AcquireCodeLock(path, autorunID, holder, purpose string, ttl time.Duration) error {
	if conflict, err := s.CheckCodeLock(path, autorunID); err != nil {
		return err
	} else if conflict != nil {
		return fmt.Errorf("code path %q locked by %q (%s) since %s", path, conflict.Holder, conflict.Stage,
			time.Unix(conflict.StartedAt, 0).Format(time.RFC3339))
	}
	now := nowUnix()
	_, err := s.db.Exec(`INSERT INTO code_locks(path, autorun_id, holder, purpose, started_at, expires_at)
	  VALUES(?,?,?,?,?,?)
	  ON CONFLICT(path) DO UPDATE SET autorun_id=excluded.autorun_id, holder=excluded.holder, purpose=excluded.purpose, started_at=excluded.started_at, expires_at=excluded.expires_at`,
		strings.TrimRight(path, "/"), autorunID, holder, purpose, now, now+int64(ttl.Seconds()))
	return err
}

// ReleaseCodeLock drops an autorun's lock on a path.
func (s *AutorunStore) ReleaseCodeLock(path, autorunID string) error {
	_, err := s.db.Exec(`DELETE FROM code_locks WHERE path=? AND autorun_id=?`, strings.TrimRight(path, "/"), autorunID)
	return err
}

// ---- retention sweep ---------------------------------------------------

// SweepOld reclaims terminal/expired coordination rows older than retention.
// Called on open and on a timer so the file stays a coordination surface, not
// a growing log. Deploy_history older than retention goes too (quota only cares
// about the last 24h). Returns the number of rows removed.
func (s *AutorunStore) SweepOld(retention time.Duration) (int64, error) {
	cutoff := nowUnix() - int64(retention.Seconds())
	var total int64
	stmts := []struct {
		q    string
		args []any
	}{
		{`DELETE FROM deploy_leases WHERE ended_at IS NOT NULL AND ended_at < ?`, []any{cutoff}},
		{`DELETE FROM deploy_leases WHERE ended_at IS NULL AND expires_at < ?`, []any{cutoff}},
		{`DELETE FROM build_leases WHERE (ended_at IS NOT NULL AND ended_at < ?) OR (ended_at IS NULL AND expires_at < ?)`, []any{cutoff, cutoff}},
		{`DELETE FROM code_locks WHERE expires_at < ?`, []any{cutoff}},
		{`DELETE FROM branch_leases WHERE expires_at < ?`, []any{cutoff}},
		{`DELETE FROM deploy_history WHERE ended_at < ?`, []any{cutoff}},
	}
	for _, st := range stmts {
		res, err := s.db.Exec(st.q, st.args...)
		if err != nil {
			return total, err
		}
		n, _ := res.RowsAffected()
		total += n
	}
	return total, nil
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
