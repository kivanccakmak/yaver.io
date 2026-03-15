//go:build windows

package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
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

// killAllClaude kills all running claude processes on Windows.
func killAllClaude() {
	osexec.Command("taskkill", "/F", "/IM", "claude.exe").Run()
	time.Sleep(500 * time.Millisecond)
}

// findRunnerProcesses returns PIDs and command lines of running processes
// matching the given binary name (e.g. "claude"). Uses tasklist on Windows.
func findRunnerProcesses(binaryName string) []RunnerProcess {
	// tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH
	exeName := binaryName + ".exe"
	out, err := osexec.Command("tasklist", "/FI", fmt.Sprintf("IMAGENAME eq %s", exeName), "/FO", "CSV", "/NH").CombinedOutput()
	if err != nil {
		return nil
	}
	var procs []RunnerProcess
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.Contains(line, "No tasks are running") {
			continue
		}
		// CSV format: "claude.exe","1234","Console","1","12,345 K"
		fields := strings.Split(line, ",")
		if len(fields) < 2 {
			continue
		}
		pidStr := strings.Trim(fields[1], "\" ")
		var pid int
		if _, err := fmt.Sscanf(pidStr, "%d", &pid); err != nil {
			continue
		}
		procs = append(procs, RunnerProcess{PID: pid, Command: exeName})
	}
	return procs
}

// getMemoryUsedMB returns currently used system memory in MB on Windows.
func getMemoryUsedMB() (int64, error) {
	out, err := osexec.Command("wmic", "OS", "get", "FreePhysicalMemory,TotalVisibleMemorySize", "/Value").CombinedOutput()
	if err != nil {
		return 0, err
	}
	var totalKB, freeKB int64
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "TotalVisibleMemorySize=") {
			fmt.Sscanf(line, "TotalVisibleMemorySize=%d", &totalKB)
		} else if strings.HasPrefix(line, "FreePhysicalMemory=") {
			fmt.Sscanf(line, "FreePhysicalMemory=%d", &freeKB)
		}
	}
	return (totalKB - freeKB) / 1024, nil
}

// getCPUPercent returns CPU usage percentage on Windows.
func getCPUPercent() (float64, error) {
	out, err := osexec.Command("wmic", "cpu", "get", "LoadPercentage", "/Value").CombinedOutput()
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "LoadPercentage=") {
			var pct float64
			fmt.Sscanf(line, "LoadPercentage=%f", &pct)
			return pct, nil
		}
	}
	return 0, fmt.Errorf("could not determine CPU usage")
}

// getSystemMemoryMB returns total system memory in MB on Windows.
func getSystemMemoryMB() (int64, error) {
	out, err := osexec.Command("wmic", "OS", "get", "TotalVisibleMemorySize", "/Value").CombinedOutput()
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "TotalVisibleMemorySize=") {
			var kb int64
			if _, err := fmt.Sscanf(line, "TotalVisibleMemorySize=%d", &kb); err == nil {
				return kb / 1024, nil
			}
		}
	}
	return 0, fmt.Errorf("could not determine memory")
}

// removeAutoStart removes the Windows Scheduled Task.
func removeAutoStart() {
	osexec.Command("schtasks", "/Delete", "/TN", taskName, "/F").Run()
}

// Ensure unsafe is used (required for procOpenProcess.Call)
var _ = unsafe.Pointer(nil)
