package main

// Terminal-state transitions for the runner browser-auth session machine.
//
// Two real bugs these tests pin down (found in the 2026-07 failure-recovery
// audit):
//
//  1. `cmd.Wait` used to overwrite `account_not_eligible` with `failed`
//     ("exit status 1") the moment the CLI exited — the verbatim entitlement
//     message ("Login failed: … no active subscription …") was demoted to a
//     generic failure, so every surface rendered "failed" instead of the one
//     status that tells the user retrying can never work.
//  2. The cancel handler flipped ANY session to `cancelled`, including one
//     that had already `completed` — a late × click un-reported a successful
//     sign-in.

import (
	"errors"
	"strings"
	"testing"
)

func TestRunnerBrowserAuthTerminal(t *testing.T) {
	terminal := []string{"completed", "failed", "cancelled", "account_not_eligible"}
	for _, s := range terminal {
		if !runnerBrowserAuthTerminal(s) {
			t.Errorf("status %q must be terminal", s)
		}
	}
	nonTerminal := []string{"starting", "awaiting_browser", "verifying", ""}
	for _, s := range nonTerminal {
		if runnerBrowserAuthTerminal(s) {
			t.Errorf("status %q must NOT be terminal", s)
		}
	}
}

func TestRunnerBrowserAuthExitPreservesAccountNotEligible(t *testing.T) {
	quote := "Login failed: This account does not have an active subscription."
	// The CLI prints the entitlement rejection, then exits non-zero. The
	// exit must not demote the diagnosis to a generic "failed".
	st := &runnerBrowserAuthSession{Status: "account_not_eligible", Detail: quote}
	applyRunnerBrowserAuthExit(st, errors.New("exit status 1"), false)
	if st.Status != "account_not_eligible" {
		t.Fatalf("exit clobbered account_not_eligible → %q", st.Status)
	}
	if st.Detail != quote {
		t.Fatalf("verbatim entitlement message lost: %q", st.Detail)
	}
	// Exit code 0 must not fake a success either (kimi exits 0 after
	// printing the rejection).
	st = &runnerBrowserAuthSession{Status: "account_not_eligible", Detail: quote}
	applyRunnerBrowserAuthExit(st, nil, false)
	if st.Status != "account_not_eligible" {
		t.Fatalf("clean exit turned account_not_eligible into %q (false green)", st.Status)
	}
	if st.CompletedAt == 0 {
		t.Fatalf("terminal transition must stamp CompletedAt")
	}
}

func TestRunnerBrowserAuthExitNormalTransitions(t *testing.T) {
	st := &runnerBrowserAuthSession{Status: "verifying"}
	applyRunnerBrowserAuthExit(st, nil, false)
	if st.Status != "completed" {
		t.Fatalf("clean exit: want completed, got %q", st.Status)
	}

	st = &runnerBrowserAuthSession{Status: "awaiting_browser"}
	applyRunnerBrowserAuthExit(st, errors.New("exit status 2"), false)
	if st.Status != "failed" || st.Error != "exit status 2" {
		t.Fatalf("failure exit: got status=%q error=%q", st.Status, st.Error)
	}
	if st.Detail == "" {
		t.Fatalf("failed exit must carry a detail for the UI")
	}

	st = &runnerBrowserAuthSession{Status: "awaiting_browser"}
	applyRunnerBrowserAuthExit(st, errors.New("signal: killed"), true)
	if st.Status != "cancelled" {
		t.Fatalf("cancelled exit: want cancelled, got %q", st.Status)
	}
}

func TestRunnerBrowserAuthDeadline(t *testing.T) {
	// A session whose OAuth callback never arrives must not stay "pending"
	// forever (handoff item 3: the agent only reaped stale sessions when a
	// NEW spawn for the same runner arrived). The deadline converts the
	// eternal wait into a failed status with a named remedy.
	st := &runnerBrowserAuthSession{Status: "awaiting_browser"}
	if !applyRunnerBrowserAuthDeadline(st) {
		t.Fatalf("deadline on active session must apply")
	}
	if st.Status != "failed" || st.CompletedAt == 0 {
		t.Fatalf("deadline: got status=%q completedAt=%d", st.Status, st.CompletedAt)
	}
	if !strings.Contains(st.Error, "Restart the sign-in") {
		t.Fatalf("deadline error must name the remedy, got %q", st.Error)
	}
	// Terminal sessions are left alone — the deadline must never rewrite a
	// completed sign-in or an entitlement verdict.
	for _, s := range []string{"completed", "failed", "cancelled", "account_not_eligible"} {
		st := &runnerBrowserAuthSession{Status: s}
		if applyRunnerBrowserAuthDeadline(st) {
			t.Errorf("deadline clobbered terminal %q", s)
		}
	}
}

func TestRunnerBrowserAuthCancelDoesNotClobberTerminal(t *testing.T) {
	for _, s := range []string{"completed", "failed", "account_not_eligible"} {
		st := &runnerBrowserAuthSession{Status: s, Detail: "kept"}
		if applyRunnerBrowserAuthCancel(st) {
			t.Errorf("cancel on terminal %q reported a change", s)
		}
		if st.Status != s || st.Detail != "kept" {
			t.Errorf("cancel clobbered terminal %q → %q", s, st.Status)
		}
	}
	st := &runnerBrowserAuthSession{Status: "awaiting_browser"}
	if !applyRunnerBrowserAuthCancel(st) {
		t.Fatalf("cancel on active session must apply")
	}
	if st.Status != "cancelled" || st.Detail == "" || st.CompletedAt == 0 {
		t.Fatalf("cancel: got status=%q detail=%q completedAt=%d", st.Status, st.Detail, st.CompletedAt)
	}
}
