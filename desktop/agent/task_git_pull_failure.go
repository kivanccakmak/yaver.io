package main

// task_git_pull_failure.go — why the pre-task pull failed, and what fixes it.
//
// THE INCIDENT (2026-08-02). A Vibing run on the owner's box printed:
//
//	[yaver] pre-task git pull skipped: exit status 128 —
//	  From https://github.com/<old-org>/yaver.io (continuing on the local tree)
//
// and carried on. The remote was the PRE-MIGRATION URL: the repo moved orgs on
// 2026-07-17 and this clone never followed. That is not a blip — it can never
// succeed again — so the runner edited a tree of unknown age on every task from
// then on, and said so only as an aside among 41 console events.
//
// Staying NON-FATAL is right and stays: CLAUDE.md forbids putting advisory sync
// in the critical path of the operation it annotates, and pullBeforeSpawn's own
// comment says as much. The defect is not that it continued; it is that a
// PERMANENT CONFIGURATION FAULT and a transient network blip rendered as the
// same sentence, so neither the user nor a future session could tell "retry
// later" from "this will never work until you change a setting".
//
// So: classify, name the cause, and carry the exact command that repairs it —
// the "EVERY FAILURE MUST CARRY A ROUTE TO ITS FIX" rule applied to a line that
// previously carried only a number.

import "strings"

// gitPullFailureKind separates faults that will NEVER self-heal from ones that
// might. The distinction is the whole point: it decides whether the user must
// act, or whether the next task will simply work.
type gitPullFailureKind string

const (
	// gitPullPermanent — the configuration is wrong. Every future task on this
	// clone edits a stale tree until a human changes something.
	gitPullPermanent gitPullFailureKind = "permanent"
	// gitPullTransient — plausibly fine next time (offline, remote hiccup).
	gitPullTransient gitPullFailureKind = "transient"
	// gitPullLocal — the tree itself needs attention (diverged, dirty).
	gitPullLocal gitPullFailureKind = "local"
)

type gitPullFailure struct {
	Kind gitPullFailureKind
	// Reason is one plain sentence naming what actually happened.
	Reason string
	// Remedy is the specific command or action that fixes it. Never
	// "check your configuration" — the cost of a vague remedy is measured in
	// whole sessions (see errSecInternalComponent, 2026-07-19).
	Remedy string
}

// classifyGitPullFailure maps git's own output to a named cause + route.
//
// Deliberately conservative: anything it cannot attribute comes back as
// transient with no remedy, because inventing a remedy for a fault we have not
// identified sends the user to change a setting that was never the problem —
// a false red, and the more expensive kind since it costs them an action.
func classifyGitPullFailure(errText, output string) gitPullFailure {
	m := strings.ToLower(strings.TrimSpace(errText + " " + output))

	switch {
	// ── permanent: the remote itself is wrong or gone ────────────────────
	case strings.Contains(m, "repository not found"),
		strings.Contains(m, "does not appear to be a git repository"),
		strings.Contains(m, "remote: not found"):
		return gitPullFailure{
			Kind:   gitPullPermanent,
			Reason: "the configured git remote does not exist (a moved/renamed repo leaves the old URL resolving but unusable)",
			Remedy: "update it on this box: git -C <clone> remote set-url origin <current-url>",
		}

	case strings.Contains(m, "could not read username"),
		strings.Contains(m, "authentication failed"),
		strings.Contains(m, "terminal prompts disabled"),
		strings.Contains(m, "permission denied (publickey)"):
		return gitPullFailure{
			Kind:   gitPullPermanent,
			Reason: "this box has no usable credential for the git remote, so the pull could not authenticate",
			Remedy: "sign the box in: yaver git oauth, or add a deploy key for that remote",
		}

	// ── local: the tree needs a decision a pull cannot make ──────────────
	case strings.Contains(m, "not possible to fast-forward"),
		strings.Contains(m, "diverging branches"),
		strings.Contains(m, "have diverged"):
		return gitPullFailure{
			Kind:   gitPullLocal,
			Reason: "the clone has diverged from the remote, so a fast-forward pull is not possible",
			Remedy: "reconcile it on this box (rebase or merge) before the next task, or the runner keeps working from the local branch",
		}

	case strings.Contains(m, "local changes"),
		strings.Contains(m, "would be overwritten"):
		return gitPullFailure{
			Kind:   gitPullLocal,
			Reason: "uncommitted local changes block the fast-forward",
			Remedy: "commit or stash them on this box so the clone can track the remote again",
		}

	// ── transient: plausibly fine next time ──────────────────────────────
	case strings.Contains(m, "could not resolve host"),
		strings.Contains(m, "connection timed out"),
		strings.Contains(m, "network is unreachable"),
		strings.Contains(m, "operation timed out"):
		return gitPullFailure{
			Kind:   gitPullTransient,
			Reason: "the git remote was unreachable from this box just now",
			Remedy: "",
		}
	}

	// Unattributed. Say nothing prescriptive.
	return gitPullFailure{Kind: gitPullTransient, Reason: "", Remedy: ""}
}

// describeGitPullFailure renders the task line.
//
// A permanent fault is stated as permanent — "this will not fix itself" — so a
// reader does not spend the next five tasks assuming it will. A transient one
// keeps the old, quiet wording: over-narrating a blip is its own noise.
func describeGitPullFailure(errText, output string) string {
	f := classifyGitPullFailure(errText, output)
	head := "[yaver] pre-task git pull skipped: " + strings.TrimSpace(errText)
	if f.Reason == "" {
		return head + " — " + taskGitFirstLine(output) + " (continuing on the local tree)"
	}
	line := head + " — " + f.Reason + " (continuing on the local tree, so this task may be editing STALE code)"
	if f.Kind == gitPullPermanent {
		line += ". This will not fix itself"
	}
	if f.Remedy != "" {
		line += ". Fix: " + f.Remedy
	}
	return line
}
