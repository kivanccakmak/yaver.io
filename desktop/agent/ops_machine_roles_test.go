package main

import (
	"strings"
	"testing"
)

func TestMachineRolesOpsRegistered(t *testing.T) {
	found := false
	for _, v := range listOpsVerbs() {
		if v.Name == "machine_roles" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("missing ops verb machine_roles")
	}
}

func TestResolveMachineRoleDeviceByNamePrefix(t *testing.T) {
	devices := []primaryDevice{
		{DeviceID: "runner-11111111", Name: "runner-box-linux"},
		{DeviceID: "render-22222222", Name: "render-mini.local"},
	}
	runner, err := resolveMachineRoleDevice("runner-box", devices)
	if err != nil {
		t.Fatal(err)
	}
	if runner.DeviceID != "runner-11111111" {
		t.Fatalf("runner = %s", runner.DeviceID)
	}
	render, err := resolveMachineRoleDevice("render-222", devices)
	if err != nil {
		t.Fatal(err)
	}
	if render.Name != "render-mini.local" {
		t.Fatalf("render = %s", render.Name)
	}
}

func TestResolveMachineRoleDeviceAmbiguous(t *testing.T) {
	devices := []primaryDevice{
		{DeviceID: "a111", Name: "ubuntu-a"},
		{DeviceID: "b222", Name: "ubuntu-b"},
	}
	if _, err := resolveMachineRoleDevice("ubuntu", devices); err == nil || !strings.Contains(err.Error(), "matches multiple") {
		t.Fatalf("expected ambiguity, got %v", err)
	}
}
