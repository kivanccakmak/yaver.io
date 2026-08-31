package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveTaskProjectOnRunnerMachinePrefersLocalCheckoutByName(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	ubuntuCheckout := filepath.Join(home, "workspaces", "medici.ai")
	if err := os.MkdirAll(filepath.Join(home, ".yaver"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(ubuntuCheckout, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ubuntuCheckout, "requirements.txt"), []byte("fastapi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(home, ".yaver", "PROJECTS.md"),
		[]byte("### "+ubuntuCheckout+"\n- Branch: main\n"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}

	got := resolveTaskProjectOnThisMachine("medici.ai", "/Users/kivanccakmak/Workspace/medici.ai")
	if got != ubuntuCheckout {
		t.Fatalf("resolved project = %q, want Ubuntu checkout %q", got, ubuntuCheckout)
	}
}

func TestEffectiveTaskWorkDirPrefersRunnerCheckoutOverForeignClientPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	runnerCheckout := filepath.Join(home, "workspaces", "medici.ai")
	foreignCheckout := filepath.Join(t.TempDir(), "medici.ai")
	for _, dir := range []string{runnerCheckout, foreignCheckout} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "requirements.txt"), []byte("fastapi\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(home, ".yaver"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(home, ".yaver", "PROJECTS.md"),
		[]byte("### "+runnerCheckout+"\n- Branch: main\n"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}

	tm := &TaskManager{workDir: filepath.Join(home, "fallback")}
	got := tm.effectiveTaskWorkDir(&Task{ProjectName: "medici.ai", WorkDir: foreignCheckout})
	if got != runnerCheckout {
		t.Fatalf("effective work dir = %q, want runner checkout %q", got, runnerCheckout)
	}
}
