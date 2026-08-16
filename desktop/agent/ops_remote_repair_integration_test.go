package main

import (
	"encoding/json"
	"os"
	"testing"
)

// Live end-to-end check of remote_repair against a real machine.
//
// Skipped unless YAVER_REMOTE_REPAIR_HOST is set, because it needs an actual
// box and working SSH keys. It exists because the probe script is the one part
// of this feature that cannot be unit-tested honestly: it depends on systemd's
// output format, curl, python3 and df all behaving as assumed on a real host.
// The parser has unit tests against captured output; this proves the capture
// itself is still accurate.
//
//	YAVER_REMOTE_REPAIR_HOST=root@192.0.2.10 go test -run TestRemoteRepair_Live -v .
//
// It NEVER applies repairs — apply is left false on purpose, so running it
// against production can only read.
func TestRemoteRepair_Live(t *testing.T) {
	target := os.Getenv("YAVER_REMOTE_REPAIR_HOST")
	if target == "" {
		t.Skip("set YAVER_REMOTE_REPAIR_HOST=user@host to run the live probe")
	}

	payload, err := json.Marshal(opsRemoteRepairPayload{Target: target})
	if err != nil {
		t.Fatal(err)
	}

	res := opsRemoteRepairHandler(OpsContext{Caller: "owner"}, payload)
	if !res.OK {
		t.Fatalf("remote_repair failed: code=%s err=%s", res.Code, res.Error)
	}

	body, err := json.MarshalIndent(res.Initial, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("remote_repair(%s):\n%s", target, string(body))

	m, ok := res.Initial.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected result shape %T", res.Initial)
	}
	// The probe must produce a real verdict, not an empty shrug: a box that
	// answered SSH always yields either healthy=true or at least one finding.
	healthy, _ := m["healthy"].(bool)
	findings, _ := m["findings"].([]remoteBoxFinding)
	if !healthy && len(findings) == 0 {
		t.Fatal("neither healthy nor any finding — the probe returned nothing usable, " +
			"which usually means its output format drifted")
	}
	// Diagnose-only must never have touched the box.
	if applied, _ := m["applied"].([]interface{}); len(applied) != 0 {
		t.Fatalf("apply defaulted to true — a diagnose call modified the box: %v", applied)
	}
}
