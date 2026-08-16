package main

import "fmt"

// Deciding what is wrong with a remote box, and which half of it we may fix.
//
// Every check here is a fault that actually took a box down on 2026-07-31 /
// 08-01, in the order they blocked each other. That ordering is the whole
// point: on ubuntu-4gb-hel1-1 the agent binary had become a symlink to itself,
// and until that was fixed every other signal was noise — the service could not
// start, so of course the session looked dead and the tunnel was missing.
// Reporting five findings when one of them causes the other four is how an
// operator ends up fixing the wrong thing.
//
// The split between "we fix it" and "we tell you" is deliberate and follows the
// house rule: self-heal when the fix is unambiguous and idempotent, ask when it
// is not. Restoring a known-good binary from the backup the updater itself
// wrote is unambiguous. Signing a box in is not — it needs an OAuth round trip
// that only a human can complete.

// remoteBoxObservation is the raw state gathered from a box. It is a plain
// struct with no behaviour so the planner can be tested without a network, an
// SSH server, or a box in a broken state.
type remoteBoxObservation struct {
	// AgentBinaryExecutable is false when the ExecStart target cannot be
	// exec'd at all. AgentBinaryError carries the OS reason — the 2026-08-01
	// case was ELOOP ("too many levels of symbolic links"), from an update
	// that left the binary as a symlink to its own path.
	AgentBinaryExecutable bool
	AgentBinaryError      string
	// BackupBinaryPresent reports whether yaver.previous exists next to the
	// binary. It is what makes the unbrick idempotent and reversible.
	BackupBinaryPresent bool

	// ServiceActive is systemd/launchd's view. HealthHTTP is what the agent
	// itself answered on /health — 0 when nothing answered. The pair matters:
	// "active" with no HTTP answer is the classic false green.
	ServiceActive bool
	HealthHTTP    int

	// SessionValid is whether the box's own Convex session is live.
	SessionValid bool

	// CachedSpkiPin is what the box will pin on its next relay dial;
	// PlatformSpkiPin is what the control plane currently publishes. A
	// mismatch means the relay rotated its key and this box never learned it.
	CachedSpkiPin   string
	PlatformSpkiPin string

	// DiskUsedPct is the root filesystem's usage. Builds, updates and dev
	// servers start failing near the top without ever naming the disk.
	DiskUsedPct int
}

// remoteBoxFinding is one diagnosed fault plus its route to a fix.
type remoteBoxFinding struct {
	Check string `json:"check"`
	// Severity: "blocking" (nothing else can work until this is fixed),
	// "degraded" (the box runs but a lane is down), "warning" (heading for
	// trouble).
	Severity string `json:"severity"`
	Detail   string `json:"detail"`
	// Remedy is the human-readable next step, always naming a command.
	Remedy string `json:"remedy"`
	// AutoFixable is true only for deterministic, idempotent repairs. A verb
	// running with apply=true may perform exactly these and nothing else.
	AutoFixable bool `json:"autoFixable"`
	// Reason is the stable code surfaces key off instead of matching prose.
	Reason string `json:"reason,omitempty"`
}

// planRemoteBoxRepair turns an observation into an ordered finding list.
//
// It returns EARLY on a blocking fault. That is not laziness: with the binary
// unrunnable, every downstream observation was gathered from a box that is not
// running, so reporting them as independent faults would be fabricating
// diagnoses out of consequences.
func planRemoteBoxRepair(obs remoteBoxObservation) []remoteBoxFinding {
	var out []remoteBoxFinding

	if !obs.AgentBinaryExecutable {
		f := remoteBoxFinding{
			Check:    "agent_binary",
			Severity: "blocking",
			Detail: fmt.Sprintf("the agent binary cannot be executed (%s) — systemd reports status 203 and the unit "+
				"sits in 'activating' with restarts climbing, so nothing else on this box can be trusted", orUnknown(obs.AgentBinaryError)),
			Reason: ReasonAgentBinaryUnrunnable,
		}
		if obs.BackupBinaryPresent {
			f.AutoFixable = true
			f.Remedy = "restore the binary from the yaver.previous backup the updater wrote, then restart the service"
		} else {
			f.Remedy = "no yaver.previous backup next to the binary — reinstall with `npm install -g yaver-cli@latest` on the box"
		}
		return append(out, f)
	}

	// A unit that systemd calls active while the agent answers nothing is the
	// false green this codebase keeps re-learning: the inventory says yes, the
	// operation says no. Probe the operation.
	if !obs.ServiceActive || obs.HealthHTTP != 200 {
		out = append(out, remoteBoxFinding{
			Check:    "agent_service",
			Severity: "blocking",
			Detail: fmt.Sprintf("service active=%v but /health answered %s — the agent is not serving",
				obs.ServiceActive, httpOrNothing(obs.HealthHTTP)),
			Remedy:      "restart the agent service and re-probe /health",
			AutoFixable: true,
			Reason:      ReasonAgentNotServing,
		})
		return out
	}

	// Order matters below this line too: a stale pin stops the TLS handshake
	// BEFORE any credential is presented, so it must be reported ahead of the
	// session. Both were true at once on 2026-08-01, and fixing the session
	// first would have changed nothing.
	if obs.PlatformSpkiPin != "" && obs.CachedSpkiPin != "" && obs.CachedSpkiPin != obs.PlatformSpkiPin {
		out = append(out, remoteBoxFinding{
			Check:    "relay_pin",
			Severity: "degraded",
			Detail: "this box pins a relay identity the control plane no longer publishes, so its QUIC handshake is " +
				"refused before any credential is sent (the refusal reads as 'possible MITM')",
			Remedy:      "rewrite the cached spki_pin from platform config, then let the tunnel redial",
			AutoFixable: true,
			Reason:      ReasonRelayPinStale,
		})
	}

	if !obs.SessionValid {
		out = append(out, remoteBoxFinding{
			Check:    "session",
			Severity: "degraded",
			Detail: "the box's Convex session is expired, so the relay refuses its registration (reason=dead_token) " +
				"and every surface shows it as unreachable rather than as needing sign-in",
			// Deliberately NOT auto-fixable. Signing a box in needs an OAuth
			// round trip; guessing at it is exactly the class of "fix" this
			// codebase refuses to automate.
			Remedy: "run `yaver auth --headless` on the box and authorize the printed code — " +
				"re-auth from the web cannot help here, it rides the tunnel that is missing",
			AutoFixable: false,
			Reason:      ReasonConnectivityRelayAuthExpired,
		})
	}

	if obs.DiskUsedPct >= 95 {
		out = append(out, remoteBoxFinding{
			Check:       "disk",
			Severity:    "warning",
			Detail:      fmt.Sprintf("root filesystem is %d%% full — builds, updates and dev servers will fail with errors that never name the disk", obs.DiskUsedPct),
			Remedy:      "reclaim space on the box (caches, old agent binaries, node_modules); Yaver will not delete files it did not create",
			AutoFixable: false,
			Reason:      ReasonCapabilityInsufficientDisk,
		})
	}

	return out
}

// remoteBoxRepairIsClean reports whether a plan found nothing worth acting on.
func remoteBoxRepairIsClean(findings []remoteBoxFinding) bool { return len(findings) == 0 }

func orUnknown(s string) string {
	if s == "" {
		return "reason unknown"
	}
	return s
}

func httpOrNothing(code int) string {
	if code == 0 {
		return "nothing"
	}
	return fmt.Sprintf("HTTP %d", code)
}
