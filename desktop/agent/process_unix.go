//go:build !windows

package main

import (
	"os"
	osexec "os/exec"
	"syscall"
)

// detachProcess sets the child process to run in a new session (Unix: setsid).
func detachProcess(cmd *osexec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// isProcessAlive checks if a process with the given PID is still running.
func isProcessAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}

// terminateProcess sends SIGTERM to gracefully stop a process.
func terminateProcess(proc *os.Process) error {
	return proc.Signal(syscall.SIGTERM)
}

// installAutoStart registers the agent to start on login.
// macOS: launchd plist, Linux: systemd user service.
func installAutoStart(exePath, workDir string) error {
	// Not called automatically — placeholder for future use.
	return nil
}

// removeAutoStart removes auto-start registration.
func removeAutoStart() {
	// Handled inline in runUninstall for macOS/Linux.
}
