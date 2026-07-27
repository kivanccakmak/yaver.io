package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func powerSpec(t *testing.T) opsVerbSpec {
	t.Helper()
	for _, v := range listOpsVerbs() {
		if v.Name == "infra_power" {
			return v
		}
	}
	t.Fatal("infra_power is not a registered ops verb")
	return opsVerbSpec{}
}

// The relay is multi-tenant and the repo is public. Rebooting someone's machine
// is the single most destructive verb we expose; it must never be guest-callable.
func TestInfraPowerIsNeverGuestCallable(t *testing.T) {
	spec := powerSpec(t)
	if spec.AllowGuest {
		t.Fatal("infra_power must never be reachable by a guest — a guest could power off the owner's box")
	}
	// Capability scopes bypass AllowGuest via a verb-name prefix. Make sure this
	// verb cannot be smuggled in by one of them.
	for scope, prefix := range capabilityScopeVerbPrefix {
		if strings.HasPrefix("infra_power", prefix) {
			t.Errorf("infra_power matches capability scope %q prefix %q — it would become guest-reachable", scope, prefix)
		}
		if guestVerbAllowed(scope, "infra_power", spec) {
			t.Errorf("guestVerbAllowed(%q, infra_power) = true, want false", scope)
		}
	}
	for _, scope := range []string{"full", "feedback-only", "deploy", "support", "sdk-project", ""} {
		if guestVerbAllowed(scope, "infra_power", spec) {
			t.Errorf("guest scope %q must not be allowed to call infra_power", scope)
		}
	}
}

// Asking what a machine COULD do must never require agreeing to do it.
func TestPowerReportNeedsNoConfirm(t *testing.T) {
	res := opsInfraPowerHandler(OpsContext{}, json.RawMessage(`{"action":"report"}`))
	if !res.OK {
		t.Fatalf("report should succeed without confirm; got code=%q err=%q", res.Code, res.Error)
	}
	initial, ok := res.Initial.(map[string]interface{})
	if !ok {
		t.Fatal("report must return a payload")
	}
	if initial["actions"] == nil {
		t.Error("report must list the actions")
	}
	if initial["facts"] == nil {
		t.Error("report must include the probed facts so a user can see WHY the answer is what it is")
	}
}

// Every destructive action still requires confirm.
func TestDestructivePowerActionsRequireConfirm(t *testing.T) {
	for _, action := range []string{"host_reboot", "agent_restart", "agent_shutdown"} {
		res := opsInfraPowerHandler(OpsContext{}, json.RawMessage(`{"action":"`+action+`"}`))
		if res.OK {
			t.Errorf("%s succeeded without confirm=true", action)
		}
		if res.Code != "confirm_required" {
			t.Errorf("%s: code = %q, want confirm_required", action, res.Code)
		}
	}
}

// A typo must not silently do nothing-shaped-like-success, and the error has to
// name the actions that DO exist.
func TestUnknownPowerActionNamesTheRealOnes(t *testing.T) {
	res := opsInfraPowerHandler(OpsContext{}, json.RawMessage(`{"action":"power_off","confirm":true}`))
	if res.OK {
		t.Fatal("unknown action must not succeed")
	}
	if res.Code != "bad_action" {
		t.Errorf("code = %q, want bad_action", res.Code)
	}
	for _, want := range []string{"report", "host_reboot", "agent_restart", "agent_shutdown"} {
		if !strings.Contains(res.Error, want) {
			t.Errorf("error should name %q so the caller can recover; got %q", want, res.Error)
		}
	}
}

// The verb schema is what an AI agent reads before calling. If `report` is not
// in the enum, no agent will ever discover the safe dry run.
func TestPowerSchemaAdvertisesReportAndRestart(t *testing.T) {
	spec := powerSpec(t)
	raw, err := json.Marshal(spec.Schema)
	if err != nil {
		t.Fatalf("schema does not marshal: %v", err)
	}
	s := string(raw)
	for _, want := range []string{"report", "agent_restart", "host_reboot", "agent_shutdown"} {
		if !strings.Contains(s, want) {
			t.Errorf("schema does not advertise %q: %s", want, s)
		}
	}
	// `confirm` must NOT be required at the schema level any more, or a caller
	// cannot ask for the read-only report without also saying "yes, do it".
	req, _ := spec.Schema["required"].([]string)
	for _, r := range req {
		if r == "confirm" {
			t.Error("confirm must not be schema-required — that would block the read-only report")
		}
	}
	if !strings.Contains(strings.ToLower(spec.Description), "report") {
		t.Error("description must point the caller at the dry run first")
	}
}
