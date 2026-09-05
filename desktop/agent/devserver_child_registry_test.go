//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// alive reports whether pid still exists (signal 0 probes without delivering).
func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

// spawnDetached starts a long-lived shell in its OWN process group — the same
// shape as a dev-server child, so the reaper's group-kill is exercised for
// real.
func spawnDetached(t *testing.T, marker string) *exec.Cmd {
	t.Helper()
	// The command text contributes "sleep" and marker is sh's $0, so the live
	// argv carries both identity needles exactly like a real `--port 19007`
	// child. Do not pass marker as a sleep operand: GNU sleep rejects that and
	// can exit before RecordDevChild observes the process.
	cmd := exec.Command("sh", "-c", "while :; do sleep 300; done", marker)
	setProcGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	t.Cleanup(func() {
		_ = killProcessGroup(cmd.Process.Pid, "KILL")
		_ = cmd.Wait()
	})
	deadline := time.Now().Add(2 * time.Second)
	for {
		argv := processArgv(cmd.Process.Pid)
		if strings.Contains(argv, "sleep") && strings.Contains(argv, marker) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("spawned child never exposed its identity in argv: %q", argv)
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cmd
}

// withTempYaverDir points yaverDir() at a scratch HOME so the test never touches
// the developer's real ~/.yaver/dev-children.json.
func withTempYaverDir(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("YAVER_HOME", filepath.Join(dir, ".yaver"))
	if err := os.MkdirAll(filepath.Join(dir, ".yaver"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	got, err := devChildRegistryPath()
	if err != nil {
		t.Fatalf("registry path: %v", err)
	}
	if !strings.HasPrefix(got, dir) {
		t.Fatalf("registry path %s escaped the temp HOME %s — the test would clobber the real registry", got, dir)
	}
}

// TestReapOrphanedDevChildrenKillsOurs is the leak this file exists for: an agent
// restart must not leave a live dev child holding a port.
func TestReapOrphanedDevChildrenKillsOurs(t *testing.T) {
	withTempYaverDir(t)
	marker := "yaver-reap-mine-19007"
	cmd := spawnDetached(t, marker)
	pid := cmd.Process.Pid

	RecordDevChild(devChildRecord{
		PID: pid, Port: 19007, Kind: "expo-web",
		Match: "sleep,19007", WorkDir: "/tmp/yaver-todo-rn",
	})

	actions := ReapOrphanedDevChildren()
	if len(actions) != 1 || !strings.Contains(actions[0], "stopped orphaned expo-web") {
		t.Fatalf("expected one 'stopped orphaned' action naming the port, got %v", actions)
	}

	// Wait for the real exit. `kill(pid, 0)` cannot answer this here: the test
	// process is the child's parent, so a killed child lingers as a zombie and
	// signal-0 keeps succeeding. A real orphan is parented to init, so only the
	// exit status proves the reaper actually took it down.
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		if err == nil {
			t.Fatalf("child exited cleanly — expected death by signal from the reaper")
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("pid %d survived the reaper — the port stays bound and the next start drifts to a new one", pid)
	}
	if recs := loadDevChildren(); len(recs) != 0 {
		t.Fatalf("reaped record should be dropped, still have %+v", recs)
	}
}

// TestReapSparesRecycledPID is the guard that makes the reaper safe to run at
// every startup: a stale record whose PID now belongs to someone else's process
// must NEVER be killed. A PID is a proxy for identity; argv is the identity.
func TestReapSparesRecycledPID(t *testing.T) {
	withTempYaverDir(t)
	marker := "yaver-someone-elses-editor"
	cmd := spawnDetached(t, marker)
	pid := cmd.Process.Pid

	// Record claims this PID was an expo-web on :19008 — it is not.
	RecordDevChild(devChildRecord{
		PID: pid, Port: 19008, Kind: "expo-web",
		Match: "expo start,--web,19008", WorkDir: "/tmp/gone",
	})

	actions := ReapOrphanedDevChildren()
	if len(actions) != 1 || !strings.Contains(actions[0], "left alone") {
		t.Fatalf("expected the mismatch to be reported and spared, got %v", actions)
	}
	if !alive(pid) {
		t.Fatalf("reaper killed pid %d on a PID match alone — that is how a reaper kills a user's editor", pid)
	}
	if recs := loadDevChildren(); len(recs) != 0 {
		t.Fatalf("stale record should be dropped even when spared, still have %+v", recs)
	}
}

// TestReapDropsDeadRecordsSilently keeps the registry from growing forever.
func TestReapDropsDeadRecordsSilently(t *testing.T) {
	withTempYaverDir(t)
	cmd := spawnDetached(t, "yaver-already-dead")
	pid := cmd.Process.Pid
	_ = killProcessGroup(pid, "KILL")
	_, _ = cmd.Process.Wait()

	RecordDevChild(devChildRecord{PID: pid, Port: 8087, Kind: "metro", Match: "sleep,8087"})
	if actions := ReapOrphanedDevChildren(); len(actions) != 0 {
		t.Fatalf("a process that is already gone needs no announcement, got %v", actions)
	}
	if recs := loadDevChildren(); len(recs) != 0 {
		t.Fatalf("dead record should be pruned, still have %+v", recs)
	}
}

// TestRecordDevChildRefusesUnverifiableRecords — a record with no match string
// could only ever be reaped on PID alone, which is the dangerous case. Refuse to
// store it rather than store something the reaper must then distrust.
func TestRecordDevChildRefusesUnverifiableRecords(t *testing.T) {
	withTempYaverDir(t)
	RecordDevChild(devChildRecord{PID: 4242, Port: 3000, Kind: "next", Match: "  "})
	RecordDevChild(devChildRecord{PID: 0, Port: 3000, Kind: "next", Match: "npx,3000"})
	if recs := loadDevChildren(); len(recs) != 0 {
		t.Fatalf("unverifiable records must not be stored, got %+v", recs)
	}
}

// TestArgvMatchesAllRequiresEveryNeedle — "all", not "any". One weak needle
// ("npx") would let a recycled PID through; npx AND the port together will not.
func TestArgvMatchesAllRequiresEveryNeedle(t *testing.T) {
	argv := "npx next dev --port 3000"
	for _, tc := range []struct {
		match string
		want  bool
	}{
		{"npx,3000", true},
		{"npx,19007", false}, // right binary, wrong port — a DIFFERENT dev server
		{"vite,3000", false},
		{"", false}, // an empty match must never match anything
	} {
		if got := argvMatchesAll(argv, tc.match); got != tc.want {
			t.Errorf("argvMatchesAll(%q, %q) = %v, want %v", argv, tc.match, got, tc.want)
		}
	}
}

// TestDevChildIdentity_ExactArgvBeatsAWrongNeedle — the guard must not SPARE
// forever.
//
// Reproduces the ubuntu-4gb failure of 2026-08-03 exactly. baseDevServer
// .startProcess recorded Match "npx,8088" from the spawn NAME, but `npx`
// re-execs as `npm exec`, so the live argv never contains "npx":
//
//	npm exec expo start --web --port 8088 --host lan
//
// Needle-only identity therefore said "this is somebody else's process" and
// spared it — on every box, for every child spawned that way, since the
// registry shipped. Six orphan trees, up to 6.4 days old, ~985 MB, one holding
// the preferred port and serving a different project.
//
// Sparing is the safe-LOOKING outcome, which is why nobody caught it: the log
// line reads like the guard working.
//
// Delete the Argv branch in devChildIdentityHolds and this test fails.
func TestDevChildIdentity_ExactArgvBeatsAWrongNeedle(t *testing.T) {
	liveArgv := "npm exec expo start --web --port 8088 --host lan"
	rec := devChildRecord{
		PID: 4170444, Port: 8088, Kind: "expo",
		Match: "npx,8088", // what the call site actually wrote — and it never matches
		Argv:  liveArgv,   // what RecordDevChild now captures from the process itself
	}
	if argvMatchesAll(liveArgv, rec.Match) {
		t.Fatal("precondition broken: the needle was supposed to NOT match — this test no longer reproduces the bug")
	}
	if !devChildIdentityHolds(liveArgv, rec) {
		t.Fatal("the reaper still cannot identify its own child — it would spare this orphan forever, which is the bug")
	}
}

// And the safety property the guard exists for must survive: a recycled PID
// running something else is still spared.
func TestDevChildIdentity_RecycledPidIsStillSpared(t *testing.T) {
	rec := devChildRecord{
		PID: 4170444, Port: 8088, Kind: "expo",
		Match: "expo,8088",
		Argv:  "npm exec expo start --web --port 8088 --host lan",
	}
	if devChildIdentityHolds("/Applications/Sublime Text.app/Contents/MacOS/sublime_text", rec) {
		t.Fatal("the reaper would kill an unrelated process that inherited the PID")
	}
}

// Records written by an OLDER agent have no Argv, and must still be reapable
// via the needles — otherwise upgrading strands exactly the orphans this
// change is meant to collect.
func TestDevChildIdentity_LegacyRecordFallsBackToNeedles(t *testing.T) {
	rec := devChildRecord{PID: 1, Port: 19006, Kind: "expo-web", Match: "expo start,--web,19006"}
	if !devChildIdentityHolds("node /x/node_modules/.bin/expo start --web --port 19006", rec) {
		t.Fatal("a legacy record lost its identity path on upgrade")
	}
}

// TestDevChildIdentity_StartTokenSurvivesArgvRewrite — npx rewrites its own
// command line, so argv is not an identity either.
//
// Measured LIVE on ubuntu-4gb, 2026-08-03, on the very restart that was meant
// to prove the exact-argv fix:
//
//	at spawn      node /root/.yaver/runtimes/node/bin/npx expo start --dev-client --port 8089 --host lan
//	moments later npm exec expo start --dev-client --port 8089 --host lan
//
// Both the "npx" needle and the recorded argv stop matching the process they
// describe, the reaper spares it, and the orphan count went 7 → 8.
//
// (PID, start time) cannot be rewritten and is unique for all time on a
// machine. Remove the StartToken branch from devChildIdentityHolds and this
// fails.
func TestDevChildIdentity_StartTokenSurvivesArgvRewrite(t *testing.T) {
	self := os.Getpid()
	tok := processStartToken(self)
	if tok == "" {
		t.Skip("no readable process start time on this platform")
	}
	rec := devChildRecord{
		PID:  self,
		Port: 8089, Kind: "expo",
		Match:      "npx,8089",                                         // never matched after the rewrite
		Argv:       "node /root/.yaver/.../npx expo start --port 8089", // matched only at spawn
		StartToken: tok,
	}
	// The live argv is the REWRITTEN form — neither the needle nor the recorded
	// argv can save us here.
	rewritten := "npm exec expo start --dev-client --port 8089 --host lan"
	if argvMatchesAll(rewritten, rec.Match) || rewritten == rec.Argv {
		t.Fatal("precondition broken: this test no longer reproduces the argv rewrite")
	}
	if !devChildIdentityHolds(rewritten, rec) {
		t.Fatal("the reaper still cannot identify a child whose argv was rewritten — it would spare the orphan again")
	}
}

// The safety property, restated against the strongest identity: a DIFFERENT
// start time means a recycled PID, and must never be killed.
func TestDevChildIdentity_DifferentStartTokenIsSpared(t *testing.T) {
	self := os.Getpid()
	if processStartToken(self) == "" {
		t.Skip("no readable process start time on this platform")
	}
	rec := devChildRecord{
		PID: self, Port: 8089, Kind: "expo",
		Match:      "expo,8089",
		StartToken: "definitely-not-this-processes-start-time",
	}
	if devChildIdentityHolds("npm exec expo start --dev-client --port 8089", rec) {
		t.Fatal("a record whose start time does not match the live process was accepted — that is the PID-reuse kill")
	}
}

// TestReaper_DoesNotKillThisAgentsOwnChildren — the custodian re-runs this
// sweep on a TIMER, so by then the registry holds children this agent started
// and is still using.
//
// Measured on ubuntu-4gb, 2026-08-03, minutes after the identity fix shipped:
//
//	[custodian:dev-children] pid 51855 · :19006 — a expo-web left by a previous
//	agent was still holding port 19006, so this machine looked busier than it was
//
// It was not left by a previous agent. It was that agent's own expo-web,
// alive, serving the preview a tvOS closed loop was watching — and the sweep
// killed it, repeatedly, which is why the TV kept showing "expo web
// unavailable" seconds after the port had answered 200.
//
// The identity fix did not cause this so much as UNMASK it: while the "npx"
// needle never matched, nothing was ever reaped, so the missing generation
// check cost nothing. A guard that starts working after a long time asleep can
// turn a dormant bug into an active one.
//
// Remove the AgentBoot check in reapOrphanedDevChildren and this fails.
func TestReaper_DoesNotKillThisAgentsOwnChildren(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	// A live process this "agent" owns, recorded the way a real spawn records it.
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })

	RecordDevChild(devChildRecord{
		PID: cmd.Process.Pid, Port: 19006, Kind: "expo-web",
		Match: "sleep,30", WorkDir: t.TempDir(),
	})

	// THE INVARIANT IS "NOT CONSIDERED", NOT "SURVIVED".
	//
	// The first version of this test asserted OutcomeFixed plus a live pid, and
	// PASSED against the regression — because a `sleep` started by a test is
	// not a process-group leader (real dev children are, via setProcGroup), so
	// the group-kill missed and the outcome came back `needs-human`:
	//
	//   could not stop orphaned expo-web pid 70745 on :19006 — no such process
	//
	// The sweep had still DECIDED our own child was an orphan and tried to kill
	// it; only the test's stand-in failed to die. Asserting on the outcome let a
	// working regression through. Assert on the decision instead: a child of
	// this agent must never appear in the findings at all.
	findings := reapOrphanedDevChildren(time.Now())
	for _, f := range findings {
		if strings.Contains(f.Subject, fmt.Sprint(cmd.Process.Pid)) {
			t.Fatalf("the sweep treated a child THIS agent started as an orphan (%v): %s", f.Outcome, f.Action)
		}
	}
	// And it must stay in the registry — a spared record that gets dropped can
	// never be reaped later, when it really is an orphan.
	kept := loadDevChildren()
	found := false
	for _, r := range kept {
		if r.PID == cmd.Process.Pid {
			found = true
		}
	}
	if !found {
		t.Fatal("our own child was dropped from the registry, so a future agent could never reap it")
	}
}
