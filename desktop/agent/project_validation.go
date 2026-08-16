package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type ValidationRun struct {
	ValidationRunID  string     `json:"validationRunId"`
	ProjectSessionID string     `json:"projectSessionId"`
	Kind             string     `json:"kind"`
	CommandProfile   string     `json:"commandProfile"`
	Ref              string     `json:"ref"`
	CommitSHA        string     `json:"commitSha"`
	Runner           string     `json:"runner"`
	Status           string     `json:"status"`
	ExitCode         *int       `json:"exitCode,omitempty"`
	Output           string     `json:"output,omitempty"`
	StartedAt        time.Time  `json:"startedAt"`
	FinishedAt       *time.Time `json:"finishedAt,omitempty"`

	cancel context.CancelFunc
}

type ProjectValidationManager struct {
	mu   sync.RWMutex
	runs map[string]*ValidationRun
}

func NewProjectValidationManager() *ProjectValidationManager {
	return &ProjectValidationManager{runs: make(map[string]*ValidationRun)}
}

func validationCommand(session *ProjectSession, kind string) (string, []string, string, error) {
	workDir, manifest, err := readPreviewManifest(session.WorkDir)
	if err != nil {
		return "", nil, "", err
	}
	script := ""
	switch kind {
	case "lint":
		script = "lint"
	case "typecheck":
		if manifest.Scripts["typecheck"] != "" {
			script = "typecheck"
		} else if _, statErr := os.Stat(filepath.Join(workDir, "tsconfig.json")); statErr == nil {
			return "npx", []string{"tsc", "--noEmit"}, workDir, nil
		}
	case "test":
		script = "test"
	case "build":
		script = "build"
	default:
		return "", nil, "", fmt.Errorf("validation kind must be lint, typecheck, test, or build")
	}
	if script == "" || manifest.Scripts[script] == "" {
		return "", nil, "", fmt.Errorf("project has no %s script", kind)
	}
	return "npm", []string{"run", script}, workDir, nil
}

func (m *ProjectValidationManager) Start(session *ProjectSession, kind string) (*ValidationRun, error) {
	if session.Status != "ready" {
		return nil, fmt.Errorf("Project Session is not ready")
	}
	kind = strings.TrimSpace(kind)
	command, args, workDir, err := validationCommand(session, kind)
	if err != nil {
		return nil, err
	}
	m.mu.RLock()
	for _, existing := range m.runs {
		if existing.ProjectSessionID == session.ProjectSessionID && (existing.Status == "queued" || existing.Status == "running") {
			m.mu.RUnlock()
			return nil, fmt.Errorf("a validation run is already active for this Project Session")
		}
	}
	m.mu.RUnlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	gitCtx, gitCancel := context.WithTimeout(context.Background(), 10*time.Second)
	commitOut, commitErr := runProjectSessionGit(gitCtx, session.WorkDir, "rev-parse", "HEAD")
	gitCancel()
	if commitErr != nil {
		cancel()
		return nil, fmt.Errorf("resolve validation commit: %w", commitErr)
	}
	run := &ValidationRun{
		ValidationRunID:  "vr_" + strings.ReplaceAll(uuid.New().String(), "-", "")[:20],
		ProjectSessionID: session.ProjectSessionID,
		Kind:             kind,
		CommandProfile:   "project-script:" + kind,
		Ref:              session.ReviewBranch,
		CommitSHA:        strings.TrimSpace(string(commitOut)),
		Runner:           runtime.GOOS + "/" + runtime.GOARCH,
		Status:           "queued",
		StartedAt:        time.Now().UTC(),
		cancel:           cancel,
	}
	m.mu.Lock()
	m.runs[run.ValidationRunID] = run
	m.mu.Unlock()
	go m.execute(ctx, run, workDir, command, args)
	copy := *run
	copy.cancel = nil
	return &copy, nil
}

func (m *ProjectValidationManager) execute(ctx context.Context, run *ValidationRun, workDir, command string, args []string) {
	m.mu.Lock()
	run.Status = "running"
	m.mu.Unlock()
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = workDir
	cmd.Env = append(os.Environ(), "CI=1")
	detachProcess(cmd)
	cmd.Cancel = func() error {
		return terminateProcessTree(cmd.Process)
	}
	cmd.WaitDelay = 5 * time.Second
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	err := cmd.Run()
	finished := time.Now().UTC()
	exitCode := 0
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	} else if err != nil {
		exitCode = -1
	}
	result := output.String()
	result = strings.ReplaceAll(result, workDir, "$PROJECT")
	const maxValidationOutput = 1024 * 1024
	if len(result) > maxValidationOutput {
		result = result[len(result)-maxValidationOutput:] + "\n[earlier output truncated]"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	run.Output = result
	run.ExitCode = &exitCode
	run.FinishedAt = &finished
	if run.Status == "stopped" {
		return
	}
	if ctx.Err() != nil {
		run.Status = "stopped"
	} else if err != nil {
		run.Status = "failed"
	} else {
		run.Status = "passed"
	}
}

func (m *ProjectValidationManager) Get(id string) (*ValidationRun, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	run, ok := m.runs[id]
	if !ok {
		return nil, false
	}
	copy := *run
	copy.cancel = nil
	return &copy, true
}

func (m *ProjectValidationManager) List(projectSessionID string) []ValidationRun {
	m.mu.RLock()
	defer m.mu.RUnlock()
	runs := make([]ValidationRun, 0)
	for _, run := range m.runs {
		if run.ProjectSessionID == projectSessionID {
			copy := *run
			copy.cancel = nil
			runs = append(runs, copy)
		}
	}
	sort.Slice(runs, func(i, j int) bool { return runs[i].StartedAt.After(runs[j].StartedAt) })
	return runs
}

func (m *ProjectValidationManager) Stop(id string) error {
	m.mu.Lock()
	run, ok := m.runs[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("validation run not found")
	}
	if run.Status != "queued" && run.Status != "running" {
		m.mu.Unlock()
		return nil
	}
	run.Status = "stopped"
	cancel := run.cancel
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}

func (m *ProjectValidationManager) StopSession(projectSessionID string) {
	m.mu.RLock()
	ids := make([]string, 0)
	for id, run := range m.runs {
		if run.ProjectSessionID == projectSessionID && (run.Status == "queued" || run.Status == "running") {
			ids = append(ids, id)
		}
	}
	m.mu.RUnlock()
	for _, id := range ids {
		_ = m.Stop(id)
	}
}

func (m *ProjectValidationManager) StopAll() {
	m.mu.RLock()
	ids := make([]string, 0, len(m.runs))
	for id := range m.runs {
		ids = append(ids, id)
	}
	m.mu.RUnlock()
	for _, id := range ids {
		_ = m.Stop(id)
	}
}
