package main

import (
	"os/exec"
	"testing"
)

func tmuxIdentityForTest(t *testing.T, name string) string {
	t.Helper()
	byName, _, err := listTmuxSessionIdentities()
	if err != nil {
		t.Fatal(err)
	}
	if byName[name] == "" {
		t.Fatalf("tmux identity for %q not found", name)
	}
	return byName[name]
}

func TestCloseExactSessionClosesOnlyMatchingIdentity(t *testing.T) {
	skipIfNoTmux(t)
	first := "yaver-test-exact-close-a"
	second := "yaver-test-exact-close-b"
	cleanupFirst := createTestTmuxSession(t, first)
	defer cleanupFirst()
	cleanupSecond := createTestTmuxSession(t, second)
	defer cleanupSecond()

	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	mgr := NewTmuxManager(tm)
	result, err := mgr.CloseExactSession(first, tmuxIdentityForTest(t, first))
	if err != nil {
		t.Fatalf("CloseExactSession: %v", err)
	}
	if !result.OK || !result.Verified || result.Code != "closed" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if tmuxSessionExists(first) {
		t.Fatal("target session survived verified close")
	}
	if !tmuxSessionExists(second) {
		t.Fatal("exact close killed a different session")
	}
}

func TestCloseExactSessionRejectsReusedName(t *testing.T) {
	skipIfNoTmux(t)
	name := "yaver-test-exact-reused"
	cleanup := createTestTmuxSession(t, name)
	defer cleanup()
	oldID := tmuxIdentityForTest(t, name)
	cleanup()
	if out, err := exec.Command(tmuxCmdName(), "new-session", "-d", "-s", name).CombinedOutput(); err != nil {
		t.Fatalf("recreate session: %v: %s", err, out)
	}
	newID := tmuxIdentityForTest(t, name)
	if newID == oldID {
		t.Skip("tmux reused the same session id; cannot exercise delayed identity guard")
	}

	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	mgr := NewTmuxManager(tm)
	result, err := mgr.CloseExactSession(name, oldID)
	if err == nil || result.Code != "identity_mismatch" {
		t.Fatalf("reused identity was not rejected: result=%+v err=%v", result, err)
	}
	if !tmuxSessionExists(name) {
		t.Fatal("identity mismatch killed the replacement session")
	}
}

func TestCloseExactSessionIsIdempotent(t *testing.T) {
	skipIfNoTmux(t)
	name := "yaver-test-exact-idempotent"
	cleanup := createTestTmuxSession(t, name)
	defer cleanup()
	id := tmuxIdentityForTest(t, name)

	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	mgr := NewTmuxManager(tm)
	if _, err := mgr.CloseExactSession(name, id); err != nil {
		t.Fatal(err)
	}
	result, err := mgr.CloseExactSession(name, id)
	if err != nil || !result.OK || !result.Verified || !result.AlreadyClosed || result.Code != "already_closed" {
		t.Fatalf("repeat close was not idempotent: result=%+v err=%v", result, err)
	}
}
