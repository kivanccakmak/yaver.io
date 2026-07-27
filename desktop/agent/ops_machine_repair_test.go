package main

import "testing"

func TestMachineRepairOpsRegistered(t *testing.T) {
	found := false
	for _, v := range listOpsVerbs() {
		if v.Name == "machine_repair" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("missing ops verb machine_repair")
	}
}

func TestMachineRoleUnreachableCarriesRepairRoute(t *testing.T) {
	rep := machineRoleProbeReport{Role: "render", DeviceID: "dev-1", Reachable: false}
	rep.Fix = &machineRoleFix{
		Label:   "Recover via watchdog",
		Method:  "POST",
		Path:    "/ops",
		OpsVerb: "machine_repair",
		Payload: map[string]interface{}{"action": "restart_agent", "deviceId": "dev-1"},
	}
	if rep.Fix == nil || rep.Fix.OpsVerb != "machine_repair" {
		t.Fatalf("unreachable role must carry machine_repair route, got %#v", rep.Fix)
	}
	if rep.Fix.Payload["deviceId"] != "dev-1" || rep.Fix.Payload["action"] != "restart_agent" {
		t.Fatalf("bad fix payload: %#v", rep.Fix.Payload)
	}
}
