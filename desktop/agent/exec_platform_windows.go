//go:build windows

package main

import (
	"os"
	"os/exec"
)

func setProcGroup(cmd *exec.Cmd) {
	// Windows doesn't support process groups the same way
}

func killProcessGroup(pid int, sig string) error {
	// On Windows, just kill the process directly
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}
