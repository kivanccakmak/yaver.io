package main

// devserver_child_registry.go — a dev-server child that outlives the agent must
// still be findable.
//
// ── The incident (2026-07-25) ────────────────────────────────────────────────
//
// A day of browser-lane testing on the Mac mini left FOUR live Expo Web
// siblings behind — ports 19006, 19007, 19008 and 8087, every one of them
// answering 200, none of them known to the running agent:
//
//   64115 node .../yaver-todo-rn/node_modules/.bin/expo start --web --port 19007
//   65739 node .../yaver.io/mobile/node_modules/.bin/expo start --web --port 19006
//   74050 node .../yaver-todo-rn/node_modules/.bin/expo start --web --port 8087
//   74246 node .../yaver-todo-rn/node_modules/.bin/expo start --web --port 19008
//
// Nobody leaked them by forgetting to call Stop. They leaked because
// `setProcGroup` deliberately puts each child in its OWN process group (so a
// group-kill reaps metro's grandchildren instead of just the npx shell) — and
// that same isolation means the child SURVIVES the agent. Restart the agent,
// hot-swap the binary, `kill -9` a wedged daemon, and every dev child keeps
// running with nothing left that knows its PID.
//
// The visible damage is not "a stray process". It is the port drift: the next
// start finds 19006 busy, honestly substitutes 19007, then 19008 — one leaked
// port per agent restart. The machine reports itself busier than it is, which is
// the same "inventory says yes, operation says no" shape as a claimed simulator
// with no viewer. And a user watching a preview served by yesterday's orphan
// edits their source and sees nothing change, because the process serving them
// is watching a different cache dir.
//
// ── The rule ─────────────────────────────────────────────────────────────────
//
// Anything spawned into its own process group gets written down BEFORE it can be
// orphaned, and reaped on the next start. Persisted state is the only thing that
// survives the crash that causes the leak — in-memory tracking cannot, by
// definition, clean up after a process that died holding it.
//
// ── The safety guard that matters ────────────────────────────────────────────
//
// PIDs are recycled. A stale record whose PID now belongs to the user's editor
// must never be killed, so reaping NEVER trusts the number: it reads the live
// process's argv and requires the recorded Match substring to still be there.
// Probe the real capability, not the proxy — a PID is a proxy for identity, argv
// is the identity.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// devChildRegistryFile lives beside config.json in ~/.yaver. Local-only: it
// holds absolute workDirs, which is fine on disk and forbidden in Convex.
const devChildRegistryFile = "dev-children.json"

// devChildRecord is one spawned-and-detached dev process.
type devChildRecord struct {
	PID   int    `json:"pid"`
	Port  int    `json:"port"`
	Kind  string `json:"kind"`  // "expo-web", "metro", "flutter", "next", …
	Match string `json:"match"` // comma-separated substrings that must ALL still appear in the live argv

	// Argv is the child's ACTUAL command line, read once at record time.
	//
	// Added 2026-08-03 after the needle-only identity check failed in the
	// direction nobody guards against: it spared an orphan forever. See
	// RecordDevChild for the measurement. An exact argv match is a stronger
	// identity proof than substrings anyway — a recycled PID would have to be
	// running the byte-identical command line to be mistaken for this one.
	// Empty on records written by older agents, which fall back to Match.
	Argv string `json:"argv,omitempty"`

	WorkDir string `json:"workDir"` // for the log line, so the operator knows whose it was
	Started string `json:"startedAt"`
}

var devChildRegistryMu sync.Mutex

func devChildRegistryPath() (string, error) {
	dir, err := yaverDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, devChildRegistryFile), nil
}

func loadDevChildren() []devChildRecord {
	path, err := devChildRegistryPath()
	if err != nil {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var recs []devChildRecord
	if err := json.Unmarshal(raw, &recs); err != nil {
		// A corrupt registry must not wedge startup — the worst case of losing
		// it is one more generation of orphans, which is the status quo.
		log.Printf("[dev-children] registry unreadable (%v) — starting a fresh one", err)
		return nil
	}
	return recs
}

func saveDevChildren(recs []devChildRecord) {
	path, err := devChildRegistryPath()
	if err != nil {
		return
	}
	raw, err := json.MarshalIndent(recs, "", " ")
	if err != nil {
		return
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		log.Printf("[dev-children] could not persist registry: %v", err)
	}
}

// RecordDevChild writes a spawned child down so a future agent can reap it.
// Called immediately after cmd.Start() — before anything that can panic, exit,
// or be killed, because a record written late is a record that isn't there when
// it's needed.
func RecordDevChild(rec devChildRecord) {
	if rec.PID <= 0 || strings.TrimSpace(rec.Match) == "" {
		// No match string means we could never verify identity, and a reaper
		// that kills on PID alone is more dangerous than the leak.
		return
	}
	if rec.Started == "" {
		rec.Started = time.Now().UTC().Format(time.RFC3339)
	}

	// ── PROVE THE NEEDLE MATCHES NOW, OR IT NEVER WILL ────────────────────────
	//
	// The identity guard was written to stop the reaper killing a recycled PID.
	// It failed in the direction nobody thinks to check: it SPARED an orphan
	// forever, and kept sparing it.
	//
	// Measured on ubuntu-4gb, 2026-08-03, from the box's own journal:
	//
	//   pid 4170444 · :8088 — a stale record claims this PID is a expo, but the
	//   live process is something else · pid 4170444 is no longer expo (argv
	//   does not match "npx,8088") — left alone (spared)
	//
	// The needle was "npx,8088" because baseDevServer.startProcess records the
	// SPAWN NAME. But `npx` re-execs as `npm exec`, so the live argv reads
	// `npm exec expo start --web --port 8088` and the string "npx" is not in it.
	// Every child spawned that way was unreapable by construction, on every
	// box, since the registry shipped. The box had six orphan trees with
	// ppid=1, ages up to 6.4 days, ~985 MB resident, one of them squatting the
	// preferred port 8081 and serving a DIFFERENT PROJECT's app — which is
	// exactly the "user edits their source and sees nothing change" damage this
	// file's header warns about.
	//
	// It went unnoticed because sparing is the SAFE-LOOKING outcome. The log
	// line reads like the guard doing its job.
	//
	// So: read the child's real argv immediately after spawn and store it. That
	// is a stronger identity than substrings, and it cannot drift away from the
	// process it describes because it is copied FROM that process. If the
	// caller's needle also fails against the live argv, say so loudly — a
	// needle that does not match its own process at birth is a latent
	// unreapable record, and now it names itself instead of waiting six days.
	if argv := processArgv(rec.PID); argv != "" {
		rec.Argv = argv
		if !argvMatchesAll(argv, rec.Match) {
			log.Printf("[dev-children] WARNING: pid %d (%s, :%d) was recorded with match %q, which does NOT appear in its own argv %q — "+
				"falling back to exact-argv identity. Fix the Match at the call site; a needle that fails at birth can never reap.",
				rec.PID, rec.Kind, rec.Port, rec.Match, argv)
		}
	}
	devChildRegistryMu.Lock()
	defer devChildRegistryMu.Unlock()
	recs := loadDevChildren()
	out := make([]devChildRecord, 0, len(recs)+1)
	for _, r := range recs {
		if r.PID != rec.PID {
			out = append(out, r)
		}
	}
	out = append(out, rec)
	saveDevChildren(out)
}

// ForgetDevChild drops a record after an orderly exit.
func ForgetDevChild(pid int) {
	devChildRegistryMu.Lock()
	defer devChildRegistryMu.Unlock()
	recs := loadDevChildren()
	out := make([]devChildRecord, 0, len(recs))
	for _, r := range recs {
		if r.PID != pid {
			out = append(out, r)
		}
	}
	if len(out) != len(recs) {
		saveDevChildren(out)
	}
}

// processArgv returns the live command line for pid, or "" when the process is
// gone. Bounded + WaitDelay: a `ps` that hangs must not hold up agent startup,
// and a context kill does not free Output() while a grandchild holds the pipe.
func processArgv(pid int) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ps", "-o", "command=", "-p", fmt.Sprint(pid))
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// argvMatchesAll reports whether every comma-separated needle in match appears
// in argv. ALL, not any: one weak needle ("npx") would let a recycled PID pass,
// while "npx" AND the port together are effectively unique on a box.
func argvMatchesAll(argv, match string) bool {
	needles := strings.Split(match, ",")
	found := 0
	for _, n := range needles {
		n = strings.TrimSpace(n)
		if n == "" {
			continue
		}
		if !strings.Contains(argv, n) {
			return false
		}
		found++
	}
	return found > 0
}

// devChildIdentityHolds decides whether the live process at this PID is still
// the child we recorded.
//
// Exact argv first, because it is the strongest proof available and it is
// copied from the process itself at spawn time — a recycled PID would have to
// be running a byte-identical command line to be mistaken for this one.
//
// The comma-separated needles remain as the fallback for records written by
// older agents (no Argv field) so an upgrade does not strand the very orphans
// this change exists to collect.
func devChildIdentityHolds(argv string, r devChildRecord) bool {
	if strings.TrimSpace(r.Argv) != "" {
		return argv == r.Argv
	}
	return argvMatchesAll(argv, r.Match)
}

// ReapOrphanedDevChildren kills dev children left behind by a previous agent and
// returns one human line per action taken. Called once at serve startup, before
// any port is allocated, so the allocator sees the machine's real free ports
// instead of yesterday's ghosts.
func ReapOrphanedDevChildren() []string {
	findings := reapOrphanedDevChildren(time.Now())
	actions := make([]string, 0, len(findings))
	for _, f := range findings {
		log.Printf("[dev-children] %s", f.Action)
		actions = append(actions, f.Action)
	}
	return actions
}

// reapOrphanedDevChildren is the one implementation, returning custodian
// findings. The []string form above and the custodian warden both derive from
// it — the same sweep cannot say two different things to two surfaces.
func reapOrphanedDevChildren(now time.Time) []CustodianFinding {
	devChildRegistryMu.Lock()
	recs := loadDevChildren()
	devChildRegistryMu.Unlock()
	if len(recs) == 0 {
		return nil
	}

	var findings []CustodianFinding
	var keep []devChildRecord
	for _, r := range recs {
		subject := fmt.Sprintf("pid %d · :%d", r.PID, r.Port)
		argv := processArgv(r.PID)
		if argv == "" {
			continue // already gone; drop the record silently
		}
		if !devChildIdentityHolds(argv, r) {
			// PID recycled — this is somebody else's process now. Dropping the
			// record is the whole point of the guard: never kill on a number.
			findings = append(findings, CustodianFinding{
				Warden: "dev-children", Subject: subject, Outcome: OutcomeSpared, At: now,
				Problem: fmt.Sprintf("a stale record claims this PID is a %s, but the live process is something else", r.Kind),
				Action:  fmt.Sprintf("pid %d is no longer %s (argv does not match %q) — left alone", r.PID, r.Kind, r.Match),
			})
			continue
		}
		if err := killProcessGroup(r.PID, "TERM"); err != nil {
			findings = append(findings, CustodianFinding{
				Warden: "dev-children", Subject: subject, Outcome: OutcomeNeedsHuman, At: now,
				Problem: fmt.Sprintf("an orphaned %s is still holding port %d and would not stop", r.Kind, r.Port),
				Action:  fmt.Sprintf("could not stop orphaned %s pid %d on :%d — %v", r.Kind, r.PID, r.Port, err),
				Remedy:  fmt.Sprintf("stop it by hand: kill -TERM -%d (the negative PID kills its whole process group)", r.PID),
			})
			keep = append(keep, r) // still ours; try again next start
			continue
		}
		findings = append(findings, CustodianFinding{
			Warden: "dev-children", Subject: subject, Outcome: OutcomeFixed, At: now,
			Problem: fmt.Sprintf("a %s left by a previous agent was still holding port %d, so this machine looked busier than it is", r.Kind, r.Port),
			Action:  fmt.Sprintf("stopped orphaned %s (pid %d, port %d, %s) left by a previous agent — its port is free again", r.Kind, r.PID, r.Port, filepath.Base(r.WorkDir)),
		})
	}

	devChildRegistryMu.Lock()
	saveDevChildren(keep)
	devChildRegistryMu.Unlock()

	return findings
}
