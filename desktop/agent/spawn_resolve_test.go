package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The "flutter installed but still 'executable file not found'" machine:
// exec.Command(name) resolves the binary via the AGENT's own PATH (fixed at
// boot by systemd/launchd), while augmentEnv only fixes the CHILD's PATH —
// so a tool that exists only under ~/.yaver/runtimes (or the agent-installed
// Flutter root) is invisible at spawn no matter how correct the child env
// is. resolveSpawnPath consults lookPathWithRuntimes at SPAWN time and hands
// exec.Command an absolute path, making presence a per-start probe instead
// of a boot-time fact.
func TestResolveSpawnPathFindsRuntimeOnlyTool(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	binDir := filepath.Join(home, ".yaver", "runtimes", "node", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	tool := filepath.Join(binDir, "yaver-fake-tool")
	if err := os.WriteFile(tool, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if got := resolveSpawnPath("yaver-fake-tool"); got != tool {
		t.Fatalf("resolveSpawnPath = %q, want the runtime-dir path %q", got, tool)
	}
}

// A tool that exists nowhere resolves to its own name — exec.Command then
// fails with the usual, recognizable 'executable file not found' that the
// missing-toolchain remedy path already parses.
func TestResolveSpawnPathPassesThroughUnknownTool(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if got := resolveSpawnPath("definitely-not-a-tool-xyz"); got != "definitely-not-a-tool-xyz" {
		t.Fatalf("resolveSpawnPath = %q, want pass-through", got)
	}
}
