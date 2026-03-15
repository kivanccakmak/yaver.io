//go:build !windows

package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"strings"
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

// findRunnerProcesses returns PIDs and command lines of running processes
// matching the given binary name (e.g. "claude"). Uses pgrep on Unix.
func findRunnerProcesses(binaryName string) []RunnerProcess {
	// Use -x for exact binary name match (avoids matching this process or grep itself)
	out, err := osexec.Command("pgrep", "-x", binaryName).CombinedOutput()
	if err != nil {
		return nil // pgrep returns exit 1 if no match
	}
	var procs []RunnerProcess
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		var pid int
		if _, err := fmt.Sscanf(line, "%d", &pid); err != nil {
			continue
		}
		// Get the command line for this PID
		cmdOut, cmdErr := osexec.Command("ps", "-p", fmt.Sprintf("%d", pid), "-o", "command=").CombinedOutput()
		cmd := binaryName
		if cmdErr == nil {
			cmd = strings.TrimSpace(string(cmdOut))
		}
		procs = append(procs, RunnerProcess{PID: pid, Command: cmd})
	}
	return procs
}

// getMemoryUsedMB returns currently used system memory in MB.
func getMemoryUsedMB() (int64, error) {
	// macOS: vm_stat
	out, err := osexec.Command("vm_stat").CombinedOutput()
	if err == nil {
		var active, wired, compressed int64
		for _, line := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(line, "Pages active:") {
				fmt.Sscanf(strings.TrimPrefix(line, "Pages active:"), "%d", &active)
			} else if strings.HasPrefix(line, "Pages wired down:") {
				fmt.Sscanf(strings.TrimPrefix(line, "Pages wired down:"), "%d", &wired)
			} else if strings.HasPrefix(line, "Pages occupied by compressor:") {
				fmt.Sscanf(strings.TrimPrefix(line, "Pages occupied by compressor:"), "%d", &compressed)
			}
		}
		// Each page is 16384 bytes on Apple Silicon, 4096 on Intel — check page size
		pageOut, _ := osexec.Command("pagesize").CombinedOutput()
		pageSize := int64(16384) // default Apple Silicon
		fmt.Sscanf(strings.TrimSpace(string(pageOut)), "%d", &pageSize)
		usedBytes := (active + wired + compressed) * pageSize
		return usedBytes / (1024 * 1024), nil
	}
	// Linux fallback: /proc/meminfo
	data, readErr := os.ReadFile("/proc/meminfo")
	if readErr != nil {
		return 0, readErr
	}
	var total, available int64
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fmt.Sscanf(line, "MemTotal: %d kB", &total)
		} else if strings.HasPrefix(line, "MemAvailable:") {
			fmt.Sscanf(line, "MemAvailable: %d kB", &available)
		}
	}
	return (total - available) / 1024, nil
}

// getCPUPercent returns a rough CPU usage percentage (sampled over 1 second).
func getCPUPercent() (float64, error) {
	// macOS: top -l 2 -n 0 — second sample gives accurate reading
	out, err := osexec.Command("top", "-l", "2", "-n", "0", "-s", "1").CombinedOutput()
	if err == nil {
		lines := strings.Split(string(out), "\n")
		// Find the last "CPU usage:" line (second sample)
		for i := len(lines) - 1; i >= 0; i-- {
			if strings.Contains(lines[i], "CPU usage:") {
				var user, sys float64
				fmt.Sscanf(lines[i], "CPU usage: %f%% user, %f%% sys,", &user, &sys)
				return user + sys, nil
			}
		}
	}
	// Linux fallback: /proc/stat (instant snapshot — less accurate but fast)
	data, readErr := os.ReadFile("/proc/stat")
	if readErr != nil {
		return 0, readErr
	}
	lines := strings.Split(string(data), "\n")
	if len(lines) > 0 && strings.HasPrefix(lines[0], "cpu ") {
		fields := strings.Fields(lines[0])
		if len(fields) >= 5 {
			var user, nice, system, idle int64
			fmt.Sscanf(fields[1], "%d", &user)
			fmt.Sscanf(fields[2], "%d", &nice)
			fmt.Sscanf(fields[3], "%d", &system)
			fmt.Sscanf(fields[4], "%d", &idle)
			total := float64(user + nice + system + idle)
			if total > 0 {
				return float64(user+nice+system) / total * 100, nil
			}
		}
	}
	return 0, fmt.Errorf("could not determine CPU usage")
}

// getSystemMemoryMB returns total system memory in MB.
func getSystemMemoryMB() (int64, error) {
	// macOS: sysctl hw.memsize
	out, err := osexec.Command("sysctl", "-n", "hw.memsize").CombinedOutput()
	if err == nil {
		var bytes int64
		if _, err := fmt.Sscanf(strings.TrimSpace(string(out)), "%d", &bytes); err == nil {
			return bytes / (1024 * 1024), nil
		}
	}
	// Linux fallback: /proc/meminfo
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			var kb int64
			if _, err := fmt.Sscanf(line, "MemTotal: %d kB", &kb); err == nil {
				return kb / 1024, nil
			}
		}
	}
	return 0, fmt.Errorf("could not determine memory")
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
