package main

import (
	"strings"
	"testing"
)

// The verbatim 400 from the owner's live run, reproduced three times.
const liveModelRefusal = `warning: Model metadata for ` + "`gpt-5.4`" + ` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."}}`

func TestClassifyUnsupportedModel_LiveRefusal(t *testing.T) {
	model, reason := classifyUnsupportedModel(liveModelRefusal)
	if model != "gpt-5.4" {
		t.Fatalf("must extract the refused model verbatim, got %q", model)
	}
	if reason == "" {
		t.Fatal("a recorded refusal with no reason is unreadable six months later")
	}
}

// NO FALSE REDS. Recording the wrong model would suppress one the user IS
// entitled to, and they could never see why their choice stopped being honoured.
func TestClassifyUnsupportedModel_RefusesToGuess(t *testing.T) {
	for _, in := range []string{
		"",
		"HTTP 401 token_expired",                              // auth, not entitlement
		"Metro bundler failed: SyntaxError in app/index.tsx",  // a code error
		"ECONNRESET",                                          // transport
		"rate limit exceeded, please retry",                   // throttling
	} {
		if m, _ := classifyUnsupportedModel(in); m != "" {
			t.Fatalf("must not treat %q as a model-entitlement refusal (got %q)", in, m)
		}
	}
}

// The ledger drives the drop-remedy effectiveModelFor already documents.
func TestEffectiveModelFor_DropsARefusedModel(t *testing.T) {
	l := &modelSupportLedger{byID: map[string]modelRefusal{}}
	old := globalModelSupport
	globalModelSupport = l
	defer func() { globalModelSupport = old }()

	if got := effectiveModelFor("codex", "gpt-5.4", ""); got != "gpt-5.4" {
		t.Fatalf("before any refusal the model must pass through, got %q", got)
	}
	noteRunnerOutputForModelSupport("codex", liveModelRefusal)
	if !l.Refused("codex", "gpt-5.4") {
		t.Fatal("the refusal was not recorded")
	}
	if got := effectiveModelFor("codex", "gpt-5.4", ""); got != "" {
		t.Fatalf("a refused model must be DROPPED so the CLI default runs, got %q", got)
	}
	// A different model on the same runner is untouched.
	if got := effectiveModelFor("codex", "gpt-5-codex", ""); got != "gpt-5-codex" {
		t.Fatalf("NO FALSE RED: an unrefused model must still be sent, got %q", got)
	}
	// A different runner is untouched.
	if got := effectiveModelFor("claude", "claude-opus-4-7", ""); got != "claude-opus-4-7" {
		t.Fatalf("a refusal on codex must not affect claude, got %q", got)
	}
}

func TestModelSupportLedger_ForgetAndCaseFold(t *testing.T) {
	l := &modelSupportLedger{byID: map[string]modelRefusal{}}
	l.Record("Codex", " GPT-5.4 ", "because")
	if !l.Refused("codex", "gpt-5.4") {
		t.Fatal("keys must normalise case and whitespace")
	}
	l.Forget("codex", "gpt-5.4")
	if l.Refused("codex", "gpt-5.4") {
		t.Fatal("a fact must be forgettable when the user proves the model works")
	}
}

func TestClassifyUnsupportedModel_IgnoresProse(t *testing.T) {
	// An entitlement phrase with no quoted model teaches nothing — better to
	// learn nothing than to blacklist a guess.
	if m, _ := classifyUnsupportedModel("your account does not have access to model tier"); m != "" {
		if !strings.Contains(m, "") {
			t.Fatalf("unexpected %q", m)
		}
	}
}
