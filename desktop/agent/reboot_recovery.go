package main

// reboot_recovery.go — narrating the minute a machine is gone.
//
// A reboot is the one action where success LOOKS exactly like failure: the box
// stops answering. Both surfaces today do the same wrong thing — they fire
// `infra_power` and immediately call `refresh()`, which lands on a machine that
// is halfway through shutting down. The refresh fails, the card flips to
// offline, and the user is left staring at a dead device with no idea whether
// they broke it or whether it is simply doing what they asked.
//
// That is the customer-facing shape of a silent `serve`: the product imposed a
// wait and said nothing about it. So this file owns the sentence the UI shows
// for every second of that wait, and — more importantly — the rule for when it
// is allowed to say "recovered".
//
// The trap this state machine exists to avoid:
//
//   A machine keeps answering for several seconds after it accepts a reboot,
//   because shutdown is not instant. A naive "did it answer? → recovered" check
//   therefore reports SUCCESS almost immediately, before the box has even begun
//   to go down — and then the card flips to offline a moment later and stays
//   there. That is the inventory-says-yes bug wearing a stopwatch. Recovery
//   REQUIRES having observed the machine actually go away first
//   (SawUnreachable); answering alone is never enough.
//
// Pure. No clocks, no sockets — the caller supplies elapsed time and probe
// results, so every phase transition is unit-testable without rebooting
// anything.

import "fmt"

// RebootPhase is the state a post-reboot wait is in.
type RebootPhase string

const (
	// RebootPhaseIssued — the command was accepted; the machine has not yet
	// stopped answering. We are waiting for it to go DOWN, not to come up.
	RebootPhaseIssued RebootPhase = "issued"
	// RebootPhaseDown — the machine has gone away, as expected. This is the
	// normal middle of a reboot and must never be rendered as an error.
	RebootPhaseDown RebootPhase = "down"
	// RebootPhaseRecovered — it went away and has answered again. Terminal.
	RebootPhaseRecovered RebootPhase = "recovered"
	// RebootPhaseOverdue — past the budget and still not back. Honest, not fatal:
	// a machine can take longer than expected (fsck, FileVault, a slow POST).
	RebootPhaseOverdue RebootPhase = "overdue"
)

// rebootOverdueGraceFactor turns the ETA into the point where we stop saying
// "expected" and start saying "longer than expected". Doubling the budget is
// deliberate: a warning that fires at exactly the ETA would fire on every
// healthy reboot that hit a slow disk, and a warning that cries wolf is a
// warning users learn to ignore.
const rebootOverdueGraceFactor = 2

// RebootProbe is one observation of the machine, supplied by the caller.
type RebootProbe struct {
	// ElapsedSeconds since the reboot command was accepted.
	ElapsedSeconds int
	// ETASeconds is the expected return time for this platform, from the
	// capability report (PowerAction.ETASeconds).
	ETASeconds int
	// Reachable is the result of the most recent probe (heartbeat or ping).
	Reachable bool
	// SawUnreachable is true once ANY probe since the reboot was issued has
	// failed. This is the gate on claiming recovery.
	SawUnreachable bool
	// MachineName is used in the copy. Optional.
	MachineName string
}

// RebootProgress is what a surface renders. Headline is the one line that
// always shows; Detail is the supporting sentence.
type RebootProgress struct {
	Phase RebootPhase `json:"phase"`
	// Headline is short and states the current fact.
	Headline string `json:"headline"`
	// Detail carries the bounded expectation, so the user knows what "normal"
	// looks like and when to worry.
	Detail string `json:"detail"`
	// RemainingSeconds is the countdown to the ETA. 0 once past it.
	RemainingSeconds int `json:"remainingSeconds"`
	// ElapsedSeconds mirrors the input so a surface can render "1:14 elapsed"
	// without keeping its own clock.
	ElapsedSeconds int `json:"elapsedSeconds"`
	// Done is true only in a terminal phase — the caller stops polling.
	Done bool `json:"done"`
	// Terminal-but-unhappy: what the user should do now.
	Remedy string `json:"remedy,omitempty"`
}

// RebootProgressFor is the whole decision. Pure.
func RebootProgressFor(p RebootProbe) RebootProgress {
	name := p.MachineName
	if name == "" {
		name = "The machine"
	}
	eta := p.ETASeconds
	if eta <= 0 {
		eta = rebootETALinuxSeconds
	}
	remaining := eta - p.ElapsedSeconds
	if remaining < 0 {
		remaining = 0
	}
	prog := RebootProgress{
		RemainingSeconds: remaining,
		ElapsedSeconds:   p.ElapsedSeconds,
	}

	// Recovered — and ONLY if we watched it go away first. Answering without
	// ever having gone down means the reboot has not started yet, no matter how
	// healthy the probe looks.
	if p.Reachable && p.SawUnreachable {
		prog.Phase = RebootPhaseRecovered
		prog.Done = true
		prog.Headline = fmt.Sprintf("%s is back online.", name)
		prog.Detail = fmt.Sprintf("Rebooted and answering again after %s. Dev servers and tasks did not survive the reboot — restart the ones you need.",
			humanizeRebootSeconds(p.ElapsedSeconds))
		return prog
	}

	// Past the budget with no answer. Say so plainly and hand back something to
	// do; do NOT claim the machine is broken, because it may still be coming up.
	if !p.Reachable && p.ElapsedSeconds > eta*rebootOverdueGraceFactor {
		prog.Phase = RebootPhaseOverdue
		prog.Headline = fmt.Sprintf("%s has not come back yet.", name)
		prog.Detail = fmt.Sprintf(
			"It has been %s and the expected return was about %s. A reboot can legitimately take longer (disk check, FileVault, a slow BIOS), so this is not proof anything is wrong.",
			humanizeRebootSeconds(p.ElapsedSeconds), humanizeRebootSeconds(eta))
		prog.Remedy = "Yaver will keep watching. If it stays down: check the machine has power and network, and that the Yaver agent is set to start on boot (`yaver serve` installs the launchd/systemd unit)."
		return prog
	}

	// Gone, on schedule. This is the healthy middle and must read as progress.
	if !p.Reachable {
		prog.Phase = RebootPhaseDown
		prog.Headline = fmt.Sprintf("%s is rebooting…", name)
		prog.Detail = fmt.Sprintf("Off the network, which is expected. Back in about %s (%s elapsed).",
			humanizeRebootSeconds(remaining), humanizeRebootSeconds(p.ElapsedSeconds))
		return prog
	}

	// Still answering — the shutdown has been accepted but has not taken hold.
	prog.Phase = RebootPhaseIssued
	prog.Headline = fmt.Sprintf("Reboot accepted — %s is shutting down…", name)
	prog.Detail = fmt.Sprintf("Still answering while it shuts down. It should drop off the network shortly, then return in about %s.",
		humanizeRebootSeconds(eta))
	return prog
}

// humanizeRebootSeconds renders a duration the way a person waiting would say
// it. Kept local and tiny — a shared humanizer would drag in formatting rules
// (days, weeks) that make no sense for a one-minute wait.
func humanizeRebootSeconds(s int) string {
	if s < 0 {
		s = 0
	}
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	m := s / 60
	rem := s % 60
	if rem == 0 {
		return fmt.Sprintf("%dm", m)
	}
	return fmt.Sprintf("%dm %ds", m, rem)
}
