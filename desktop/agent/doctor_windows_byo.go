package main

// doctor_windows_byo.go provides one bounded, machine-readable gate for the
// native Windows friend beta. Inventory alone is not reported as readiness:
// the live mode also proves an interactive desktop can be captured and encoded.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	windowsBYOPass = "pass"
	windowsBYOWarn = "warn"
	windowsBYOFail = "fail"
	windowsBYOSkip = "skip"
)

type WindowsBYODoctorOptions struct {
	ProjectRoot string `json:"projectRoot"`
	Runner      string `json:"runner"`
	Live        bool   `json:"live"`
}

type WindowsBYOCheck struct {
	ID         string `json:"id"`
	Status     string `json:"status"`
	ReasonCode string `json:"reasonCode"`
	Required   bool   `json:"required"`
	Detail     string `json:"detail,omitempty"`
	Remedy     string `json:"remedy,omitempty"`
}

type WindowsBYODoctorReport struct {
	Ready        bool              `json:"ready"`
	Platform     string            `json:"platform"`
	Architecture string            `json:"architecture"`
	ProjectRoot  string            `json:"projectRoot,omitempty"`
	Runner       string            `json:"runner"`
	Live         bool              `json:"live"`
	GeneratedAt  string            `json:"generatedAt"`
	Checks       []WindowsBYOCheck `json:"checks"`
}

func windowsBYOCheck(id, status, reason string, required bool, detail, remedy string) WindowsBYOCheck {
	return WindowsBYOCheck{ID: id, Status: status, ReasonCode: reason, Required: required, Detail: detail, Remedy: remedy}
}

func RunWindowsBYODoctor(ctx context.Context, opts WindowsBYODoctorOptions) WindowsBYODoctorReport {
	if ctx == nil {
		ctx = context.Background()
	}
	opts.Runner = strings.TrimSpace(opts.Runner)
	if opts.Runner == "" {
		opts.Runner = "codex"
	}
	report := WindowsBYODoctorReport{
		Platform:     runtime.GOOS,
		Architecture: runtime.GOARCH,
		Runner:       opts.Runner,
		Live:         opts.Live,
		GeneratedAt:  time.Now().UTC().Format(time.RFC3339),
	}
	report.Checks = append(report.Checks, windowsBYOPlatformChecks(ctx, opts)...)
	root, projectChecks := windowsBYOProjectChecks(ctx, opts.ProjectRoot)
	report.ProjectRoot = root
	report.Checks = append(report.Checks, projectChecks...)
	report.Checks = append(report.Checks, windowsBYOToolChecks(ctx, opts.Runner)...)
	if opts.Live {
		report.Checks = append(report.Checks, windowsBYOLiveChecks(ctx)...)
	} else {
		report.Checks = append(report.Checks, windowsBYOCheck(
			"desktop.capture-operation", windowsBYOSkip, "LIVE_PROBE_NOT_REQUESTED", true, "inventory only; no screen pixels were captured", "Run `yaver doctor windows-byo --live` while the Windows desktop is unlocked.",
		))
	}
	report.Ready = true
	for _, check := range report.Checks {
		if check.Required && check.Status != windowsBYOPass {
			report.Ready = false
			break
		}
	}
	return report
}

func windowsBYOProjectChecks(ctx context.Context, requested string) (string, []WindowsBYOCheck) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return "", []WindowsBYOCheck{windowsBYOCheck("project.boundary", windowsBYOFail, "PROJECT_REQUIRED", true, "no project directory selected", "Pass --project with the exact native Windows checkout to use.")}
	}
	root, err := filepath.Abs(requested)
	if err == nil {
		if resolved, resolveErr := filepath.EvalSymlinks(root); resolveErr == nil {
			root = resolved
		}
	}
	if err != nil {
		return requested, []WindowsBYOCheck{windowsBYOCheck("project.boundary", windowsBYOFail, "PROJECT_PATH_INVALID", true, err.Error(), "Choose an existing project directory.")}
	}
	info, statErr := os.Stat(root)
	if statErr != nil || !info.IsDir() {
		detail := "not a directory"
		if statErr != nil {
			detail = statErr.Error()
		}
		return root, []WindowsBYOCheck{windowsBYOCheck("project.boundary", windowsBYOFail, "PROJECT_NOT_DIRECTORY", true, detail, "Choose an existing project directory.")}
	}
	home, _ := os.UserHomeDir()
	if resolved, resolveErr := filepath.EvalSymlinks(home); resolveErr == nil {
		home = resolved
	}
	volumeRoot := filepath.VolumeName(root) + string(os.PathSeparator)
	if samePath(root, home) || samePath(root, volumeRoot) {
		return root, []WindowsBYOCheck{windowsBYOCheck("project.boundary", windowsBYOFail, "PROJECT_SCOPE_TOO_BROAD", true, "the selected directory is a home or volume root", "Select one repository directory, never the home directory or drive root.")}
	}
	checks := []WindowsBYOCheck{windowsBYOCheck("project.boundary", windowsBYOPass, "PROJECT_SCOPE_PINNED", true, root, "")}
	tmp, writeErr := os.CreateTemp(root, ".yaver-write-probe-*")
	if writeErr != nil {
		checks = append(checks, windowsBYOCheck("project.writable", windowsBYOFail, "PROJECT_NOT_WRITABLE", true, writeErr.Error(), "Grant the signed Yaver agent write access to this checkout."))
	} else {
		probeName := tmp.Name()
		closeErr := tmp.Close()
		removeErr := os.Remove(probeName)
		if closeErr != nil || removeErr != nil {
			checks = append(checks, windowsBYOCheck("project.writable", windowsBYOFail, "PROJECT_WRITE_PROBE_CLEANUP_FAILED", true, "temporary probe could not be closed and removed cleanly", "Check antivirus/file-locking policy for the project directory."))
		} else {
			checks = append(checks, windowsBYOCheck("project.writable", windowsBYOPass, "PROJECT_WRITE_PROVEN", true, "create/close/remove probe passed", ""))
		}
	}
	git := DiscoverBinary("git")
	if git == "" {
		checks = append(checks, windowsBYOCheck("project.git-root", windowsBYOFail, "GIT_MISSING", true, "git was not discovered", "Install Git for Windows and rerun the doctor."))
		return root, checks
	}
	out, commandErr := runWindowsBYOCommand(ctx, 5*time.Second, git, "-C", root, "rev-parse", "--show-toplevel")
	gitRoot := strings.TrimSpace(out)
	if commandErr != nil || !samePath(root, gitRoot) {
		detail := strings.TrimSpace(out)
		if detail == "" && commandErr != nil {
			detail = commandErr.Error()
		}
		checks = append(checks, windowsBYOCheck("project.git-root", windowsBYOFail, "GIT_ROOT_MISMATCH", true, detail, "Select the repository top-level directory, not a parent or nested folder."))
		return root, checks
	}
	checks = append(checks, windowsBYOCheck("project.git-root", windowsBYOPass, "GIT_ROOT_EXACT", true, gitRoot, ""))
	remote, remoteErr := runWindowsBYOCommand(ctx, 5*time.Second, git, "-C", root, "remote", "get-url", "origin")
	if remoteErr != nil {
		checks = append(checks, windowsBYOCheck("project.git-origin", windowsBYOWarn, "GIT_ORIGIN_UNAVAILABLE", false, strings.TrimSpace(remote), "Add or verify the intended origin before tomorrow's push test."))
	} else {
		checks = append(checks, windowsBYOCheck("project.git-origin", windowsBYOPass, "GIT_ORIGIN_SANITIZED", false, sanitizeRepoURL(strings.TrimSpace(remote)), ""))
	}
	return root, checks
}

func windowsBYOToolChecks(ctx context.Context, runner string) []WindowsBYOCheck {
	type tool struct {
		id, name string
		args     []string
		required bool
		remedy   string
	}
	tools := []tool{
		{"tool.git", "git", []string{"--version"}, true, "Install Git for Windows."},
		{"tool.node", "node", []string{"--version"}, true, "Install a supported native Windows Node.js release."},
		{"tool.npm", "npm", []string{"--version"}, true, "Install npm with Node.js and ensure %APPDATA%\\npm is available."},
		{"tool.ffmpeg", "ffmpeg", []string{"-version"}, true, "Install an FFmpeg build with gdigrab and libx264."},
		{"tool.runner", runner, []string{"--version"}, true, "Install and locally sign in to the selected coding runner."},
	}
	checks := make([]WindowsBYOCheck, 0, len(tools)+1)
	for _, item := range tools {
		path := DiscoverBinary(item.name)
		if path == "" && item.id == "tool.runner" {
			path = resolveRunnerBinary(item.name)
		}
		if path == "" {
			checks = append(checks, windowsBYOCheck(item.id, windowsBYOFail, "BINARY_MISSING", item.required, item.name+" was not found in PATH or known Windows install locations", item.remedy))
			continue
		}
		out, err := runWindowsBYOCommand(ctx, 10*time.Second, path, item.args...)
		version := firstLineRaw(strings.TrimSpace(out))
		if err != nil && version == "" {
			checks = append(checks, windowsBYOCheck(item.id, windowsBYOFail, "BINARY_NOT_CALLABLE", item.required, path+": "+err.Error(), item.remedy))
			continue
		}
		checks = append(checks, windowsBYOCheck(item.id, windowsBYOPass, "BINARY_OPERATION_PROVEN", item.required, path+" · "+version, ""))
	}
	browser := ""
	for _, candidate := range []string{"msedge", "chrome", "firefox"} {
		if found := DiscoverBinary(candidate); found != "" {
			browser = found
			break
		}
	}
	if browser == "" {
		checks = append(checks, windowsBYOCheck("tool.browser", windowsBYOFail, "BROWSER_MISSING", true, "Edge, Chrome, and Firefox were not discovered", "Install Edge or Chrome for browser preview and runner login."))
	} else {
		checks = append(checks, windowsBYOCheck("tool.browser", windowsBYOPass, "BROWSER_DISCOVERED", true, browser, ""))
	}
	return checks
}

func runWindowsBYOCommand(parent context.Context, timeout time.Duration, binary string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd, commandErr := newExecutableCommandContext(ctx, runtime.GOOS, binary, args...)
	if commandErr != nil {
		return "", commandErr
	}
	cmd.Env = append(os.Environ(), "PATH="+expandedPath())
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if len(text) > 1600 {
		text = text[:1600] + "…"
	}
	if ctx.Err() == context.DeadlineExceeded {
		return text, fmt.Errorf("probe timed out after %s", timeout)
	}
	return text, err
}

func runDoctorWindowsBYO(args []string) {
	fs := flag.NewFlagSet("doctor windows-byo", flag.ExitOnError)
	project := fs.String("project", "", "Exact native Windows repository directory (defaults to the current directory)")
	runner := fs.String("runner", "codex", "Runner CLI to prove (codex, claude, opencode, etc.)")
	live := fs.Bool("live", false, "Perform bounded desktop capture and H.264 operation probes")
	asJSON := fs.Bool("json", false, "Emit JSON")
	_ = fs.Parse(args)
	if strings.TrimSpace(*project) == "" {
		*project, _ = os.Getwd()
	}
	report := RunWindowsBYODoctor(context.Background(), WindowsBYODoctorOptions{ProjectRoot: *project, Runner: *runner, Live: *live})
	if *asJSON {
		data, _ := json.MarshalIndent(report, "", "  ")
		fmt.Println(string(data))
	} else {
		fmt.Printf("Windows BYO readiness: ready=%v platform=%s/%s project=%s runner=%s live=%v\n", report.Ready, report.Platform, report.Architecture, report.ProjectRoot, report.Runner, report.Live)
		for _, check := range report.Checks {
			fmt.Printf("  %-4s %-30s %-34s %s\n", strings.ToUpper(check.Status), check.ID, check.ReasonCode, check.Detail)
			if check.Remedy != "" && check.Status != windowsBYOPass {
				fmt.Printf("       remedy: %s\n", check.Remedy)
			}
		}
	}
	if !report.Ready {
		os.Exit(1)
	}
}

func (s *HTTPServer) handleDoctorWindowsBYO(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		jsonError(w, http.StatusMethodNotAllowed, "GET or POST only")
		return
	}
	opts := WindowsBYODoctorOptions{ProjectRoot: r.URL.Query().Get("project"), Runner: r.URL.Query().Get("runner")}
	if r.Method == http.MethodPost {
		r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
		if err := json.NewDecoder(r.Body).Decode(&opts); err != nil {
			jsonError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
	}
	// GET is inventory-only by design. Capture is an explicit POST operation.
	if r.Method == http.MethodGet {
		opts.Live = false
	}
	report := RunWindowsBYODoctor(r.Context(), opts)
	writeJSON(w, http.StatusOK, report)
}
