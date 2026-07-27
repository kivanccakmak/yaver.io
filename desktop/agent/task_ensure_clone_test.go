package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The ensure-clone plan must fire ONLY for an owner task whose workDir is
// missing and whose remote is a real git transport — every other shape takes
// the normal spawn path unchanged (the split must be a no-op when unused).
func TestClonePlanForTask(t *testing.T) {
	tm := &TaskManager{}
	tmp := t.TempDir()
	missing := filepath.Join(tmp, "not-here")

	cases := []struct {
		name string
		task Task
		want bool
	}{
		{"no remote → nil", Task{WorkDir: missing}, false},
		{"guest → nil even with remote", Task{WorkDir: missing, GitRemote: "https://github.com/yaver-io/yaver-todo-rn.git", GuestUserID: "g1"}, false},
		{"existing dir → nil", Task{WorkDir: tmp, GitRemote: "https://github.com/yaver-io/yaver-todo-rn.git"}, false},
		{"missing dir + https remote → plan", Task{WorkDir: missing, GitRemote: "https://github.com/yaver-io/yaver-todo-rn.git", GitBranch: "main"}, true},
		{"missing dir + scp remote → plan", Task{WorkDir: missing, GitRemote: "git@github.com:yaver-io/yaver-todo-rn.git"}, true},
		{"flag-shaped remote → nil", Task{WorkDir: missing, GitRemote: "--upload-pack=/bin/sh"}, false},
		{"local path remote → nil", Task{WorkDir: missing, GitRemote: "/etc/passwd"}, false},
	}
	for _, c := range cases {
		task := c.task
		got := tm.clonePlanForTask(&task)
		if (got != nil) != c.want {
			t.Errorf("%s: plan=%v want plan=%v", c.name, got != nil, c.want)
		}
		if got != nil && got.Dest != task.WorkDir {
			t.Errorf("%s: dest %q != workDir %q", c.name, got.Dest, task.WorkDir)
		}
	}
}

// With no workDir at all, the plan derives ~/Workspace/<repo> at runtime —
// never a hardcoded home — and writes it back onto the task.
func TestClonePlanDerivesWorkspaceDest(t *testing.T) {
	tm := &TaskManager{}
	task := Task{GitRemote: "https://github.com/yaver-io/some-project-that-does-not-exist-here.git"}
	plan := tm.clonePlanForTask(&task)
	if plan == nil {
		t.Fatal("expected a plan for empty workDir + valid remote")
	}
	home, _ := os.UserHomeDir()
	want := filepath.Join(home, "Workspace", "some-project-that-does-not-exist-here")
	if plan.Dest != want || task.WorkDir != want {
		t.Errorf("dest %q / task.WorkDir %q, want %q", plan.Dest, task.WorkDir, want)
	}
}

func TestValidGitRemote(t *testing.T) {
	ok := []string{"https://github.com/a/b.git", "ssh://git@host/a/b", "git@github.com:a/b.git", "git://host/a"}
	bad := []string{"", "-flag", "--upload-pack=/bin/sh", "/etc/passwd", "file:///x", "git@host with space:x"}
	for _, r := range ok {
		if !validGitRemote(r) {
			t.Errorf("expected valid: %q", r)
		}
	}
	for _, r := range bad {
		if validGitRemote(r) {
			t.Errorf("expected rejected: %q", r)
		}
	}
}
