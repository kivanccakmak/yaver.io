package main

// custodian_runner.go — the third lane: when neither a warden nor the playbook
// recognises a failure, hand it to a coding runner that fixes it WITHOUT waiting
// for the user, and stream what it does.
//
// ── Why autonomous is the right default here ────────────────────────────────
//
// The user is not sitting at a terminal. They are on a phone looking at a
// preview that will not load, or on a TV, or asleep. "Yaver noticed something
// broke and is waiting for permission to look at it" is not a product; it is a
// pager. So the runner acts, and the contract is that Yaver NARRATES the whole
// thing — what it saw, what it is trying, what it changed — into the same
// custodian feed the wardens use. Consent lives in the SCOPE, not in a prompt:
//
//   • Diagnose-and-repair runs against the user's OWN machine and OWN project.
//   • It gets the failing operation's evidence, not a blank shell.
//   • It is bounded (escalationsPerSignaturePerHour) so a flapping failure can
//     never become an overnight paid loop — the guard that makes "autonomous"
//     affordable rather than terrifying.
//   • Anything the playbook classed as destructive or account-mutating never
//     reaches this lane; those stay needs-human with the remedy named.
//
// ── Why the prompt is composed here, not by the runner ──────────────────────
//
// A runner handed "the build failed, fix it" re-derives context Yaver already
// has — which machine, which project, which command, which exit code, what was
// already tried automatically. That rediscovery is the expensive part, and it is
// where a runner invents plausible-but-wrong causes. Composing the prompt from
// structured evidence is what turns an LLM call into a diagnosis instead of a
// guess. It is the same lesson as the playbook: pay once, remember forever.

import (
	"fmt"
	"strings"
	"time"
)

// CustodianEscalation is everything the runner needs to work the problem.
type CustodianEscalation struct {
	Finding  CustodianFinding
	WorkDir  string // the project the failure happened in, "" for machine-level
	Command  string // the operation that failed, verbatim
	ExitCode int
	LogTail  []string
	Machine  string // hostname, so a multi-box user knows where this happened
}

// escalationPrompt composes the runner's instructions. It states the facts, the
// boundary, and — importantly — what has ALREADY been tried, so the runner does
// not spend its first tool calls repeating the deterministic lane.
func escalationPrompt(e CustodianEscalation) string {
	var b strings.Builder
	b.WriteString("You are fixing a real failure on a developer's own machine, unattended.\n\n")

	b.WriteString("WHAT FAILED\n")
	if e.Command != "" {
		b.WriteString(fmt.Sprintf("  command:  %s\n", e.Command))
	}
	if e.WorkDir != "" {
		b.WriteString(fmt.Sprintf("  project:  %s\n", e.WorkDir))
	}
	if e.Machine != "" {
		b.WriteString(fmt.Sprintf("  machine:  %s\n", e.Machine))
	}
	if e.ExitCode != 0 {
		b.WriteString(fmt.Sprintf("  exit:     %d\n", e.ExitCode))
	}
	b.WriteString(fmt.Sprintf("  symptom:  %s\n", e.Finding.Problem))

	if len(e.LogTail) > 0 {
		b.WriteString("\nOUTPUT (tail)\n")
		for _, line := range e.LogTail {
			b.WriteString("  " + line + "\n")
		}
	}

	b.WriteString("\nALREADY TRIED AUTOMATICALLY\n")
	b.WriteString("  Yaver's deterministic housekeeping ran first and did not recognise this\n")
	b.WriteString("  failure. Its lookup table already covers: orphaned dev-server processes\n")
	b.WriteString("  holding ports, abandoned streaming sessions holding simulators, npm peer\n")
	b.WriteString("  resolution, Metro cache staleness, the Flutter startup lock, CocoaPods\n")
	b.WriteString("  version skew, adb server wedges and simulator identity drift. Do not\n")
	b.WriteString("  re-try those blind — if you believe one applies, say which and why.\n")

	b.WriteString("\nWHAT TO DO\n")
	b.WriteString("  1. Find the actual cause. Probe the operation, never the proxy: a tool\n")
	b.WriteString("     being on PATH is not it working, a device being listed is not it being\n")
	b.WriteString("     reachable.\n")
	b.WriteString("  2. Fix it in this project or this machine's configuration.\n")
	b.WriteString("  3. Verify by RE-RUNNING the failing command above and showing the output.\n")
	b.WriteString("     An unverified fix is a guess.\n")
	b.WriteString("  4. If the real fix belongs in Yaver itself rather than this machine, say\n")
	b.WriteString("     so explicitly and describe the change — do not paper over it locally.\n")

	b.WriteString("\nBOUNDARIES\n")
	b.WriteString("  • Stay inside this project and this machine's own dev tooling.\n")
	b.WriteString("  • Do NOT delete user data, uninstall apps that hold data, rotate or\n")
	b.WriteString("    revoke credentials, mutate account state, or touch cloud resources.\n")
	b.WriteString("  • Do NOT commit or push. Report what you changed.\n")
	b.WriteString("  • If the fix requires any of the above, STOP and state the exact command\n")
	b.WriteString("    a human should run and why it needs a human.\n")

	b.WriteString("\nEnd with one line starting 'RESULT:' saying fixed / not-fixed and the cause.\n")
	return b.String()
}

// EscalateToRunner starts an autonomous repair task and publishes findings as it
// goes. Returns the task ID, or "" when escalation was declined (over budget, or
// no runner configured) — declining is reported as a finding too, because a
// silent non-escalation is the machine going quiet on the user again.
func (s *HTTPServer) EscalateToRunner(e CustodianEscalation) string {
	now := time.Now()

	if s == nil || s.taskMgr == nil {
		agentCustodian.record(CustodianFinding{
			Warden: e.Finding.Warden, Subject: e.Finding.Subject, At: now,
			Outcome: OutcomeNeedsHuman,
			Problem: e.Finding.Problem,
			Action:  "could not start an automatic repair — no task runner is available on this machine",
			Remedy:  "configure a coding runner (yaver runner auth) so Yaver can diagnose failures like this by itself",
		})
		return ""
	}

	// The same hourly budget the custodian applies to needs-runner findings. A
	// second check here because escalation can also be triggered directly by an
	// operation, not only by a sweep.
	if !agentCustodian.escalationAllowed(e.Finding, now) {
		agentCustodian.record(CustodianFinding{
			Warden: e.Finding.Warden, Subject: e.Finding.Subject, At: now,
			Outcome: OutcomeNeedsHuman,
			Problem: e.Finding.Problem,
			Action:  "not escalated again this hour — automatic repair already tried twice and it is still failing",
			Remedy:  "this one needs a person: the same failure survived two autonomous repair attempts",
		})
		return ""
	}

	title := fmt.Sprintf("Auto-repair: %s", custodianTitleLine(e.Finding.Problem))
	prompt := escalationPrompt(e)

	task, err := s.taskMgr.CreateTaskWithOptions(
		title, prompt, "", "custodian", "", "", nil,
		TaskCreateOptions{WorkDir: e.WorkDir},
	)
	if err != nil {
		agentCustodian.record(CustodianFinding{
			Warden: e.Finding.Warden, Subject: e.Finding.Subject, At: now,
			Outcome: OutcomeNeedsHuman,
			Problem: e.Finding.Problem,
			Action:  "automatic repair could not start: " + err.Error(),
			Remedy:  "check the runner: yaver runner auth status",
		})
		return ""
	}

	agentCustodian.record(CustodianFinding{
		Warden: e.Finding.Warden, Subject: e.Finding.Subject, At: now,
		Outcome: OutcomeNeedsRunner,
		Problem: e.Finding.Problem,
		Action: fmt.Sprintf("started an automatic repair (task %s) — it will diagnose, fix and re-run the failing command",
			shortSessionID(task.ID)),
		Evidence: append([]string{e.Command}, e.LogTail...),
	})
	return task.ID
}

func custodianTitleLine(s string) string {
	s = strings.TrimSpace(strings.SplitN(s, "\n", 2)[0])
	if len(s) > 72 {
		s = s[:72] + "…"
	}
	return s
}
