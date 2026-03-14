//go:build windows

package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	modkernel32         = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess     = modkernel32.NewProc("OpenProcess")
	procCloseHandle     = modkernel32.NewProc("CloseHandle")
)

const (
	processQueryLimitedInfo = 0x1000
)

// detachProcess sets the child process to run detached on Windows.
func detachProcess(cmd *osexec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
}

// isProcessAlive checks if a process with the given PID is still running.
func isProcessAlive(pid int) bool {
	h, _, _ := procOpenProcess.Call(
		uintptr(processQueryLimitedInfo),
		0,
		uintptr(pid),
	)
	if h == 0 {
		return false
	}
	procCloseHandle.Call(h)
	return true
}

// terminateProcess kills a process on Windows (no graceful SIGTERM equivalent).
func terminateProcess(proc *os.Process) error {
	return proc.Kill()
}

const taskName = "YaverAgent"

// installAutoStart creates a Windows Scheduled Task to run the agent at logon.
func installAutoStart(exePath, workDir string) error {
	// Use schtasks to create a logon trigger task
	absExe, err := filepath.Abs(exePath)
	if err != nil {
		return fmt.Errorf("resolve exe path: %w", err)
	}
	absWork, err := filepath.Abs(workDir)
	if err != nil {
		return fmt.Errorf("resolve work dir: %w", err)
	}

	// Delete existing task if any (ignore errors)
	osexec.Command("schtasks", "/Delete", "/TN", taskName, "/F").Run()

	// Create task that runs at logon
	cmd := osexec.Command("schtasks", "/Create",
		"/TN", taskName,
		"/TR", fmt.Sprintf(`"%s" serve --debug --work-dir="%s"`, absExe, absWork),
		"/SC", "ONLOGON",
		"/RL", "LIMITED",
		"/F",
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("create scheduled task: %w — %s", err, string(output))
	}
	return nil
}

// removeAutoStart removes the Windows Scheduled Task.
func removeAutoStart() {
	osexec.Command("schtasks", "/Delete", "/TN", taskName, "/F").Run()
}

// Ensure unsafe is used (required for procOpenProcess.Call)
var _ = unsafe.Pointer(nil)
