package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestValidationCommandUsesAllowlistedPackageScript(t *testing.T) {
	workDir := t.TempDir()
	manifest := []byte(`{"scripts":{"lint":"eslint .","test":"vitest run"}}`)
	if err := os.WriteFile(filepath.Join(workDir, "package.json"), manifest, 0600); err != nil {
		t.Fatal(err)
	}
	session := &ProjectSession{WorkDir: workDir, Status: "ready"}
	command, args, resolvedWorkDir, err := validationCommand(session, "test")
	if err != nil {
		t.Fatal(err)
	}
	if command != "npm" || !reflect.DeepEqual(args, []string{"run", "test"}) || resolvedWorkDir != workDir {
		t.Fatalf("got %q %#v %q", command, args, resolvedWorkDir)
	}
}

func TestValidationCommandRejectsArbitraryCommand(t *testing.T) {
	workDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workDir, "package.json"), []byte(`{"scripts":{"test":"echo ok"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	session := &ProjectSession{WorkDir: workDir, Status: "ready"}
	if _, _, _, err := validationCommand(session, "rm -rf"); err == nil {
		t.Fatal("expected arbitrary validation kind to be rejected")
	}
}
