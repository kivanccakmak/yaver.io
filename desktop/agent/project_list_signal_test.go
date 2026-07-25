package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProjectListHasRunnableSignalAcceptsYaverWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "yaver.workspace.yaml"), []byte("version: 1\napps: []\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !projectListHasRunnableSignal(root) {
		t.Fatal("expected yaver.workspace.yaml root to be listed as a project")
	}
}

func TestProjectListHasRunnableSignalAcceptsDeployScript(t *testing.T) {
	root := t.TempDir()
	scripts := filepath.Join(root, "scripts")
	if err := os.MkdirAll(scripts, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(scripts, "deploy-web.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !projectListHasRunnableSignal(root) {
		t.Fatal("expected scripts/deploy-*.sh root to be listed as a project")
	}
}

func TestProjectListHasRunnableSignalRejectsEmptyRoot(t *testing.T) {
	if projectListHasRunnableSignal(t.TempDir()) {
		t.Fatal("expected empty root to stay hidden from project list")
	}
}
