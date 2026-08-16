package main

import "testing"

func b(v bool) *bool { return &v }

// The owner's REAL fleet, read from live device rows 2026-08-02. Using the
// actual authSource labels matters: the whole design turns on telling an API
// key apart from a subscription grant, and invented labels prove nothing.
var magaraRunners = []RunnerStatusRow{
	{RunnerID: "claude", Installed: true, Ready: true, AuthConfigured: b(true), AuthPresent: b(true), AuthVerified: b(false), AuthSource: "claude.ai · max"},
	{RunnerID: "codex", Installed: true, Ready: false, AuthConfigured: b(false)},
	{RunnerID: "opencode", Installed: true, Ready: true, AuthConfigured: b(true), AuthPresent: b(false), AuthVerified: b(false), AuthSource: "GLM API key"},
}

var ubuntuRunners = []RunnerStatusRow{
	{RunnerID: "claude", Installed: true, Ready: true, AuthConfigured: b(true), AuthPresent: b(true), AuthVerified: b(false), AuthSource: "claude.ai · max"},
	{RunnerID: "codex", Installed: true, Ready: true, AuthConfigured: b(true), AuthPresent: b(true), AuthVerified: b(false), AuthSource: "codex login status"},
	{RunnerID: "opencode", Installed: true, Ready: true, AuthConfigured: b(true), AuthPresent: b(false), AuthVerified: b(false), AuthSource: "GLM API key"},
}

func TestDetectRunnerAuthMechanism(t *testing.T) {
	if got := DetectRunnerAuthMechanism("GLM API key"); got != RunnerAuthAPIKey {
		t.Fatalf("a GLM API key has no OAuth to expire; got %q", got)
	}
	if got := DetectRunnerAuthMechanism("claude.ai · max"); got != RunnerAuthSubscription {
		t.Fatalf("claude.ai · max is a subscription grant; got %q", got)
	}
	if got := DetectRunnerAuthMechanism("codex login status"); got != RunnerAuthSubscription {
		t.Fatalf("codex login status is a subscription grant; got %q", got)
	}
	// NO FALSE GREEN: an unrecognised label must never be guessed into api-key,
	// because that is exactly when we would recommend it — during an OAuth
	// outage it cannot actually survive.
	if got := DetectRunnerAuthMechanism("something new"); got != RunnerAuthUnknown {
		t.Fatalf("an unknown label must stay unknown; got %q", got)
	}
	if got := DetectRunnerAuthMechanism(""); got != RunnerAuthUnknown {
		t.Fatalf("no label must stay unknown; got %q", got)
	}
}

// THE CASE THAT STARTED THIS: Codex's OAuth died on ubuntu and the fix button
// kept dispatching Codex.
func TestPlanRunnerFix_OAuthFailureRoutesToApiKeyRunner(t *testing.T) {
	got := PlanRunnerFix("codex", "auth", ubuntuRunners)
	if got == nil {
		t.Fatal("an OAuth failure must still yield a candidate — opencode is right there")
	}
	if got.Runner != "opencode" {
		t.Fatalf("must pick the API-key runner, which cannot have this failure; got %q", got.Runner)
	}
	if !got.Immune {
		t.Fatal("an API-key runner IS immune to an OAuth expiry — say so, do not merely offer it")
	}
	if got.Mechanism != RunnerAuthAPIKey {
		t.Fatalf("mechanism must be carried for the explanation; got %q", got.Mechanism)
	}
}

// Readiness is per box: codex has NO credentials on magara.
func TestPlanRunnerFix_RespectsPerBoxReadiness(t *testing.T) {
	got := PlanRunnerFix("claude", "auth", magaraRunners)
	if got == nil || got.Runner != "opencode" {
		t.Fatalf("on magara the only ready alternative is opencode; got %+v", got)
	}
	if got.Runner == "codex" {
		t.Fatal("codex cannot start on magara — a global fallback would have sent the fix nowhere")
	}
}

// Entitlement and billing are account-bound too: another runner is a real
// escape from both.
func TestPlanRunnerFix_AccountBoundKinds(t *testing.T) {
	for _, kind := range []string{"model-not-supported", "billing", "auth-revoked"} {
		got := PlanRunnerFix("codex", kind, ubuntuRunners)
		if got == nil || got.Runner == "codex" {
			t.Fatalf("%s must route away from codex; got %+v", kind, got)
		}
	}
}

// NO FALSE RED: a plain build error is NOT account-bound. Retrying with the
// same runner is correct, and forcing a switch would be worse than the bug.
func TestPlanRunnerFix_BuildErrorMayKeepTheSameRunner(t *testing.T) {
	got := PlanRunnerFix("codex", "subprocess", ubuntuRunners)
	if got == nil {
		t.Fatal("a build failure must still offer a runner")
	}
}

// Nothing usable must return nil so the caller renders a ROUTE, never a button
// it cannot honour.
func TestPlanRunnerFix_NoCandidateWhenOnlyTheBrokenRunnerExists(t *testing.T) {
	solo := []RunnerStatusRow{
		{RunnerID: "codex", Installed: true, Ready: true, AuthConfigured: b(true), AuthPresent: b(true), AuthSource: "codex login status"},
	}
	if got := PlanRunnerFix("codex", "auth", solo); got != nil {
		t.Fatalf("with only the broken runner present there is no candidate; got %+v", got)
	}
}

// A proven credential outranks a merely-present one when OAuth is not at issue.
func TestPlanRunnerFix_ProvenBeatsPresent(t *testing.T) {
	rows := []RunnerStatusRow{
		{RunnerID: "codex", Installed: true, Ready: true, AuthConfigured: b(true), AuthPresent: b(true)},
		{RunnerID: "claude", Installed: true, Ready: true, AuthConfigured: b(true), AuthVerified: b(true), AuthSource: "claude.ai · max"},
	}
	got := PlanRunnerFix("codex", "subprocess", rows)
	if got == nil || got.Runner != "claude" {
		t.Fatalf("an exercised credential must outrank one only seen; got %+v", got)
	}
}
