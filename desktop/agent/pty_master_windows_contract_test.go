package main

import (
	"os"
	"strings"
	"testing"
)

// This is a wiring guard, not a substitute for the Windows hardware lane. The
// pure quoting/environment behavior is exercised above; this catches the
// platform-only flags that a Linux/macOS cross-build cannot execute.
func TestConPTYCreateProcessContract(t *testing.T) {
	src, err := os.ReadFile("pty_master_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	for _, required := range []string{
		"windows.EXTENDED_STARTUPINFO_PRESENT",
		"windows.CREATE_UNICODE_ENVIRONMENT",
		"buildWindowsEnvBlock(cmd.Env)",
		"os.FindProcess(int(pi.ProcessId))",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("ConPTY startup is missing %q", required)
		}
	}
	if strings.Contains(text, "&os.Process{Pid:") {
		t.Fatal("a manually-created os.Process is invalid on Windows")
	}
	if strings.Contains(text, "si.Flags = windows.STARTF_USESTDHANDLES") {
		t.Fatal("ConPTY child must not advertise zero standard handles")
	}
}
