package main

// doctor_development.go — one bounded, structured development-readiness view
// for GUI surfaces. The old /agent/doctor only listed three runner binaries;
// it did not say whether they could authenticate, whether Git could clone, or
// whether the toolchain a normal web/mobile/cloud project needs could execute.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

type DoctorFix struct {
	Kind   string `json:"kind"` // install | configure | open-url
	Label  string `json:"label"`
	Method string `json:"method,omitempty"`
	Path   string `json:"path,omitempty"`
	Stream string `json:"stream,omitempty"`
	Tab    string `json:"tab,omitempty"`
	URL    string `json:"url,omitempty"`
}

type DoctorCheckResult struct {
	ID      string     `json:"id,omitempty"`
	Name    string     `json:"name"`
	Status  string     `json:"status"` // pass | warn | fail
	Detail  string     `json:"detail"`
	Section string     `json:"section"`
	Fix     *DoctorFix `json:"fix,omitempty"`
}

type developmentToolProbe struct {
	id, name, command, install string
	args                       []string
}

type developmentAuthProbe struct {
	id, name, command, url string
	args                   []string
}

var openCodeACPInstalled = func() bool { return acpRunnerInstalled("opencode") }

func developmentToolProbes() []developmentToolProbe {
	return developmentToolProbesFor(runtime.GOOS)
}

func developmentToolProbesFor(goos string) []developmentToolProbe {
	probes := []developmentToolProbe{
		{"git", "Git", "git", "git", []string{"--version"}},
		{"node", "Node.js", "node", "node", []string{"--version"}},
		{"npm", "npm", "npm", "node", []string{"--version"}},
		{"react-native", "React Native / Expo package runner", "npx", "mobile", []string{"--version"}},
		{"go", "Go", "go", "go", []string{"version"}},
		{"flutter", "Flutter", "flutter", "flutter", []string{"--version"}},
		{"java", "Java / Android build runtime", "java", "java", []string{"-version"}},
		{"android", "Android platform tools", "adb", "android-sdk", []string{"version"}},
		{"docker", "Docker engine", "docker", "docker", []string{"version", "--format", "{{.Client.Version}}"}},
		{"vercel", "Vercel CLI", "vercel", "vercel", []string{"--version"}},
		{"cloudflare", "Cloudflare Wrangler", "wrangler", "wrangler", []string{"--version"}},
		{"supabase", "Supabase CLI", "supabase", "supabase", []string{"--version"}},
		{"firebase", "Firebase CLI", "firebase", "firebase", []string{"--version"}},
		{"convex", "Convex CLI", "convex", "convex", []string{"--version"}},
		{"github", "GitHub CLI", "gh", "gh", []string{"--version"}},
		{"gitlab", "GitLab CLI", "glab", "glab", []string{"--version"}},
	}
	if goos == "darwin" {
		probes = append(probes,
			developmentToolProbe{"xcode", "Xcode", "xcodebuild", "", []string{"-version"}},
			developmentToolProbe{"codesign", "Apple code signing", "codesign", "", []string{"--version"}},
		)
	}
	if goos == "windows" {
		// PowerShell is the native Windows control lane; the Windows Go agent
		// must prove it can start it instead of merely assuming it exists.
		probes = append(probes,
			developmentToolProbe{"powershell", "PowerShell", "powershell.exe", "", []string{"-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"}},
			developmentToolProbe{"winget", "Windows Package Manager", "winget.exe", "", []string{"--version"}},
			developmentToolProbe{"wsl", "Windows Subsystem for Linux", "wsl.exe", "", []string{"--status"}},
		)
	}
	if goos == "linux" {
		probes = append(probes,
			developmentToolProbe{"shell", "POSIX shell", "sh", "", []string{"-c", "printf yaver-sh"}},
			developmentToolProbe{"systemd", "systemd user services", "systemctl", "", []string{"--version"}},
		)
	}
	return probes
}

func platformDoctorChecks() []DoctorCheckResult {
	return platformDoctorChecksFor(runtime.GOOS, runtime.GOARCH)
}

func platformDoctorChecksFor(goos, goarch string) []DoctorCheckResult {
	checks := []DoctorCheckResult{{
		ID:      "platform",
		Name:    "Host platform",
		Status:  "pass",
		Detail:  goos + "/" + goarch,
		Section: "platform",
	}}
	if goos != "darwin" && goos != "linux" && goos != "windows" {
		checks[0].Status = "fail"
		checks[0].Detail += " is not a supported Yaver desktop-agent platform"
	}
	return checks
}

func windowsToolURL(id string) string {
	urls := map[string]string{
		"git":          "https://git-scm.com/download/win",
		"node":         "https://nodejs.org/en/download",
		"npm":          "https://nodejs.org/en/download",
		"react-native": "https://reactnative.dev/docs/set-up-your-environment",
		"go":           "https://go.dev/dl/",
		"flutter":      "https://docs.flutter.dev/get-started/install/windows",
		"java":         "https://learn.microsoft.com/java/openjdk/download",
		"android":      "https://developer.android.com/studio",
		"docker":       "https://docs.docker.com/desktop/setup/install/windows-install/",
		"github":       "https://cli.github.com/",
		"gitlab":       "https://gitlab.com/gitlab-org/cli",
		"vercel":       "https://vercel.com/docs/cli",
		"cloudflare":   "https://developers.cloudflare.com/workers/wrangler/install-and-update/",
		"supabase":     "https://supabase.com/docs/guides/local-development/cli/getting-started",
		"firebase":     "https://firebase.google.com/docs/cli",
		"convex":       "https://docs.convex.dev/cli",
	}
	return urls[id]
}

func doctorFixForMissingTool(probe developmentToolProbe) *DoctorFix {
	return doctorFixForMissingToolFor(runtime.GOOS, probe)
}

func doctorFixForMissingToolFor(goos string, probe developmentToolProbe) *DoctorFix {
	if goos == "windows" {
		if url := windowsToolURL(probe.id); url != "" {
			return &DoctorFix{Kind: "open-url", Label: "Setup", URL: url}
		}
		return nil
	}
	if probe.install == "" {
		return nil
	}
	return &DoctorFix{Kind: "install", Label: "Install", Method: "POST", Path: "/install/" + probe.install, Stream: "install:" + probe.install}
}

func runDevelopmentToolProbe(parent context.Context, probe developmentToolProbe) DoctorCheckResult {
	check := DoctorCheckResult{ID: probe.id, Name: probe.name, Section: "development"}
	path := resolveSpawnPath(probe.command)
	if path == "" || path == probe.command {
		if resolved, err := lookPathWithRuntimes(probe.command); err == nil {
			path = resolved
		}
	}
	if path == "" {
		check.Status = "warn"
		check.Detail = probe.command + " is not installed"
		check.Fix = doctorFixForMissingTool(probe)
		return check
	}

	ctx, cancel := context.WithTimeout(parent, 2500*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, probe.args...)
	cmd.Env = append(os.Environ(), "CI=1", "YAVER_NONINTERACTIVE=1", "YAVER_VAULT_SKIP_KEYCHAIN=1", "NO_COLOR=1")
	out, err := cmd.CombinedOutput()
	line := strings.TrimSpace(strings.Split(string(out), "\n")[0])
	if len(line) > 100 {
		line = line[:100]
	}
	if ctx.Err() == context.DeadlineExceeded {
		check.Status = "fail"
		check.Detail = fmt.Sprintf("%s exists at %s but its version probe timed out", probe.command, path)
		return check
	}
	if err != nil {
		check.Status = "fail"
		check.Detail = fmt.Sprintf("%s exists at %s but cannot execute: %v", probe.command, path, err)
		return check
	}
	check.Status = "pass"
	check.Detail = path
	if line != "" {
		check.Detail += " · " + line
	}
	return check
}

func developmentAuthProbes() []developmentAuthProbe {
	return []developmentAuthProbe{
		{"github-auth", "GitHub authentication", "gh", "https://github.com/login/device", []string{"auth", "status"}},
		{"gitlab-auth", "GitLab authentication", "glab", "https://gitlab.com/-/user_settings/personal_access_tokens", []string{"auth", "status"}},
		{"npm-auth", "npm authentication", "npm", "https://www.npmjs.com/settings/~/tokens", []string{"whoami"}},
		{"vercel-auth", "Vercel authentication", "vercel", "https://vercel.com/account/tokens", []string{"whoami"}},
		{"cloudflare-auth", "Cloudflare authentication", "wrangler", "https://dash.cloudflare.com/profile/api-tokens", []string{"whoami"}},
		{"supabase-auth", "Supabase authentication", "supabase", "https://supabase.com/dashboard/account/tokens", []string{"projects", "list", "--output", "json"}},
		{"firebase-auth", "Firebase authentication", "firebase", "https://console.firebase.google.com/", []string{"login:list", "--json"}},
	}
}

func runDevelopmentAuthProbe(parent context.Context, probe developmentAuthProbe) (DoctorCheckResult, bool) {
	check := DoctorCheckResult{ID: probe.id, Name: probe.name, Section: "provider-auth"}
	path, err := lookPathWithRuntimes(probe.command)
	if err != nil || strings.TrimSpace(path) == "" {
		return check, false // the tool check already carries the install route
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, probe.args...)
	cmd.Env = append(os.Environ(), "CI=1", "YAVER_NONINTERACTIVE=1", "YAVER_VAULT_SKIP_KEYCHAIN=1", "NO_COLOR=1")
	if err := cmd.Run(); err != nil {
		check.Status = "warn"
		if ctx.Err() == context.DeadlineExceeded {
			check.Detail = "authentication probe timed out; no interactive prompt was opened"
		} else {
			check.Detail = "not authenticated or the provider rejected the identity probe"
		}
		if probe.command == "gh" || probe.command == "glab" {
			check.Fix = &DoctorFix{Kind: "configure", Label: "Connect", Tab: "tools"}
		} else {
			check.Fix = &DoctorFix{Kind: "open-url", Label: "Configure", URL: probe.url}
		}
		return check, true
	}
	check.Status = "pass"
	check.Detail = "authenticated (provider operation probe passed)"
	return check, true
}

func buildDevelopmentAuthChecks(ctx context.Context) []DoctorCheckResult {
	probes := developmentAuthProbes()
	checks := make([]DoctorCheckResult, len(probes))
	present := make([]bool, len(probes))
	done := make(chan int, len(probes))
	for i := range probes {
		go func(index int) {
			checks[index], present[index] = runDevelopmentAuthProbe(ctx, probes[index])
			done <- index
		}(i)
	}
	for range probes {
		<-done
	}
	out := make([]DoctorCheckResult, 0, len(checks))
	for i := range checks {
		if present[i] {
			out = append(out, checks[i])
		}
	}
	return out
}

func (s *HTTPServer) buildDevelopmentDoctorChecks(ctx context.Context) []DoctorCheckResult {
	checks := platformDoctorChecks()
	runnerAudit := s.buildYaverAgentDeviceAudit("")
	for _, runner := range runnerAudit.Runners {
		check := DoctorCheckResult{ID: runner.ID, Name: runner.Name, Section: "runners"}
		switch {
		case !runner.Installed:
			check.Status = "warn"
			check.Detail = "not installed"
			if runtime.GOOS == "windows" {
				check.Fix = &DoctorFix{Kind: "configure", Label: "Setup", Tab: "tools"}
			} else {
				check.Fix = &DoctorFix{Kind: "install", Label: "Install", Method: "POST", Path: "/install/" + runner.ID, Stream: "install:" + runner.ID}
			}
		case runner.Ready && runner.AuthConfigured:
			check.Status = "pass"
			check.Detail = "ready"
			if runner.AuthSource != "" {
				check.Detail += " · " + runner.AuthSource
			}
		default:
			check.Status = "fail"
			check.Detail = firstNonEmpty(runner.Error, runner.Warning, "installed but provider/API key or subscription sign-in is not ready")
			check.Fix = &DoctorFix{Kind: "configure", Label: "Configure", Tab: "tools"}
		}
		checks = append(checks, check)
	}
	checks = append(checks, probeOpenCodeACPTransport(ctx, s.taskMgr.workDir))
	checks = append(checks, buildDevelopmentToolChecks(ctx)...)
	checks = append(checks, buildDevelopmentAuthChecks(ctx)...)
	for _, provider := range collectMachineOnboardingStatus().Providers {
		status := machineOnboardingDoctorLevel(provider)
		check := DoctorCheckResult{ID: provider.ID, Name: provider.Name, Status: status, Detail: machineOnboardingDoctorDetail(provider), Section: "onboarding"}
		if status != "pass" {
			check.Fix = &DoctorFix{Kind: "configure", Label: "Connect", Tab: "tools"}
		}
		checks = append(checks, check)
	}
	return checks
}

// probeOpenCodeACPTransport proves the operation the native task lane needs:
// initialize plus session/new. A version string is only inventory; OpenCode
// can exist on PATH while its ACP subprocess or wire contract is unusable.
func probeOpenCodeACPTransport(parent context.Context, workDir string) DoctorCheckResult {
	check := DoctorCheckResult{
		ID: "opencode-acp", Name: "OpenCode native ACP", Section: "runners",
	}
	check.Fix = &DoctorFix{Kind: "install", Label: "Repair OpenCode", Method: "POST", Path: "/install/opencode", Stream: "install:opencode"}
	if !openCodeACPInstalled() {
		check.Status = "warn"
		check.Detail = "OpenCode is not installed; tasks will use another selected runner"
		return check
	}
	if strings.TrimSpace(workDir) == "" {
		workDir = "."
	}
	ctx, cancel := context.WithTimeout(parent, 12*time.Second)
	defer cancel()
	client, err := newACPTaskClient("opencode", workDir, acpClientOptions{})
	if err != nil {
		check.Status = "warn"
		check.Detail = "native ACP could not start; OpenCode tasks will fall back to CLI/PTY: " + err.Error()
		return check
	}
	defer client.Close()
	initialized, err := client.Initialize(ctx)
	if err != nil {
		check.Status = "warn"
		check.Detail = "native ACP initialize failed; OpenCode tasks will fall back to CLI/PTY: " + err.Error()
		return check
	}
	sessionID, _, err := client.NewSession(ctx, workDir, []acpMCPServer{})
	if err != nil {
		check.Status = "warn"
		check.Detail = "native ACP session/new failed; OpenCode tasks will fall back to CLI/PTY: " + err.Error()
		return check
	}
	closeCtx, closeCancel := context.WithTimeout(context.Background(), 2*time.Second)
	_ = client.CloseSession(closeCtx, sessionID)
	closeCancel()
	check.Status = "pass"
	check.Detail = "initialize + session/new passed"
	if initialized != nil && initialized.AgentInfo.Version != "" {
		check.Detail += " · " + initialized.AgentInfo.Version
	}
	check.Fix = nil
	return check
}

func buildDevelopmentToolChecks(ctx context.Context) []DoctorCheckResult {
	probes := developmentToolProbes()
	// Preserve the stable UI order while running probes concurrently. A dozen
	// independent 2.5 s probes must cost ~2.5 s, not half a minute.
	checks := make([]DoctorCheckResult, len(probes))
	done := make(chan int, len(probes))
	for i := range probes {
		go func(index int) {
			checks[index] = runDevelopmentToolProbe(ctx, probes[index])
			done <- index
		}(i)
	}
	for range probes {
		<-done
	}
	return checks
}
