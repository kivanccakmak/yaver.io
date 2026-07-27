package main

// resource_warden.go — the agent's own resource watchdog: a lightweight,
// always-on goroutine that OBSERVES the box the agent stands on, SHEDS load
// before the kernel starts killing, CLEANS UP (zombie reap) when the process
// table is exhausted, and — as the last in-process lever — exits cleanly so
// the init system respawns a fresh agent.
//
// Born from two box-deaths in 24 h (2026-07-27): the mac mini died of fork
// exhaustion, the ubuntu render box of an OOM thrash storm; in BOTH the agent
// was the silent casualty and nothing reported why. Doctrine:
// docs/architecture/FAILURE_HEALING_DOCTRINE.md laws 2, 4 and 7; evidence in
// docs/audits/agent-fork-exhaustion-deep-analysis-2026-07.md and
// docs/audits/ubuntu-render-oom-incident-2026-07-27.md.
//
// Design constraints, in order:
//   - Sampling avoids exec where the platform allows — a watchdog that forks
//     to measure fork exhaustion is a self-defeating probe. The intentional
//     exec is the spawn-capability probe (the operation under test). Caveat:
//     gopsutil's Children() shells out to pgrep on darwin AND linux, so under
//     fork exhaustion the child count reads 0 — treat Children as UNKNOWN
//     whenever CanFork is false; the CanFork probe itself already carries the
//     critical verdict at that point.
//   - Transition-triggered reporting only: flight events and custodian
//     findings fire on level CHANGES, never per tick (flight recorder rule).
//   - Every consequence is NAMED: heartbeat fields, custodian findings, and
//     a 503 with a stable reason on task admission — never a silent refusal.

import (
	"context"
	"fmt"
	"log"
	"os"
	osexec "os/exec"
	"runtime"
	"runtime/debug"
	"strings"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/process"
)

const (
	resourceLevelOK       = "ok"
	resourceLevelDegraded = "degraded"
	resourceLevelCritical = "critical"

	// ReasonBoxResourcePressure is the stable admission-refusal code carried
	// on HTTP bodies and heartbeats (see reason_codes.go conventions).
	ReasonBoxResourcePressure = "box_resource_pressure"
)

// Thresholds are vars so the classifier tests can exercise every band
// without faking a starved box.
var (
	resourceMemDegradedMb = uint64(400) // available RAM below this → degraded
	resourceMemCriticalMb = uint64(150) // available RAM below this → critical
	resourceFDDegraded    = 3000
	resourceChildDegraded = 200
	// How long the device heartbeat may stall (while the watchdog itself is
	// healthy) before the agent self-restarts via the init system. Generous:
	// the heartbeat interval is minutes, and a restart is disruptive.
	resourceHeartbeatStall = 12 * time.Minute
	resourceWatchdogEvery  = 30 * time.Second
)

// ResourcePressure is one sample of the box + agent resource envelope.
type ResourcePressure struct {
	At          time.Time `json:"at"`
	Level       string    `json:"level"`
	Reasons     []string  `json:"reasons,omitempty"`
	CanFork     bool      `json:"canFork"`
	AvailableMb uint64    `json:"availableMb"`
	SwapUsedMb  uint64    `json:"swapUsedMb"`
	AgentRSSMb  uint64    `json:"agentRssMb"`
	Children    int       `json:"children"`
	Goroutines  int       `json:"goroutines"`
	OpenFDs     int       `json:"openFds"`
}

var currentResourcePressure atomic.Pointer[ResourcePressure]

// ResourcePressureNow returns the latest sample, or a permissive zero value
// before the first tick (an unstarted watchdog must never block work).
func ResourcePressureNow() ResourcePressure {
	if p := currentResourcePressure.Load(); p != nil {
		return *p
	}
	return ResourcePressure{Level: resourceLevelOK, CanFork: true}
}

// ResourceAdmissionError returns a named refusal when the box cannot afford
// NEW heavy work (task dispatch, dev-server start), and "" when it can.
// Doctrine law 7: admission control before every heavy action. Only the
// critical band refuses — degraded boxes still accept work, they just shed
// their own optional load.
func ResourceAdmissionError() string {
	p := ResourcePressureNow()
	if p.Level != resourceLevelCritical {
		return ""
	}
	return fmt.Sprintf(
		"%s: this box cannot afford new work right now (%s). Free memory or wait for the resource warden to shed load, or run this on another machine — the runner/render split and managed cloud both route around a starved box.",
		ReasonBoxResourcePressure, strings.Join(p.Reasons, "; "))
}

// Heartbeat attempt bracketing, stamped by SendHeartbeat. The restart lever
// keys off "an attempt STARTED and never RETURNED" — the tailscale-exec wedge
// shape (a subprocess holding SendHeartbeat hostage for 40+ minutes) — and
// deliberately NOT off "no successful beat lately": a laptop that is merely
// offline (train, flight, rotated token) fails fast, keeps returning, and
// must never get its in-flight tasks killed by a gratuitous self-restart.
var (
	heartbeatAttemptStartUnix atomic.Int64
	heartbeatAttemptDoneUnix  atomic.Int64
)

func noteHeartbeatAttemptStarted()  { heartbeatAttemptStartUnix.Store(time.Now().Unix()) }
func noteHeartbeatAttemptFinished() { heartbeatAttemptDoneUnix.Store(time.Now().Unix()) }

// probeSpawnCapability attempts the OPERATION — spawning a process — with the
// full WaitDelay discipline. Under fork exhaustion fork() fails fast (EAGAIN),
// so this is cheap exactly when it matters.
func probeSpawnCapability() bool {
	bin, err := osexec.LookPath("true")
	if err != nil {
		bin = "/usr/bin/true"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := osexec.CommandContext(ctx, bin)
	cmd.WaitDelay = 1 * time.Second
	return cmd.Run() == nil
}

func sampleResourcePressure() ResourcePressure {
	p := ResourcePressure{At: time.Now(), CanFork: probeSpawnCapability(), Goroutines: runtime.NumGoroutine()}
	if vm, err := mem.VirtualMemory(); err == nil && vm != nil {
		p.AvailableMb = vm.Available / (1 << 20)
	}
	if sw, err := mem.SwapMemory(); err == nil && sw != nil {
		p.SwapUsedMb = sw.Used / (1 << 20)
	}
	if proc, err := process.NewProcess(int32(os.Getpid())); err == nil {
		if mi, err := proc.MemoryInfo(); err == nil && mi != nil {
			p.AgentRSSMb = mi.RSS / (1 << 20)
		}
		if kids, err := proc.Children(); err == nil {
			p.Children = len(kids)
		}
	}
	p.OpenFDs = countOpenFDs()
	p.Level, p.Reasons = classifyResourcePressure(p)
	return p
}

// classifyResourcePressure is pure so the band logic is testable without a
// starved box. Reasons are user-readable — they end up on screens.
func classifyResourcePressure(p ResourcePressure) (string, []string) {
	var reasons []string
	level := resourceLevelOK
	if !p.CanFork {
		reasons = append(reasons, "the kernel refused to spawn a new process (fork exhaustion)")
		level = resourceLevelCritical
	}
	if p.AvailableMb > 0 && p.AvailableMb < resourceMemCriticalMb {
		reasons = append(reasons, fmt.Sprintf("only %d MB of memory available", p.AvailableMb))
		level = resourceLevelCritical
	} else if p.AvailableMb > 0 && p.AvailableMb < resourceMemDegradedMb {
		reasons = append(reasons, fmt.Sprintf("memory is low (%d MB available)", p.AvailableMb))
		if level == resourceLevelOK {
			level = resourceLevelDegraded
		}
	}
	if p.OpenFDs > resourceFDDegraded {
		reasons = append(reasons, fmt.Sprintf("agent holds %d open file descriptors", p.OpenFDs))
		if level == resourceLevelOK {
			level = resourceLevelDegraded
		}
	}
	if p.Children > resourceChildDegraded {
		reasons = append(reasons, fmt.Sprintf("agent has %d live child processes", p.Children))
		if level == resourceLevelOK {
			level = resourceLevelDegraded
		}
	}
	return level, reasons
}

// runningUnderInitSupervision reports whether exiting will get us respawned.
// systemd sets INVOCATION_ID; launchd jobs see XPC_SERVICE_NAME. Without a
// supervisor a self-exit would be suicide, not healing.
func runningUnderInitSupervision() bool {
	return os.Getenv("INVOCATION_ID") != "" ||
		(runtime.GOOS == "darwin" && os.Getenv("XPC_SERVICE_NAME") != "" && os.Getenv("XPC_SERVICE_NAME") != "0")
}

// startResourceWatchdog runs the watchdog loop on its own goroutine. It never
// exits (short of ctx cancel) and recovers its own panics — a dead watchdog
// is the one silent failure this file exists to prevent.
func startResourceWatchdog(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(resourceWatchdogEvery)
		defer ticker.Stop()
		lastLevel := resourceLevelOK
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("[resource-warden] tick panicked (watchdog continues): %v", r)
					}
				}()
				p := sampleResourcePressure()
				currentResourcePressure.Store(&p)

				if p.Level != lastLevel {
					detail := fmt.Sprintf("resource pressure %s → %s: %s (rss=%dMB avail=%dMB children=%d fds=%d)",
						lastLevel, p.Level, strings.Join(p.Reasons, "; "), p.AgentRSSMb, p.AvailableMb, p.Children, p.OpenFDs)
					log.Printf("[resource-warden] %s", detail)
					// Transition, not a loop — allowed by the flight rule.
					if rec := getFlightRecorder(); rec != nil {
						_ = rec.record(flightKindDegraded, detail)
					}
					lastLevel = p.Level
				}

				switch p.Level {
				case resourceLevelDegraded:
					// Shed the agent's own weight first.
					debug.FreeOSMemory()
				case resourceLevelCritical:
					// CLEAN UP: reap every zombie child in one sweep. This can
					// steal exit statuses from in-flight Cmd.Wait()s (they get
					// ECHILD) — acceptable only here, where the box is already
					// failing to spawn at all and each zombie holds a slot.
					if !p.CanFork {
						if n := reapZombieChildren(); n > 0 {
							log.Printf("[resource-warden] reaped %d zombie children under fork exhaustion", n)
						}
					}
					screenlogMu.Lock()
					slRunning := screenlogActive != nil
					screenlogMu.Unlock()
					if slRunning {
						if _, err := stopScreenlog(); err == nil {
							log.Printf("[resource-warden] stopped screenlog to shed load")
						}
					}
					debug.FreeOSMemory()
				}

				// LAST LEVER — the "make the agent come back up" path. Fires
				// ONLY when a heartbeat attempt started and never returned
				// past the stall window (SendHeartbeat wedged inside — the
				// tailscale exec-hang class), never on mere delivery failure:
				// an offline box fails fast and keeps returning. A clean exit
				// under init supervision trades a minute of downtime for a
				// working box. Zombies were reaped above, so the init system
				// can fork again.
				started := heartbeatAttemptStartUnix.Load()
				done := heartbeatAttemptDoneUnix.Load()
				if started > 0 && done < started && time.Since(time.Unix(started, 0)) > resourceHeartbeatStall && runningUnderInitSupervision() {
					detail := fmt.Sprintf("self-restart: heartbeat attempt wedged for %s without returning while resource warden alive (level=%s)",
						time.Since(time.Unix(started, 0)).Round(time.Second), p.Level)
					log.Printf("[resource-warden] %s", detail)
					if rec := getFlightRecorder(); rec != nil {
						_ = rec.record(flightKindDegraded, detail)
					}
					os.Exit(86) // distinctive code: resource-warden-initiated restart
				}
			}()
		}
	}()
}

// ── custodian adapter ────────────────────────────────────────────────────────

type resourcePressureWarden struct{}

func (resourcePressureWarden) Name() string         { return "resource-pressure" }
func (resourcePressureWarden) Every() time.Duration { return 5 * time.Minute }
func (resourcePressureWarden) Sweep(now time.Time) []CustodianFinding {
	p := ResourcePressureNow()
	if p.Level == resourceLevelOK || p.At.IsZero() {
		return nil
	}
	return []CustodianFinding{{
		Warden: "resource-pressure", Subject: p.Level, Outcome: OutcomeNeedsHuman, At: now,
		Problem: fmt.Sprintf("the box is under %s resource pressure: %s (agent rss %d MB, %d MB available, %d children, %d fds)",
			p.Level, strings.Join(p.Reasons, "; "), p.AgentRSSMb, p.AvailableMb, p.Children, p.OpenFDs),
		Action: "warden is shedding optional load; new heavy work is refused with " + ReasonBoxResourcePressure +
			" while critical — stop unused dev servers/runners or move work to another machine",
	}}
}
