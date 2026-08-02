package main

import "testing"

func TestYaverSystemdUnitCandidatesPreferInstalledUnitName(t *testing.T) {
	got := yaverSystemdUnitCandidates()
	if len(got) < 2 {
		t.Fatalf("candidates = %v, want yaver.service and yaver-agent.service", got)
	}
	if got[0] != "yaver.service" {
		t.Fatalf("first candidate = %q, want yaver.service", got[0])
	}
	foundLegacy := false
	for _, unit := range got {
		if unit == "yaver-agent.service" || unit == "yaver-agent" {
			foundLegacy = true
		}
	}
	if !foundLegacy {
		t.Fatalf("candidates = %v, want legacy yaver-agent fallback", got)
	}
}
