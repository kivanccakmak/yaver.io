package main

import (
	"fmt"
	"log"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// TestStatus represents the state of a test session.
type TestStatus string

const (
	TestStatusRunning   TestStatus = "running"
	TestStatusPassed    TestStatus = "passed"
	TestStatusFailed    TestStatus = "failed"
	TestStatusCancelled TestStatus = "cancelled"
)

// TestSession represents a test run.
type TestSession struct {
	ID        string     `json:"id"`
	Framework string     `json:"framework"` // flutter_test, jest, pytest, go_test, xctest, espresso, playwright, cypress, maestro
	TestType  string     `json:"testType"`  // unit, integration, e2e
	Command   string     `json:"command"`
	WorkDir   string     `json:"workDir"`
	Status    TestStatus `json:"status"`
	ExecID    string     `json:"execId,omitempty"`
	Results   *TestResults `json:"results,omitempty"`
	StartedAt string     `json:"startedAt"`
	FinishedAt string    `json:"finishedAt,omitempty"`
}

// TestResults holds parsed test output.
type TestResults struct {
	Total   int           `json:"total"`
	Passed  int           `json:"passed"`
	Failed  int           `json:"failed"`
	Skipped int           `json:"skipped"`
	Duration string       `json:"duration"`
	Failures []TestFailure `json:"failures,omitempty"`
}

// TestFailure describes a single test failure.
type TestFailure struct {
	Name    string `json:"name"`
	Message string `json:"message"`
}

// TestManager manages test sessions.
type TestManager struct {
	mu       sync.RWMutex
	sessions map[string]*TestSession
	execMgr  *ExecManager
	workDir  string
}

// NewTestManager creates a new test manager.
func NewTestManager(execMgr *ExecManager, workDir string) *TestManager {
	return &TestManager{
		sessions: make(map[string]*TestSession),
		execMgr:  execMgr,
		workDir:  workDir,
	}
}

// DetectTestFramework auto-detects the test framework in a directory.
func DetectTestFramework(workDir string) (framework, command, testType string) {
	checks := []struct {
		file      string
		framework string
		command   string
		testType  string
	}{
		{"pubspec.yaml", "flutter_test", "flutter test --reporter compact", "unit"},
		{".maestro", "maestro", "maestro test", "e2e"},
		{"playwright.config.ts", "playwright", "npx playwright test", "e2e"},
		{"playwright.config.js", "playwright", "npx playwright test", "e2e"},
		{"cypress.config.ts", "cypress", "npx cypress run", "e2e"},
		{"cypress.config.js", "cypress", "npx cypress run", "e2e"},
		{"jest.config.js", "jest", "npx jest", "unit"},
		{"jest.config.ts", "jest", "npx jest", "unit"},
		{"vitest.config.ts", "vitest", "npx vitest run", "unit"},
		{"vitest.config.js", "vitest", "npx vitest run", "unit"},
		{"pytest.ini", "pytest", "python -m pytest -v", "unit"},
		{"setup.py", "pytest", "python -m pytest -v", "unit"},
		{"pyproject.toml", "pytest", "python -m pytest -v", "unit"},
		{"Cargo.toml", "cargo_test", "cargo test", "unit"},
		{"go.mod", "go_test", "go test -v ./...", "unit"},
		{"build.gradle", "espresso", "", "unit"}, // resolved below
		{"build.gradle.kts", "espresso", "", "unit"},
	}

	for _, c := range checks {
		checkPath := filepath.Join(workDir, c.file)
		if c.file == ".maestro" {
			// Check if directory exists
			if fi, err := os.Stat(checkPath); err == nil && fi.IsDir() {
				return c.framework, c.command, c.testType
			}
			continue
		}
		if _, err := os.Stat(checkPath); err == nil {
			cmd := c.command
			if c.framework == "espresso" {
				// Resolve gradlew
				gradlew := filepath.Join(workDir, "gradlew")
				if _, err := os.Stat(gradlew); err == nil {
					cmd = fmt.Sprintf("JAVA_HOME=%s ./gradlew testDebugUnitTest", findJavaHome())
				} else {
					cmd = fmt.Sprintf("JAVA_HOME=%s gradle testDebugUnitTest", findJavaHome())
				}
			}
			return c.framework, cmd, c.testType
		}
	}

	// Check for Xcode project
	matches, _ := filepath.Glob(filepath.Join(workDir, "*.xcodeproj"))
	if len(matches) > 0 {
		return "xctest", "xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' -quiet", "unit"
	}

	return "", "", ""
}

// StartTest starts a test session.
func (tm *TestManager) StartTest(framework, command, workDir, testType string) (*TestSession, error) {
	if workDir == "" {
		workDir = tm.workDir
	}

	// Auto-detect if not specified
	if framework == "" || command == "" {
		f, c, t := DetectTestFramework(workDir)
		if f == "" {
			return nil, fmt.Errorf("could not auto-detect test framework in %s", workDir)
		}
		if framework == "" {
			framework = f
		}
		if command == "" {
			command = c
		}
		if testType == "" {
			testType = t
		}
	}

	// Auto-launch emulator/simulator if needed
	if framework == "espresso" || (framework == "xctest" && testType != "e2e") {
		if err := ensureEmulatorReady(framework); err != nil {
			log.Printf("[test] emulator warning: %v", err)
		}
	}

	// Start via ExecManager (30 min timeout for tests)
	session, err := tm.execMgr.StartExec(command, workDir, "", nil, 1800)
	if err != nil {
		return nil, fmt.Errorf("start test: %w", err)
	}

	ts := &TestSession{
		ID:        uuid.New().String()[:8],
		Framework: framework,
		TestType:  testType,
		Command:   command,
		WorkDir:   workDir,
		Status:    TestStatusRunning,
		ExecID:    session.ID,
		StartedAt: time.Now().UTC().Format(time.RFC3339),
	}

	tm.mu.Lock()
	tm.sessions[ts.ID] = ts
	tm.mu.Unlock()

	// Monitor completion
	go tm.monitorTest(ts, session)

	return ts, nil
}

func (tm *TestManager) monitorTest(ts *TestSession, session *ExecSession) {
	<-session.doneCh

	session.mu.RLock()
	exitCode := session.ExitCode
	stdout := session.stdout.String()
	session.mu.RUnlock()

	tm.mu.Lock()
	defer tm.mu.Unlock()

	ts.FinishedAt = time.Now().UTC().Format(time.RFC3339)

	if exitCode != nil && *exitCode == 0 {
		ts.Status = TestStatusPassed
	} else {
		ts.Status = TestStatusFailed
	}

	// Parse results from output
	ts.Results = parseTestResults(ts.Framework, stdout)

	log.Printf("[test] %s finished: %s (%s) — %d passed, %d failed",
		ts.ID, ts.Status, ts.Framework,
		ts.Results.Passed, ts.Results.Failed)
}

// parseTestResults extracts test counts from output based on framework.
func parseTestResults(framework, output string) *TestResults {
	r := &TestResults{}
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)

		switch framework {
		case "go_test":
			if strings.HasPrefix(line, "ok") {
				r.Passed++
			}
			if strings.HasPrefix(line, "FAIL") {
				r.Failed++
				r.Failures = append(r.Failures, TestFailure{Name: line, Message: line})
			}
			if strings.Contains(line, "--- PASS") {
				r.Passed++
			}
			if strings.Contains(line, "--- FAIL") {
				r.Failed++
			}
		case "jest", "vitest":
			if strings.Contains(line, "Tests:") {
				// "Tests:  2 passed, 2 total"
				if strings.Contains(line, "passed") {
					fmt.Sscanf(line, "Tests: %d passed", &r.Passed)
				}
				if strings.Contains(line, "failed") {
					fmt.Sscanf(line, "Tests: %d failed", &r.Failed)
				}
			}
		case "pytest":
			// "2 passed in 0.05s" or "1 failed, 2 passed in 0.10s"
			if strings.Contains(line, " passed") {
				fmt.Sscanf(line, "%d passed", &r.Passed)
			}
			if strings.Contains(line, " failed") {
				fmt.Sscanf(line, "%d failed", &r.Failed)
			}
		case "flutter_test":
			// "+2: All tests passed!" or "+1 -1: Some tests failed."
			if strings.Contains(line, "All tests passed") {
				// Count from "+N:"
				fmt.Sscanf(line, "+%d:", &r.Passed)
			}
		default:
			// Generic: count lines with PASS/FAIL
			if strings.Contains(strings.ToUpper(line), "PASS") {
				r.Passed++
			}
			if strings.Contains(strings.ToUpper(line), "FAIL") {
				r.Failed++
			}
		}
	}

	r.Total = r.Passed + r.Failed + r.Skipped
	return r
}

// GetTest returns a test session by ID.
func (tm *TestManager) GetTest(id string) (*TestSession, bool) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	t, ok := tm.sessions[id]
	return t, ok
}

// ensureEmulatorReady launches an emulator/simulator if none is running.
func ensureEmulatorReady(framework string) error {
	switch framework {
	case "espresso":
		// Check if an Android emulator/device is connected
		out, err := osexec.Command("adb", "devices").Output()
		if err != nil {
			return fmt.Errorf("adb not found: %w", err)
		}
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		// First line is header, any subsequent lines with "device" means connected
		for _, line := range lines[1:] {
			if strings.Contains(line, "device") && !strings.Contains(line, "offline") {
				log.Printf("[test] Android device/emulator already connected")
				return nil
			}
		}
		// Launch emulator
		avds, err := osexec.Command("emulator", "-list-avds").Output()
		if err != nil {
			// Try ANDROID_HOME path
			androidHome := os.Getenv("ANDROID_HOME")
			if androidHome != "" {
				avds, err = osexec.Command(filepath.Join(androidHome, "emulator", "emulator"), "-list-avds").Output()
			}
			if err != nil {
				return fmt.Errorf("no emulator found. Install Android emulator or connect a device")
			}
		}
		avdList := strings.Split(strings.TrimSpace(string(avds)), "\n")
		if len(avdList) == 0 || avdList[0] == "" {
			return fmt.Errorf("no AVDs found. Create one in Android Studio")
		}
		// Boot first AVD in background
		avdName := avdList[0]
		log.Printf("[test] Booting Android emulator: %s", avdName)
		cmd := osexec.Command("emulator", "-avd", avdName, "-no-window", "-no-audio")
		cmd.Start() // Don't wait — emulator runs in background
		// Wait for device to be ready (max 60s)
		for i := 0; i < 30; i++ {
			time.Sleep(2 * time.Second)
			out, _ := osexec.Command("adb", "shell", "getprop", "sys.boot_completed").Output()
			if strings.TrimSpace(string(out)) == "1" {
				log.Printf("[test] Android emulator ready")
				return nil
			}
		}
		return fmt.Errorf("emulator boot timeout (60s)")

	case "xctest":
		// Check if a simulator is booted
		out, err := osexec.Command("xcrun", "simctl", "list", "devices", "booted").Output()
		if err != nil {
			return fmt.Errorf("xcrun simctl not found: %w", err)
		}
		if strings.Contains(string(out), "iPhone") || strings.Contains(string(out), "iPad") {
			log.Printf("[test] iOS simulator already booted")
			return nil
		}
		// Boot default simulator
		log.Printf("[test] Booting iOS simulator...")
		if err := osexec.Command("xcrun", "simctl", "boot", "iPhone 16").Run(); err != nil {
			// Try iPhone 15 as fallback
			if err := osexec.Command("xcrun", "simctl", "boot", "iPhone 15").Run(); err != nil {
				return fmt.Errorf("could not boot simulator: %w", err)
			}
		}
		log.Printf("[test] iOS simulator booted")
		return nil
	}
	return nil
}

// ListTests returns all test sessions.
func (tm *TestManager) ListTests() []*TestSession {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	result := make([]*TestSession, 0, len(tm.sessions))
	for _, t := range tm.sessions {
		result = append(result, t)
	}
	return result
}
