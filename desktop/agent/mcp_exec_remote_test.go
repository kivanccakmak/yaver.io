package main

import "testing"

// Regression (2026-08-10, ubuntu-4gb-hel1-1): mcpRemoteExecCommand parsed the
// /exec/{id} poll response RAW — `{"ok":true,"exec":{...}}` — as the snapshot
// itself. `snapshot["status"]` was therefore nil, the poll loop broke on the
// first response, and the MCP tool returned `Status: <nil>` while the command
// had actually run (exitCode 0, stdout present). decodeRemoteExecSnapshot
// unwraps the `exec` key and falls back to a flat body for agents that answer
// without the wrapper.
//
// PROVEN BY BREAKING: reverting decodeRemoteExecSnapshot to a bare
// `json.Unmarshal(raw, &snapshot)` (the pre-fix shape) leaves
// TestDecodeRemoteExecSnapshot_WrappedBody's status assertion nil and the
// test fails with a `<nil>` where "completed" is expected — exactly the
// `Status: <nil>` the MCP tool returned live.
func TestDecodeRemoteExecSnapshot_WrappedBody(t *testing.T) {
	raw := []byte(`{"ok":true,"exec":{"command":"hostname","exitCode":0,"status":"completed","stdout":"ubuntu-4gb-hel1-1\n","stderr":"","id":"acaed335","pid":1220602}}`)
	snap, err := decodeRemoteExecSnapshot(raw)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got := snap["status"]; got != "completed" {
		t.Fatalf("status = %v, want \"completed\" — the exec wrapper was not unwrapped", got)
	}
	if got := snap["stdout"]; got != "ubuntu-4gb-hel1-1\n" {
		t.Fatalf("stdout = %v, want the captured output — the exec wrapper was not unwrapped", got)
	}
	if got := snap["exitCode"]; got != float64(0) {
		t.Fatalf("exitCode = %v, want 0", got)
	}
}

// Older/self-hosted agents may answer /exec/{id} with a flat snapshot body.
// The fallback must keep those working — a shape change that silently breaks
// every pre-wrapper agent is the same defect class as the wrapper bug.
func TestDecodeRemoteExecSnapshot_FlatBodyFallback(t *testing.T) {
	raw := []byte(`{"status":"running","command":"sleep 1"}`)
	snap, err := decodeRemoteExecSnapshot(raw)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got := snap["status"]; got != "running" {
		t.Fatalf("status = %v, want \"running\" (flat body fallback)", got)
	}
}
