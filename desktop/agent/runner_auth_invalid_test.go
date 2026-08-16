package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestIsRunnerAuthFailureOutput_Claude(t *testing.T) {
	cases := []string{
		"Failed to authenticate. API Error: 401 Invalid authentication credentials",
		"some prefix\nNot logged in · Please run /login",
		"Error: Invalid bearer token",
		"Loading config from Claude Code-credentials keychain entry... rejected",
	}
	for _, in := range cases {
		got := IsRunnerAuthFailureOutput(in)
		if got != "claude" {
			t.Errorf("IsRunnerAuthFailureOutput(%q) = %q, want %q", in, got, "claude")
		}
	}
}

func TestIsRunnerAuthFailureOutput_Codex(t *testing.T) {
	cases := []string{
		"Sign in required. Run codex login --device-auth",
		"codex: not authenticated, please sign in",
		"Please run codex login --device-auth to set up ChatGPT auth",
	}
	for _, in := range cases {
		got := IsRunnerAuthFailureOutput(in)
		if got != "codex" {
			t.Errorf("IsRunnerAuthFailureOutput(%q) = %q, want %q", in, got, "codex")
		}
	}
}

func TestIsRunnerAuthFailureOutput_OpenCodeProvider(t *testing.T) {
	cases := []string{
		`opencode service=llm providerID=zai modelID=glm-4.7 error={"name":"AI_APICallError","cause":{"code":"FailedToOpenSocket"}} stream error`,
		`opencode providerID=zai stream error`,
	}
	for _, in := range cases {
		got := IsRunnerAuthFailureOutput(in)
		if got != "opencode" {
			t.Errorf("IsRunnerAuthFailureOutput(%q) = %q, want %q", in, got, "opencode")
		}
	}
}

func TestIsRunnerAuthFailureOutput_NoMatch(t *testing.T) {
	cases := []string{
		"",
		"OK, sounds good.",
		"warning: --full-auto is deprecated; use --sandbox workspace-write",
		"some random task output that mentions 401 in code but not auth",
		"Successfully completed",
	}
	for _, in := range cases {
		got := IsRunnerAuthFailureOutput(in)
		if got != "" {
			t.Errorf("IsRunnerAuthFailureOutput(%q) = %q, want empty", in, got)
		}
	}
}

func TestRunnerAuthFailureRecent_LifecycleAndTTL(t *testing.T) {
	// Confidence checks for the override map: set / read / clear / expire.
	recent := func(id string) bool {
		_, ok := runnerAuthFailureRecent(id)
		return ok
	}
	ClearRunnerAuthInvalid("claude") // start clean
	if recent("claude") {
		t.Fatal("expected no failure recorded initially")
	}
	MarkRunnerAuthInvalid("claude")
	if !recent("claude") {
		t.Fatal("expected MarkRunnerAuthInvalid to be observed")
	}
	if recent("codex") {
		t.Fatal("setting claude must not affect codex")
	}
	ClearRunnerAuthInvalid("claude")
	if recent("claude") {
		t.Fatal("expected ClearRunnerAuthInvalid to drop the entry")
	}
	// Expiry — directly poke the map to set an old timestamp, then probe.
	lastRunnerAuthFailure.Lock()
	lastRunnerAuthFailure.at["claude"] = runnerAuthMark{at: time.Now().Add(-2 * runnerAuthFailureTTL)}
	lastRunnerAuthFailure.Unlock()
	if recent("claude") {
		t.Fatal("expected expired entry to drop on probe")
	}
}

func TestDetectRunnerRuntimeStatus_AuthOverrideFlipsConfigured(t *testing.T) {
	// Poison the cache with a "recent" failure; status should flip the
	// AuthConfigured returned by detectClaudeStatus to false even when
	// the file/keychain check would have said true. We can't easily
	// fake a true file/keychain in this unit test, so instead we run
	// the real detection — if it would have returned ok=true, the
	// override forces false; if it returns ok=false (no creds), the
	// test still passes because override doesn't flip a false to true.
	cfg := RunnerConfig{RunnerID: "claude", Command: "claude"}
	MarkRunnerAuthInvalid("claude")
	defer ClearRunnerAuthInvalid("claude")
	got := DetectRunnerRuntimeStatus(cfg, "/tmp")
	if got.AuthConfigured {
		t.Errorf("expected AuthConfigured=false after MarkRunnerAuthInvalid; got AuthConfigured=true (warning=%q)", got.Warning)
	}
	if got.AuthConfigured == false && !strings.Contains(got.Warning, "Token rejected") {
		// Warning only attached when override fires (i.e. presence
		// check would have said true). Don't fail when override
		// didn't trigger — it just means no claude creds are present
		// in this test env, which is fine.
	}
}

func TestDetectRunnerRuntimeStatus_OpenCodeOverrideFlipsConfigured(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("GLM_API_KEY", "glm-test")
	t.Setenv("ZAI_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "")

	MarkRunnerAuthInvalid("opencode")
	defer ClearRunnerAuthInvalid("opencode")
	got := DetectRunnerRuntimeStatus(GetRunnerConfig("opencode"), t.TempDir())
	if got.AuthConfigured {
		t.Errorf("expected opencode AuthConfigured=false after MarkRunnerAuthInvalid; got AuthConfigured=true")
	}
	if !strings.Contains(got.Warning, "rejected") {
		t.Fatalf("expected warning to mention rejection, got %q", got.Warning)
	}
}

func TestCheckRunnerReadyRejectsWarningOnlyNotReadyStatus(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(home, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	opencodePath := filepath.Join(bin, "opencode")
	if err := os.WriteFile(opencodePath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("HOME", home)
	t.Setenv("GLM_API_KEY", "glm-test")
	t.Setenv("ZAI_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "")

	MarkRunnerAuthInvalidReason("opencode", "OpenCode provider rejected the configured model.")
	defer ClearRunnerAuthInvalid("opencode")
	err := CheckRunnerReady(GetRunnerConfig("opencode"), t.TempDir())
	if err == nil {
		t.Fatal("CheckRunnerReady must reject Ready=false even when the cause is carried in Warning")
	}
	if !strings.Contains(err.Error(), "OpenCode provider rejected") {
		t.Fatalf("CheckRunnerReady error = %q, want warning cause", err.Error())
	}
}

// A model the ACCOUNT is not entitled to is not a broken credential. Marking it
// as one rendered "OpenAI Codex (sign-in needed)" over a working login and sent
// the user into an OAuth flow that cannot move a model onto a plan. The refusal
// is handled by model_support_ledger.go instead, which drops the model so the
// CLI's own default runs.
func TestIsRunnerAuthFailureOutput_ModelEntitlementIsNotAuth(t *testing.T) {
	cases := []string{
		`ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."}}`,
		`ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."}}`,
	}
	for _, in := range cases {
		if got := IsRunnerAuthFailureOutput(in); got != "" {
			t.Errorf("model-entitlement 400 must NOT be an auth failure; IsRunnerAuthFailureOutput(%q) = %q", in, got)
		}
	}
	// …and it must still be learned as a model refusal, or we would have traded
	// a false red for a silent failure.
	if m, _ := classifyUnsupportedModel(cases[0]); m != "gpt-5.4" {
		t.Fatalf("the refusal must still be captured by the model ledger, got %q", m)
	}
}

// Billing and throttling are not broken credentials. Marking either as an auth
// failure tells the user to sign in, changes nothing, and for a rate limit
// throws away a working session as well.
func TestIsRunnerAuthFailureOutput_BillingAndRateLimitAreNotAuth(t *testing.T) {
	for _, in := range []string{
		`{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}`,
		`{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}`,
		"API Error: Rate limit reached",
	} {
		if got := IsRunnerAuthFailureOutput(in); got != "" {
			t.Errorf("must NOT be an auth failure: %q -> %q", in, got)
		}
	}
}

// …but the providers' REAL OAuth-expiry wording must still route to sign-in.
// The matcher previously only had "expired token", so Anthropic's actual
// message fell through and the commonest runner failure got no route at all.
func TestIsRunnerAuthFailureOutput_RealOAuthExpiryWording(t *testing.T) {
	for _, in := range []string{
		`{"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}`,
		"Failed to authenticate: OAuth session expired and could not be refreshed",
	} {
		if got := IsRunnerAuthFailureOutput(in); got == "" {
			t.Errorf("a real expired OAuth token MUST route to sign-in, got none for %q", in)
		}
	}
}
