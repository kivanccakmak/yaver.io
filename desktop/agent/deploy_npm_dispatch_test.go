package main

import (
	"os/exec"
	"reflect"
	"testing"
)

func TestReleaseCLIUsesProtectedWorkflowDispatch(t *testing.T) {
	want := []string{"gh", "workflow", "run", "release-cli.yml", "--ref", "main", "-f", "publish_npm=true"}
	if got := releaseCLIWorkflowArgs(); !reflect.DeepEqual(got, want) {
		t.Fatalf("release dispatch = %q, want %q", got, want)
	}
}

func TestYaverReleaseRemoteAcceptsCanonicalOrigin(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init")
	run("remote", "add", "github", "https://github.com/example/fork.git")
	run("remote", "add", "origin", "git@github.com:yaver-io/yaver.io.git")

	got, err := yaverReleaseRemote(repo)
	if err != nil {
		t.Fatal(err)
	}
	if got != "origin" {
		t.Fatalf("release remote = %q, want origin", got)
	}
}

func TestYaverReleaseRemoteRejectsForkOnlyCheckout(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init")
	run("remote", "add", "origin", "https://github.com/example/fork.git")

	if _, err := yaverReleaseRemote(repo); err == nil {
		t.Fatal("fork-only checkout unexpectedly selected a release remote")
	}
}
