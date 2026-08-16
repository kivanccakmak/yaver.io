package main

import (
	"context"
	"encoding/json"
	"testing"
)

// The circuit capability scope is the auth layer that lets an external product
// (Talos, OCPP) drive ONLY the circuit simulator on a Yaver box and nothing
// else. These tests pin that isolation: a "circuit" service credential can
// invoke circuit_* verbs and is refused every other verb.

func TestCapabilityScopeAuthzMatrix(t *testing.T) {
	ownerOnly := opsVerbSpec{Name: "exec_command", AllowCompanion: false}
	companionOK := opsVerbSpec{Name: "feedback_submit", AllowCompanion: true}
	circuitVerb := opsVerbSpec{Name: "circuit_simulate", AllowCompanion: false}

	cases := []struct {
		scope string
		verb  string
		spec  opsVerbSpec
		want  bool
	}{
		// circuit scope: ONLY circuit_* verbs, nothing else
		{"circuit", "circuit_simulate", circuitVerb, true},
		{"circuit", "circuit_erc", circuitVerb, true},
		{"circuit", "exec_command", ownerOnly, false}, // no host exec
		{"circuit", "feedback_submit", companionOK, false},
		{"circuit", "vault_get", ownerOnly, false}, // no vault
	}
	for _, c := range cases {
		if got := scopedVerbAllowed("capability", c.scope, c.verb, c.spec); got != c.want {
			t.Errorf("scopedVerbAllowed(capability, scope=%q verb=%q) = %v, want %v", c.scope, c.verb, got, c.want)
		}
	}

	if !isCapabilityScope("circuit") {
		t.Error("circuit should be a capability scope")
	}
	if isCapabilityScope("full") || isCapabilityScope("deploy") || isCapabilityScope("") {
		t.Error("broad tiers must NOT be capability scopes")
	}
}

// End-to-end through dispatchOps: a circuit capability is refused both an
// owner-only verb and a companion-exposed verb (the denial is decided at the gate,
// before any machine routing). Proves the OpsContext.Scope wiring is live.
func TestCircuitScopeDispatchIsolation(t *testing.T) {
	registerOpsVerb(opsVerbSpec{Name: "zzz_probe_owner_iso", AllowCompanion: false, Handler: func(OpsContext, json.RawMessage) OpsResult { return OpsResult{OK: true} }})
	registerOpsVerb(opsVerbSpec{Name: "zzz_probe_companion_iso", AllowCompanion: true, Handler: func(OpsContext, json.RawMessage) OpsResult { return OpsResult{OK: true} }})

	circuitCredential := OpsContext{Ctx: context.Background(), Server: &HTTPServer{}, Caller: "capability", Scope: "circuit"}

	// owner-only verb → refused
	if r := dispatchOps(circuitCredential, OpsRequest{Verb: "zzz_probe_owner_iso", Machine: "local"}); r.Code != "unauthorized" {
		t.Fatalf("circuit credential reached owner verb: code=%q ok=%v", r.Code, r.OK)
	}
	// Companion-exposed verb → STILL refused (capability scope is a strict allowlist)
	if r := dispatchOps(circuitCredential, OpsRequest{Verb: "zzz_probe_companion_iso", Machine: "local"}); r.Code != "unauthorized" {
		t.Fatalf("circuit credential reached a non-circuit verb: code=%q ok=%v", r.Code, r.OK)
	}
}
