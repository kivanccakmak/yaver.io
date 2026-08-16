package main

import "testing"

// Self-growing tests were intentionally removed from every execution path.
// Keep this guard on the actual ops registry: if project_test_grow is ever
// registered again, MCP, web, mobile and remote-machine dispatch can all start
// unsolicited coding tasks again even if their buttons remain hidden.
func TestProjectTestGrowOpsVerbStaysDisabled(t *testing.T) {
	opsRegistryMu.RLock()
	_, registered := opsRegistry["project_test_grow"]
	opsRegistryMu.RUnlock()
	if registered {
		t.Fatal("project_test_grow is registered; self-growing tests must remain disabled")
	}
}
