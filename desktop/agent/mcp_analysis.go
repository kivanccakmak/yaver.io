package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Static Analysis Tools
// ---------------------------------------------------------------------------

// mcpCppcheck runs cppcheck C/C++ static analysis with severity filtering.
func mcpCppcheck(dir, file, severity string, enableAll bool) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	args := []string{"--template=gcc"}
	if severity != "" {
		args = append(args, "--enable="+severity)
	} else if enableAll {
		args = append(args, "--enable=all")
	} else {
		args = append(args, "--enable=warning,style,performance,portability")
	}
	target := "."
	if file != "" {
		target = file
	}
	args = append(args, target)
	cmd := osexec.Command("cppcheck", args...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": duration.String(),
		"clean":    err == nil && !strings.Contains(string(out), "error:"),
	}
	if err != nil {
		result["error"] = err.Error()
	}
	// Count issues by severity
	lines := strings.Split(string(out), "\n")
	issues := 0
	for _, l := range lines {
		if strings.Contains(l, "error:") || strings.Contains(l, "warning:") || strings.Contains(l, "style:") || strings.Contains(l, "performance:") {
			issues++
		}
	}
	result["issue_count"] = issues
	return result
}

// mcpShellcheck runs shellcheck on shell scripts.
func mcpShellcheck(file, shell, severity string) interface{} {
	if file == "" {
		return map[string]interface{}{"error": "file is required"}
	}
	args := []string{"-f", "gcc"}
	if shell != "" {
		args = append(args, "-s", shell)
	}
	if severity != "" {
		args = append(args, "-S", severity)
	}
	args = append(args, file)
	start := time.Now()
	out, err := runCmd("shellcheck", args...)
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   out,
		"duration": duration.String(),
		"clean":    err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	// Count warnings
	lines := strings.Split(out, "\n")
	issues := 0
	for _, l := range lines {
		if strings.Contains(l, ":") && (strings.Contains(l, "warning:") || strings.Contains(l, "error:") || strings.Contains(l, "note:")) {
			issues++
		}
	}
	result["issue_count"] = issues
	return result
}

// mcpHadolint lints Dockerfiles.
func mcpHadolint(file string, trustedRegistries []string) interface{} {
	if file == "" {
		file = "Dockerfile"
	}
	args := []string{file}
	for _, reg := range trustedRegistries {
		args = append(args, "--trusted-registry", reg)
	}
	start := time.Now()
	out, err := runCmd("hadolint", args...)
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   out,
		"duration": duration.String(),
		"clean":    err == nil && out == "",
	}
	if err != nil {
		result["error"] = err.Error()
	}
	if out != "" {
		result["issue_count"] = len(strings.Split(strings.TrimSpace(out), "\n"))
	} else {
		result["issue_count"] = 0
	}
	return result
}

// mcpSemgrep runs Semgrep multi-language static analysis.
func mcpSemgrep(dir, config string, autoConfig bool) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	args := []string{"scan"}
	if config != "" {
		args = append(args, "--config", config)
	} else if autoConfig {
		args = append(args, "--config", "auto")
	} else {
		args = append(args, "--config", "auto")
	}
	args = append(args, "--json")
	cmd := osexec.Command("semgrep", args...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": duration.String(),
		"clean":    err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpSonarScanner runs SonarQube/SonarCloud scanner.
func mcpSonarScanner(dir, projectKey, hostURL, token string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	// Try sonar-scanner, then sonar-scanner-cli
	binary := "sonar-scanner"
	if _, err := osexec.LookPath(binary); err != nil {
		binary = "sonar-scanner-cli"
		if _, err := osexec.LookPath(binary); err != nil {
			return map[string]interface{}{"error": "sonar-scanner not found. Install via: brew install sonar-scanner or https://docs.sonarqube.org/latest/analysis/scan/sonarscanner/"}
		}
	}
	args := []string{}
	if projectKey != "" {
		args = append(args, "-Dsonar.projectKey="+projectKey)
	}
	if hostURL != "" {
		args = append(args, "-Dsonar.host.url="+hostURL)
	}
	if token != "" {
		args = append(args, "-Dsonar.token="+token)
	}
	cmd := osexec.Command(binary, args...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": duration.String(),
		"passed":   err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpBandit runs Bandit Python security analysis.
func mcpBandit(dir, file, severity string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	args := []string{"-f", "json"}
	if severity != "" {
		args = append(args, "-l", severity) // -l = low, -ll = medium, -lll = high
	}
	if file != "" {
		args = append(args, file)
	} else {
		args = append(args, "-r", ".")
	}
	cmd := osexec.Command("bandit", args...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": duration.String(),
		"clean":    err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpGosec runs gosec Go security analysis.
func mcpGosec(dir string, noFail bool) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	args := []string{"-fmt=json"}
	if noFail {
		args = append(args, "-no-fail")
	}
	args = append(args, "./...")
	cmd := osexec.Command("gosec", args...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": duration.String(),
		"clean":    err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpBrakeman runs Brakeman Ruby/Rails security scanner.
func mcpBrakeman(dir string, confidence int) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	args := []string{"-f", "json", "-q"}
	if confidence > 0 {
		args = append(args, "-w", strconv.Itoa(confidence))
	}
	args = append(args, "-p", ".")
	cmd := osexec.Command("brakeman", args...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": duration.String(),
		"clean":    err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpSafetyCheck checks Python dependencies for known vulnerabilities.
func mcpSafetyCheck(dir, file string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	args := []string{"check", "--output", "json"}
	if file != "" {
		args = append(args, "-r", file)
	} else {
		// Auto-detect requirements file
		for _, f := range []string{"requirements.txt", "requirements-dev.txt", "requirements/base.txt"} {
			if _, err := os.Stat(fmt.Sprintf("%s/%s", dir, f)); err == nil {
				args = append(args, "-r", f)
				break
			}
		}
	}
	cmd := osexec.Command("safety", args...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": duration.String(),
		"clean":    err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpTrivyFSScan runs Trivy filesystem vulnerability scan.
func mcpTrivyFSScan(dir, severity string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	args := []string{"fs", "--format", "json"}
	if severity != "" {
		args = append(args, "--severity", severity)
	}
	args = append(args, ".")
	cmd := osexec.Command("trivy", args...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": duration.String(),
		"clean":    err == nil,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// ---------------------------------------------------------------------------
// Profiling & Debugging Tools
// ---------------------------------------------------------------------------

// mcpValgrindMemcheck runs Valgrind memcheck for memory leak detection.
func mcpValgrindMemcheck(binary string, args []string) interface{} {
	if binary == "" {
		return map[string]interface{}{"error": "binary is required"}
	}
	vArgs := []string{"--tool=memcheck", "--leak-check=full", "--show-leak-kinds=all", "--track-origins=yes", binary}
	vArgs = append(vArgs, args...)
	start := time.Now()
	out, err := runCmd("valgrind", vArgs...)
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   out,
		"duration": duration.String(),
	}
	if err != nil {
		result["error"] = err.Error()
	}
	// Parse summary
	if strings.Contains(out, "definitely lost:") {
		for _, line := range strings.Split(out, "\n") {
			line = strings.TrimSpace(line)
			if strings.Contains(line, "definitely lost:") {
				result["definitely_lost"] = line
			} else if strings.Contains(line, "indirectly lost:") {
				result["indirectly_lost"] = line
			} else if strings.Contains(line, "possibly lost:") {
				result["possibly_lost"] = line
			} else if strings.Contains(line, "ERROR SUMMARY:") {
				result["error_summary"] = line
			}
		}
	}
	return result
}

// mcpValgrindCallgrind runs Valgrind callgrind for call graph profiling.
func mcpValgrindCallgrind(binary string, args []string, outputFile string) interface{} {
	if binary == "" {
		return map[string]interface{}{"error": "binary is required"}
	}
	if outputFile == "" {
		outputFile = "callgrind.out"
	}
	vArgs := []string{"--tool=callgrind", "--callgrind-out-file=" + outputFile, binary}
	vArgs = append(vArgs, args...)
	start := time.Now()
	out, err := runCmd("valgrind", vArgs...)
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":      out,
		"duration":    duration.String(),
		"output_file": outputFile,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	// Try to annotate with callgrind_annotate
	annotOut, annotErr := runCmd("callgrind_annotate", outputFile)
	if annotErr == nil {
		lines := strings.Split(annotOut, "\n")
		if len(lines) > 50 {
			annotOut = strings.Join(lines[:50], "\n") + fmt.Sprintf("\n... (%d more lines)", len(lines)-50)
		}
		result["annotation"] = annotOut
	}
	return result
}

// mcpValgrindMassif runs Valgrind massif for heap profiling.
func mcpValgrindMassif(binary string, args []string, outputFile string) interface{} {
	if binary == "" {
		return map[string]interface{}{"error": "binary is required"}
	}
	if outputFile == "" {
		outputFile = "massif.out"
	}
	vArgs := []string{"--tool=massif", "--massif-out-file=" + outputFile, binary}
	vArgs = append(vArgs, args...)
	start := time.Now()
	out, err := runCmd("valgrind", vArgs...)
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":      out,
		"duration":    duration.String(),
		"output_file": outputFile,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	// Try to print with ms_print
	msOut, msErr := runCmd("ms_print", outputFile)
	if msErr == nil {
		lines := strings.Split(msOut, "\n")
		if len(lines) > 80 {
			msOut = strings.Join(lines[:80], "\n") + fmt.Sprintf("\n... (%d more lines)", len(lines)-80)
		}
		result["heap_profile"] = msOut
	}
	return result
}

// mcpGDBBacktrace gets a backtrace from a running process using GDB.
func mcpGDBBacktrace(pid int, binary string) interface{} {
	if pid <= 0 && binary == "" {
		return map[string]interface{}{"error": "pid or binary is required"}
	}
	var out string
	var err error
	if pid > 0 {
		out, err = runCmd("gdb", "-batch", "-ex", "thread apply all bt full", "-p", strconv.Itoa(pid))
	} else {
		out, err = runCmd("gdb", "-batch", "-ex", "run", "-ex", "thread apply all bt full", binary)
	}
	result := map[string]interface{}{"output": out}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpLLDBBacktrace gets a backtrace from a running process using LLDB.
func mcpLLDBBacktrace(pid int, binary string) interface{} {
	if pid <= 0 && binary == "" {
		return map[string]interface{}{"error": "pid or binary is required"}
	}
	var out string
	var err error
	if pid > 0 {
		out, err = runCmd("lldb", "-batch", "-o", "process attach --pid "+strconv.Itoa(pid), "-o", "thread backtrace all", "-o", "quit")
	} else {
		out, err = runCmd("lldb", "-batch", "-o", "run", "-o", "thread backtrace all", "-o", "quit", "--", binary)
	}
	result := map[string]interface{}{"output": out}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpStraceTrace traces system calls of a process.
func mcpStraceTrace(pid int, binary string, syscallFilter string, args []string) interface{} {
	if pid <= 0 && binary == "" {
		return map[string]interface{}{"error": "pid or binary is required"}
	}
	sArgs := []string{"-c", "-S", "calls"} // summary mode by default
	if syscallFilter != "" {
		sArgs = append(sArgs, "-e", "trace="+syscallFilter)
	}
	if pid > 0 {
		sArgs = append(sArgs, "-p", strconv.Itoa(pid))
	} else {
		sArgs = append(sArgs, binary)
		sArgs = append(sArgs, args...)
	}
	start := time.Now()
	out, err := runCmd("strace", sArgs...)
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   out,
		"duration": duration.String(),
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpLtraceTrace traces library calls of a process.
func mcpLtraceTrace(pid int, binary string, args []string) interface{} {
	if pid <= 0 && binary == "" {
		return map[string]interface{}{"error": "pid or binary is required"}
	}
	lArgs := []string{"-c"} // summary mode
	if pid > 0 {
		lArgs = append(lArgs, "-p", strconv.Itoa(pid))
	} else {
		lArgs = append(lArgs, binary)
		lArgs = append(lArgs, args...)
	}
	start := time.Now()
	out, err := runCmd("ltrace", lArgs...)
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   out,
		"duration": duration.String(),
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpPerfRecord records performance data using perf.
func mcpPerfRecord(binary string, args []string, duration int, outputFile string) interface{} {
	if binary == "" {
		return map[string]interface{}{"error": "binary is required"}
	}
	if outputFile == "" {
		outputFile = "perf.data"
	}
	pArgs := []string{"record", "-o", outputFile, "-g"}
	if duration > 0 {
		pArgs = append(pArgs, "--", "timeout", strconv.Itoa(duration), binary)
	} else {
		pArgs = append(pArgs, "--", binary)
	}
	pArgs = append(pArgs, args...)
	start := time.Now()
	out, err := runCmd("perf", pArgs...)
	elapsed := time.Since(start)
	result := map[string]interface{}{
		"output":      out,
		"duration":    elapsed.String(),
		"output_file": outputFile,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	// Try to generate report
	reportOut, reportErr := runCmd("perf", "report", "-i", outputFile, "--stdio", "--no-children")
	if reportErr == nil {
		lines := strings.Split(reportOut, "\n")
		if len(lines) > 60 {
			reportOut = strings.Join(lines[:60], "\n") + fmt.Sprintf("\n... (%d more lines)", len(lines)-60)
		}
		result["report"] = reportOut
	}
	return result
}

// mcpPerfStat runs perf stat to collect performance counters.
func mcpPerfStat(binary string, args []string, events string) interface{} {
	if binary == "" {
		return map[string]interface{}{"error": "binary is required"}
	}
	pArgs := []string{"stat"}
	if events != "" {
		pArgs = append(pArgs, "-e", events)
	}
	pArgs = append(pArgs, "--", binary)
	pArgs = append(pArgs, args...)
	start := time.Now()
	out, err := runCmd("perf", pArgs...)
	elapsed := time.Since(start)
	result := map[string]interface{}{
		"output":   out,
		"duration": elapsed.String(),
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpGoPprofCPU runs Go CPU profiling on a Go binary or test.
func mcpGoPprofCPU(dir string, duration int, binary string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	if duration <= 0 {
		duration = 30
	}
	profileFile := fmt.Sprintf("/tmp/cpu_profile_%d.prof", time.Now().UnixNano())
	var cmd *osexec.Cmd
	if binary != "" {
		// Profile a running binary via HTTP endpoint
		cmd = osexec.Command("go", "tool", "pprof", "-text", "-seconds", strconv.Itoa(duration), binary)
	} else {
		// Run tests with CPU profiling
		cmd = osexec.Command("go", "test", "-cpuprofile", profileFile, "-bench=.", "-benchtime="+strconv.Itoa(duration)+"s", "./...")
	}
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	elapsed := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": elapsed.String(),
	}
	if err != nil {
		result["error"] = err.Error()
	}
	// If profile file was generated, analyze it
	if _, statErr := os.Stat(profileFile); statErr == nil {
		pprofCmd := osexec.Command("go", "tool", "pprof", "-text", "-cum", profileFile)
		pprofCmd.Dir = dir
		pprofOut, pprofErr := pprofCmd.CombinedOutput()
		if pprofErr == nil {
			lines := strings.Split(string(pprofOut), "\n")
			if len(lines) > 40 {
				result["top_functions"] = strings.Join(lines[:40], "\n")
			} else {
				result["top_functions"] = string(pprofOut)
			}
		}
		result["profile_file"] = profileFile
	}
	return result
}

// mcpGoPprofHeap runs Go heap profiling.
func mcpGoPprofHeap(dir, url string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	var cmd *osexec.Cmd
	if url != "" {
		// Fetch heap profile from running service
		cmd = osexec.Command("go", "tool", "pprof", "-text", "-inuse_space", url+"/debug/pprof/heap")
	} else {
		// Run tests with memory profiling
		profileFile := fmt.Sprintf("/tmp/heap_profile_%d.prof", time.Now().UnixNano())
		cmd = osexec.Command("go", "test", "-memprofile", profileFile, "-bench=.", "-benchmem", "./...")
	}
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	elapsed := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": elapsed.String(),
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpHeaptrack runs heaptrack for heap allocation profiling (Linux).
func mcpHeaptrack(binary string, args []string) interface{} {
	if binary == "" {
		return map[string]interface{}{"error": "binary is required"}
	}
	hArgs := []string{binary}
	hArgs = append(hArgs, args...)
	start := time.Now()
	out, err := runCmd("heaptrack", hArgs...)
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   out,
		"duration": duration.String(),
	}
	if err != nil {
		result["error"] = err.Error()
	}
	// Try to find and analyze the output file
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "heaptrack output will be written to") || strings.Contains(line, "Heaptrack finished") {
			result["info"] = strings.TrimSpace(line)
		}
		if strings.HasSuffix(strings.TrimSpace(line), ".gz") || strings.HasSuffix(strings.TrimSpace(line), ".zst") {
			outputFile := strings.TrimSpace(line)
			// Try to print analysis
			analysisOut, analysisErr := runCmd("heaptrack_print", outputFile)
			if analysisErr == nil {
				lines := strings.Split(analysisOut, "\n")
				if len(lines) > 60 {
					analysisOut = strings.Join(lines[:60], "\n") + fmt.Sprintf("\n... (%d more lines)", len(lines)-60)
				}
				result["analysis"] = analysisOut
			}
		}
	}
	return result
}

// ---------------------------------------------------------------------------
// Code Metrics Tools
// ---------------------------------------------------------------------------

// mcpCyclomaticComplexity measures cyclomatic complexity using radon (Python) or gocyclo (Go).
func mcpCyclomaticComplexity(dir, language string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	var cmd *osexec.Cmd
	var tool string
	switch language {
	case "python", "py":
		tool = "radon"
		cmd = osexec.Command("radon", "cc", "-s", "-a", ".")
	case "go", "golang":
		tool = "gocyclo"
		cmd = osexec.Command("gocyclo", "-over", "10", ".")
		if _, err := osexec.LookPath("gocyclo"); err != nil {
			// Try gocognit as alternative
			tool = "gocognit"
			cmd = osexec.Command("gocognit", "-over", "10", ".")
		}
	case "js", "javascript", "ts", "typescript":
		tool = "cr"
		cmd = osexec.Command("npx", "complexity-report", "--format", "json", ".")
		if _, err := osexec.LookPath("npx"); err != nil {
			return map[string]interface{}{"error": "npx not found, install Node.js"}
		}
	default:
		// Auto-detect
		if _, err := os.Stat(dir + "/go.mod"); err == nil {
			tool = "gocyclo"
			cmd = osexec.Command("gocyclo", "-over", "10", ".")
			if _, lookErr := osexec.LookPath("gocyclo"); lookErr != nil {
				tool = "gocognit"
				cmd = osexec.Command("gocognit", "-over", "10", ".")
			}
		} else if _, err := os.Stat(dir + "/pyproject.toml"); err == nil {
			tool = "radon"
			cmd = osexec.Command("radon", "cc", "-s", "-a", ".")
		} else {
			tool = "radon"
			cmd = osexec.Command("radon", "cc", "-s", "-a", ".")
		}
	}
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"tool":     tool,
		"duration": duration.String(),
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result
}

// mcpLizard runs lizard code complexity analysis (supports many languages).
func mcpLizard(dir string, threshold int, languages string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	args := []string{}
	if threshold > 0 {
		args = append(args, "-C", strconv.Itoa(threshold))
	}
	if languages != "" {
		args = append(args, "-l", languages)
	}
	args = append(args, ".")
	cmd := osexec.Command("lizard", args...)
	cmd.Dir = dir
	start := time.Now()
	out, err := cmd.CombinedOutput()
	duration := time.Since(start)
	result := map[string]interface{}{
		"output":   string(out),
		"duration": duration.String(),
	}
	if err != nil {
		result["error"] = err.Error()
	}
	// Extract summary if present
	lines := strings.Split(string(out), "\n")
	for i, line := range lines {
		if strings.Contains(line, "Total nloc") || strings.Contains(line, "Average") {
			result["summary"] = strings.Join(lines[i:], "\n")
			break
		}
	}
	return result
}

// mcpLOCCount counts lines of code using tokei, scc, or cloc (with fallbacks).
func mcpLOCCount(dir, tool string) interface{} {
	if dir == "" {
		dir, _ = os.Getwd()
	}
	type locTool struct {
		name string
		args []string
	}
	// Priority order for auto-detection
	tools := []locTool{
		{"tokei", []string{"--output", "json", "."}},
		{"scc", []string{"--format", "json", "."}},
		{"cloc", []string{"--json", "."}},
	}
	if tool != "" {
		// User specified a specific tool
		switch tool {
		case "tokei":
			tools = []locTool{{"tokei", []string{"--output", "json", "."}}}
		case "scc":
			tools = []locTool{{"scc", []string{"--format", "json", "."}}}
		case "cloc":
			tools = []locTool{{"cloc", []string{"--json", "."}}}
		default:
			tools = []locTool{{tool, []string{"."}}}
		}
	}
	for _, t := range tools {
		if _, err := osexec.LookPath(t.name); err != nil {
			continue
		}
		cmd := osexec.Command(t.name, t.args...)
		cmd.Dir = dir
		start := time.Now()
		out, err := cmd.CombinedOutput()
		duration := time.Since(start)
		result := map[string]interface{}{
			"output":   string(out),
			"tool":     t.name,
			"duration": duration.String(),
		}
		if err != nil {
			result["error"] = err.Error()
		}
		return result
	}
	// No tool found — try wc -l as last resort
	out, err := runCmd("sh", "-c", fmt.Sprintf("find %s -type f \\( -name '*.go' -o -name '*.py' -o -name '*.js' -o -name '*.ts' -o -name '*.rs' -o -name '*.c' -o -name '*.cpp' -o -name '*.h' -o -name '*.java' -o -name '*.rb' \\) ! -path '*/vendor/*' ! -path '*/node_modules/*' ! -path '*/.git/*' | xargs wc -l 2>/dev/null | tail -1", dir))
	result := map[string]interface{}{
		"output": out,
		"tool":   "wc -l (fallback)",
	}
	if err != nil {
		result["error"] = "No LOC counter found. Install tokei (cargo install tokei), scc (brew install scc), or cloc (brew install cloc)."
	}
	return result
}
