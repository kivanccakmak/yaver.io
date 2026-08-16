//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func setProcGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcessGroup(pid int, sig string) error {
	switch sig {
	case "INT":
		return syscall.Kill(-pid, syscall.SIGINT)
	case "TERM":
		return syscall.Kill(-pid, syscall.SIGTERM)
	case "KILL":
		return syscall.Kill(-pid, syscall.SIGKILL)
	default:
		return syscall.Kill(-pid, syscall.SIGTERM)
	}
}
