package main

import (
	"testing"
)

func TestChooseNodePlacementPrefersPinnedMachine(t *testing.T) {
	req := AgentGraphCreateRequest{PreferredDevice: "mac-mini"}
	node := AgentGraphNodeSpec{ID: "chat", Kind: AgentNodeChat, Prompt: "Plan the release"}
	machines := []MachineInfo{
		{
			DeviceID: "linux-box",
			Name:     "linux-box",
			IsOnline: true,
			Capabilities: &MachineCapabilities{
				Runners: []MachineRunnerCapability{{ID: "codex", Ready: true}},
			},
		},
		{
			DeviceID: "mac-mini",
			Name:     "mac-mini",
			IsOnline: true,
			Capabilities: &MachineCapabilities{
				Runners: []MachineRunnerCapability{{ID: "claude", Ready: true}},
			},
		},
	}

	placement := chooseNodePlacement(req, node, machines, &meshPlannerState{})
	if placement.DeviceID != "mac-mini" {
		t.Fatalf("expected pinned machine, got %q", placement.DeviceID)
	}
}

func TestChooseNodePlacementPrefersIOSMachineForTestFlight(t *testing.T) {
	node := AgentGraphNodeSpec{
		ID:     "ship-ios",
		Kind:   AgentNodeAutoIdeas,
		Prompt: "Build and deploy the app to TestFlight",
	}
	machines := []MachineInfo{
		{
			DeviceID: "linux-box",
			Name:     "linux-box",
			IsOnline: true,
			Capabilities: &MachineCapabilities{
				Runners:         []MachineRunnerCapability{{ID: "codex", Ready: true}},
				SupportsAndroid: true,
			},
		},
		{
			DeviceID: "mac-mini",
			Name:     "mac-mini",
			IsOnline: true,
			Capabilities: &MachineCapabilities{
				Runners:            []MachineRunnerCapability{{ID: "claude", Ready: true}, {ID: "codex", Ready: true}},
				SupportsIOS:        true,
				SupportsTestFlight: true,
			},
		},
	}

	placement := chooseNodePlacement(AgentGraphCreateRequest{}, node, machines, &meshPlannerState{})
	if placement.DeviceID != "mac-mini" {
		t.Fatalf("expected mac-mini for TestFlight, got %q", placement.DeviceID)
	}
}

func TestChooseNodePlacementPrefersAndroidMachine(t *testing.T) {
	node := AgentGraphNodeSpec{
		ID:     "ship-android",
		Kind:   AgentNodeAutoIdeas,
		Prompt: "Prepare the Android release and Play Store rollout",
	}
	machines := []MachineInfo{
		{
			DeviceID: "mac-mini",
			Name:     "mac-mini",
			IsOnline: true,
			Capabilities: &MachineCapabilities{
				Runners:     []MachineRunnerCapability{{ID: "claude", Ready: true}},
				SupportsIOS: true,
			},
		},
		{
			DeviceID: "linux-box",
			Name:     "linux-box",
			IsOnline: true,
			Capabilities: &MachineCapabilities{
				Runners:           []MachineRunnerCapability{{ID: "codex", Ready: true}},
				SupportsAndroid:   true,
				SupportsPlayStore: true,
			},
		},
	}

	placement := chooseNodePlacement(AgentGraphCreateRequest{}, node, machines, &meshPlannerState{})
	if placement.DeviceID != "linux-box" {
		t.Fatalf("expected linux-box for Android flow, got %q", placement.DeviceID)
	}
}

func TestChooseNodePlacementPrefersLocalLLMWhenRequested(t *testing.T) {
	node := AgentGraphNodeSpec{
		ID:     "local-dev",
		Kind:   AgentNodeAutoIdeas,
		Prompt: "Use opencode with local LLM (BYOK) for the coding pass",
	}
	machines := []MachineInfo{
		{
			DeviceID: "mac-mini",
			Name:     "mac-mini",
			IsOnline: true,
			Capabilities: &MachineCapabilities{
				Runners:          []MachineRunnerCapability{{ID: "opencode", Ready: true}},
				SupportsLocalLLM: true,
			},
		},
		{
			DeviceID: "cloud-box",
			Name:     "cloud-box",
			IsOnline: true,
			Capabilities: &MachineCapabilities{
				Runners: []MachineRunnerCapability{{ID: "codex", Ready: true}},
			},
		},
	}

	placement := chooseNodePlacement(AgentGraphCreateRequest{}, node, machines, &meshPlannerState{})
	if placement.DeviceID != "mac-mini" {
		t.Fatalf("expected local-llm machine, got %q", placement.DeviceID)
	}
	if placement.Runner != "opencode" {
		t.Fatalf("expected opencode runner for BYOK local-LLM path, got %q", placement.Runner)
	}
}

func TestPlanGraphPlacementsBalancesAcrossAllowedMachines(t *testing.T) {
	req := AgentGraphCreateRequest{AllowedDevices: []string{"mac", "linux"}}
	machines := []MachineInfo{
		{
			DeviceID: "mac",
			Name:     "mac",
			IsOnline: true,
			Capabilities: &MachineCapabilities{
				Hardware:     HardwareProfile{MaxParallel: 4},
				MaxTaskSlots: 2,
				Runners: []MachineRunnerCapability{
					{ID: "claude", Ready: true},
					{ID: "codex", Ready: true},
				},
			},
		},
		{
			DeviceID: "linux",
			Name:     "linux",
			IsOnline: true,
			Capabilities: &MachineCapabilities{
				Hardware:     HardwareProfile{MaxParallel: 4},
				MaxTaskSlots: 2,
				Runners: []MachineRunnerCapability{
					{ID: "codex", Ready: true},
				},
			},
		},
	}
	state := &meshPlannerState{
		machines:           map[string]MachineInfo{"mac": machines[0], "linux": machines[1]},
		machineAssignments: map[string]int{},
		runnerAssignments:  map[string]int{},
	}
	first := chooseNodePlacement(req, AgentGraphNodeSpec{ID: "n1", Kind: AgentNodeAutoIdeas, Prompt: "Implement settings screen"}, machines, state)
	state.reserve(first)
	second := chooseNodePlacement(req, AgentGraphNodeSpec{ID: "n2", Kind: AgentNodeAutoIdeas, Prompt: "Implement billing flow"}, machines, state)
	if first.DeviceID == second.DeviceID {
		t.Fatalf("expected balanced placement across machines, got both on %q", first.DeviceID)
	}
}

func TestAllowedDevicesMatchesMachineNameAndPrefix(t *testing.T) {
	req := AgentGraphCreateRequest{AllowedDevices: []string{"ubuntu-4gb", "mac"}}
	machines := []MachineInfo{
		{DeviceID: "local", Name: "Kvancs-MacBook-Air.local", IsLocal: true, IsOnline: true},
		{DeviceID: "6d5c0624-128d-419e-9da9-47362d5de434", Name: "ubuntu-4gb-hel1-1", IsOnline: true},
	}

	filtered := filterPlacementMachines(req, AgentGraphNodeSpec{}, machines)
	if len(filtered) != 1 {
		t.Fatalf("expected one allowed machine, got %d", len(filtered))
	}
	if filtered[0].Name != "ubuntu-4gb-hel1-1" {
		t.Fatalf("expected Hetzner machine by name match, got %q", filtered[0].Name)
	}
}

func TestMeshPolicySerializesClaude(t *testing.T) {
	state := &meshPolicyState{
		machines: map[string]MachineInfo{
			"mac": {
				DeviceID: "mac",
				Capabilities: &MachineCapabilities{
					Hardware:     HardwareProfile{MaxParallel: 4},
					MaxTaskSlots: 2,
				},
			},
			"linux": {
				DeviceID: "linux",
				Capabilities: &MachineCapabilities{
					Hardware:     HardwareProfile{MaxParallel: 4},
					MaxTaskSlots: 2,
				},
			},
		},
		machineUse:   map[string]int{},
		runnerGlobal: map[string]int{},
	}
	first := &AgentGraphNodeState{Placement: &AgentNodePlacement{DeviceID: "mac", Runner: "claude-code"}}
	second := &AgentGraphNodeState{Placement: &AgentNodePlacement{DeviceID: "linux", Runner: "claude-code"}}
	if !state.CanStart(first) {
		t.Fatalf("expected first claude node to start")
	}
	state.Reserve(first)
	if state.CanStart(second) {
		t.Fatalf("expected second claude node to be blocked by policy")
	}
}
