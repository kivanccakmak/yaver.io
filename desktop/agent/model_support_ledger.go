package main

// model_support_ledger.go — remember which models THIS box's runner login has
// actually refused, and stop sending them.
//
// ── The incident (2026-08-02, reproduced live three times) ──────────────────
//
// Vibing dispatched `gpt-5.4` at a Codex runner signed in with a ChatGPT
// account. Every run died the same way:
//
//	warning: Model metadata for `gpt-5.4` not found. Defaulting to fallback
//	         metadata; this can degrade performance and cause issues.
//	ERROR: {"status":400,"error":{"type":"invalid_request_error","message":
//	        "The 'gpt-5.4' model is not supported when using Codex with a
//	         ChatGPT account."}}
//
// The user changed nothing and got the identical failure on every retry,
// because nothing in the loop remembered the previous refusal.
//
// ── Why the existing guard could not catch it ──────────────────────────────
//
// effectiveModelFor already implements the right REMEDY and says so:
//
//	"Dropping beats failing here: with no --model the CLI uses its own
//	 configured default … the only value on the box that is actually known
//	 to work."
//
// But it gates on runnerModelCompatible, a NAME heuristic —
// `strings.HasPrefix(m, "gpt")` is true for gpt-5.4, so the model sails
// through. That heuristic answers "is this model plausibly for this runner",
// which is a different question from "can THIS ACCOUNT run it". No amount of
// string-shape reasoning can answer the second one: entitlement lives on the
// provider's side and differs per login and per plan.
//
// The only thing that knows is the operation, and the operation already told
// us — once per run, in a stable sentence the repo classifies in five places.
// So: LEARN IT, then let the existing drop-remedy fire.
//
// ── Why a ledger and not a hardcoded table ─────────────────────────────────
//
// Because entitlements move. gpt-5.4 works on an API-billed account and not on
// this ChatGPT one; a model absent today can be included next month. A table
// invented now is a false green later, and — worse — a permanent blacklist is a
// false RED that hides a model the user is entitled to. Observations expire
// (see ttl) so a re-enabled model comes back on its own.
//
// Scope is deliberately (runner, model) on THIS BOX, persisted next to the
// agent's other state: entitlement follows the login, and the login is
// per-machine. Another box with a different account is unaffected.

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// modelRefusalTTL is how long a refusal is trusted.
//
// Long enough that a user is not made to re-discover the same 400 every hour;
// short enough that a plan upgrade or a provider change heals itself without
// anyone editing code. On expiry the pair returns to "unknown" — offered again,
// and re-learned in one run if it still fails.
const modelRefusalTTL = 14 * 24 * time.Hour

type modelRefusal struct {
	Runner string    `json:"runner"`
	Model  string    `json:"model"`
	At     time.Time `json:"at"`
	// Reason is kept verbatim so a future reader (or a support session) can see
	// WHAT the provider said, not just that something failed.
	Reason string `json:"reason,omitempty"`
}

type modelSupportLedger struct {
	mu   sync.RWMutex
	byID map[string]modelRefusal
	path string
}

var globalModelSupport = &modelSupportLedger{byID: map[string]modelRefusal{}}

func modelRefusalKey(runnerID, model string) string {
	return normalizeRunnerID(runnerID) + "\x00" + strings.ToLower(strings.TrimSpace(model))
}

func modelSupportLedgerPath() string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	return filepath.Join(home, ".yaver", "model-refusals.json")
}

// Load reads persisted refusals. Best-effort: a missing or corrupt file means
// we start empty, which only costs one re-learn — never a crash and never a
// wrong refusal.
func (l *modelSupportLedger) Load() {
	p := modelSupportLedgerPath()
	if p == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.path = p
	b, err := os.ReadFile(p)
	if err != nil {
		return
	}
	var rows []modelRefusal
	if json.Unmarshal(b, &rows) != nil {
		return
	}
	now := time.Now()
	for _, r := range rows {
		if now.Sub(r.At) < modelRefusalTTL {
			l.byID[modelRefusalKey(r.Runner, r.Model)] = r
		}
	}
}

func (l *modelSupportLedger) persistLocked() {
	if l.path == "" {
		return
	}
	rows := make([]modelRefusal, 0, len(l.byID))
	for _, r := range l.byID {
		rows = append(rows, r)
	}
	b, err := json.MarshalIndent(rows, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(l.path), 0o700)
	_ = os.WriteFile(l.path, b, 0o600)
}

// Record marks (runner, model) as refused by this box's login.
func (l *modelSupportLedger) Record(runnerID, model, reason string) {
	m := strings.TrimSpace(model)
	if m == "" || normalizeRunnerID(runnerID) == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.byID[modelRefusalKey(runnerID, m)] = modelRefusal{
		Runner: normalizeRunnerID(runnerID), Model: m, At: time.Now(), Reason: reason,
	}
	l.persistLocked()
	log.Printf("[model] %s refused %q on this machine — future tasks fall back to the CLI's own default. Reason: %s",
		normalizeRunnerID(runnerID), m, reason)
}

// Refused reports whether we have seen this exact pair refused recently.
func (l *modelSupportLedger) Refused(runnerID, model string) bool {
	m := strings.TrimSpace(model)
	if m == "" {
		return false
	}
	l.mu.RLock()
	defer l.mu.RUnlock()
	r, ok := l.byID[modelRefusalKey(runnerID, m)]
	if !ok {
		return false
	}
	return time.Since(r.At) < modelRefusalTTL
}

// Forget drops a fact — used when the user proves the model works.
func (l *modelSupportLedger) Forget(runnerID, model string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.byID, modelRefusalKey(runnerID, model))
	l.persistLocked()
}

// classifyUnsupportedModel extracts (model, reason) from runner output that
// says the ACCOUNT cannot use the model.
//
// Deliberately narrow. It must see BOTH an entitlement phrase AND a quoted
// model name, or it returns "". Recording the wrong model would suppress one
// the user is entitled to — a false red that is worse than the bug being
// fixed, because the user cannot see why their choice stopped being honoured.
// An auth failure, a rate limit, or a compile error must never land here.
func classifyUnsupportedModel(output string) (model string, reason string) {
	m := strings.ToLower(output)
	entitlement := (strings.Contains(m, "model is not supported") && strings.Contains(m, "account")) ||
		strings.Contains(m, "does not have access to model") ||
		strings.Contains(m, "unsupported model")
	if !entitlement {
		return "", ""
	}
	// Pull the first quoted token — providers quote the model name.
	for _, q := range []string{"'", "‘", "`", "\""} {
		i := strings.Index(output, q)
		if i < 0 {
			continue
		}
		rest := output[i+len(q):]
		for _, cq := range []string{"'", "’", "`", "\""} {
			j := strings.Index(rest, cq)
			if j <= 0 {
				continue
			}
			cand := strings.TrimSpace(rest[:j])
			// A model name has no spaces and is not a whole sentence.
			if cand != "" && !strings.Contains(cand, " ") && len(cand) <= 64 {
				return cand, firstLineOf(output)
			}
		}
	}
	return "", ""
}

func firstLineOf(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

// noteRunnerOutputForModelSupport is the single entry point task/runner output
// should call. Safe to call on every chunk: it no-ops unless the output is a
// genuine entitlement refusal naming a model.
func noteRunnerOutputForModelSupport(runnerID, output string) {
	model, reason := classifyUnsupportedModel(output)
	if model == "" {
		return
	}
	globalModelSupport.Record(runnerID, model, reason)
}
