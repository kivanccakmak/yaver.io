package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// searchFiles searches for files by name pattern in a directory.
func searchFiles(dir, pattern string, maxResults int) string {
	if dir == "" {
		dir = "."
	}
	if maxResults <= 0 {
		maxResults = 50
	}

	var results []string
	count := 0

	filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || count >= maxResults {
			if count >= maxResults {
				return filepath.SkipAll
			}
			return nil
		}

		// Skip common large directories
		if info.IsDir() {
			name := info.Name()
			skip := map[string]bool{
				"node_modules": true, ".git": true, ".next": true,
				"__pycache__": true, "vendor": true, "Pods": true,
				"build": true, "dist": true, ".cache": true,
				"venv": true, ".venv": true, "target": true,
			}
			if skip[name] {
				return filepath.SkipDir
			}
			return nil
		}

		matched, _ := filepath.Match(pattern, info.Name())
		if matched {
			rel, _ := filepath.Rel(dir, path)
			size := info.Size()
			sizeStr := fmt.Sprintf("%dB", size)
			if size > 1024*1024 {
				sizeStr = fmt.Sprintf("%.1fMB", float64(size)/(1024*1024))
			} else if size > 1024 {
				sizeStr = fmt.Sprintf("%.1fKB", float64(size)/1024)
			}
			results = append(results, fmt.Sprintf("%s (%s, %s)", rel, sizeStr, info.ModTime().Format("2006-01-02 15:04")))
			count++
		}
		return nil
	})

	if len(results) == 0 {
		return fmt.Sprintf("No files matching '%s' found in %s", pattern, dir)
	}
	return fmt.Sprintf("Found %d files matching '%s':\n%s", len(results), pattern, strings.Join(results, "\n"))
}

// searchFileContent searches for text content in files using grep.
func searchFileContent(dir, query string, maxResults int) string {
	if dir == "" {
		dir = "."
	}
	if maxResults <= 0 {
		maxResults = 30
	}

	// Try ripgrep first (faster), fall back to grep
	var cmd *exec.Cmd
	if _, err := exec.LookPath("rg"); err == nil {
		cmd = exec.Command("rg", "--no-heading", "--line-number", "--max-count", "3",
			"--max-filesize", "1M", "-m", fmt.Sprintf("%d", maxResults),
			"--glob", "!node_modules", "--glob", "!.git", "--glob", "!vendor",
			query, dir)
	} else {
		cmd = exec.Command("grep", "-rn", "--include=*.go", "--include=*.ts",
			"--include=*.tsx", "--include=*.js", "--include=*.py",
			"--include=*.rs", "--include=*.java", "--include=*.md",
			"-m", fmt.Sprintf("%d", maxResults), query, dir)
	}

	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return fmt.Sprintf("No matches found for '%s' in %s", query, dir)
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) > maxResults {
		lines = lines[:maxResults]
	}
	return fmt.Sprintf("Found matches for '%s':\n%s", query, strings.Join(lines, "\n"))
}

// captureScreen takes a screenshot and returns base64-encoded PNG.
func captureScreen() (string, error) {
	tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("yaver-screenshot-%d.png", time.Now().UnixNano()))
	defer os.Remove(tmpFile)

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("screencapture", "-x", tmpFile)
	case "linux":
		// Try gnome-screenshot, then scrot, then import (ImageMagick)
		if _, err := exec.LookPath("gnome-screenshot"); err == nil {
			cmd = exec.Command("gnome-screenshot", "-f", tmpFile)
		} else if _, err := exec.LookPath("scrot"); err == nil {
			cmd = exec.Command("scrot", tmpFile)
		} else if _, err := exec.LookPath("import"); err == nil {
			cmd = exec.Command("import", "-window", "root", tmpFile)
		} else {
			return "", fmt.Errorf("no screenshot tool found (install gnome-screenshot, scrot, or imagemagick)")
		}
	case "windows":
		// PowerShell screenshot
		psCmd := fmt.Sprintf(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bmp = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bmp.Save('%s') }`, tmpFile)
		cmd = exec.Command("powershell", "-Command", psCmd)
	default:
		return "", fmt.Errorf("screenshot not supported on %s", runtime.GOOS)
	}

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("screenshot failed: %v", err)
	}

	data, err := os.ReadFile(tmpFile)
	if err != nil {
		return "", err
	}

	return base64.StdEncoding.EncodeToString(data), nil
}

// getSystemInfo returns system resource usage.
func getSystemInfo() string {
	hostname, _ := os.Hostname()
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Hostname: %s\n", hostname))
	sb.WriteString(fmt.Sprintf("OS: %s/%s\n", runtime.GOOS, runtime.GOARCH))
	sb.WriteString(fmt.Sprintf("CPUs: %d\n", runtime.NumCPU()))
	sb.WriteString(fmt.Sprintf("Goroutines: %d\n\n", runtime.NumGoroutine()))

	// Disk usage
	switch runtime.GOOS {
	case "darwin", "linux":
		if out, err := exec.Command("df", "-h", "/").CombinedOutput(); err == nil {
			sb.WriteString("Disk:\n")
			sb.WriteString(string(out))
		}
		sb.WriteString("\n")
		if out, err := exec.Command("uptime").CombinedOutput(); err == nil {
			sb.WriteString("Load: ")
			sb.WriteString(strings.TrimSpace(string(out)))
			sb.WriteString("\n")
		}
		// Memory
		if runtime.GOOS == "darwin" {
			if out, err := exec.Command("vm_stat").CombinedOutput(); err == nil {
				sb.WriteString("\nMemory:\n")
				sb.WriteString(string(out))
			}
		} else {
			if out, err := exec.Command("free", "-h").CombinedOutput(); err == nil {
				sb.WriteString("\nMemory:\n")
				sb.WriteString(string(out))
			}
		}
	case "windows":
		if out, err := exec.Command("wmic", "os", "get", "FreePhysicalMemory,TotalVisibleMemorySize", "/format:list").CombinedOutput(); err == nil {
			sb.WriteString(string(out))
		}
	}

	return sb.String()
}

// gitInfo returns git status/diff/log for a directory.
func gitInfo(dir, operation string) string {
	if dir == "" {
		dir = "."
	}

	var cmd *exec.Cmd
	switch operation {
	case "status":
		cmd = exec.Command("git", "-C", dir, "status", "--short")
	case "diff":
		cmd = exec.Command("git", "-C", dir, "diff", "--stat")
	case "log":
		cmd = exec.Command("git", "-C", dir, "log", "--oneline", "-20")
	case "branch":
		cmd = exec.Command("git", "-C", dir, "branch", "-a", "--list")
	case "remote":
		cmd = exec.Command("git", "-C", dir, "remote", "-v")
	default:
		return fmt.Sprintf("Unknown git operation: %s (use: status, diff, log, branch, remote)", operation)
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Sprintf("git %s failed: %v\n%s", operation, err, string(out))
	}
	result := strings.TrimSpace(string(out))
	if result == "" {
		return fmt.Sprintf("git %s: (empty — working tree clean)", operation)
	}
	return result
}
