package main

// ops_mobile_test_open.go — the "open the Yaver mobile app for testing" verb.
//
// WHY (2026-08-09, user call): an agent (Claude/Codex/opencode via MCP) that
// wants to test the mobile app needs a one-call verb, not a four-step recipe
// ("cd mobile && npm run web, then launch e2e/open-mobile-app.mjs with a
// profile, then…"). The repo already has two PROVEN scripts for the two
// legitimately different jobs:
//
//   - e2e/open-mobile-app.mjs      — HEADED Chromium at a REAL mobile viewport
//     (iPhone 13, touch enabled, persistent profile) so a HUMAN signs in by
//     hand and tests. Never substitute a narrowed desktop Chrome window for
//     this (AGENTS.md viewport rule).
//   - e2e/verify_live_console.mjs  — HEADLESS assertion: opens the task detail
//     and checks the LiveConsoleSection rendered the streamed opencode console.
//
// The verb picks by `mode`: "open" (default, human-in-the-loop headed window)
// or "verify" (headless closed-loop assertion). It resolves the repo root
// (work-dir of the agent), ensures Metro is up, and execs the right script.
// This is the MCP/ops twin of the documented manual procedure in
// AGENTS.md/CLAUDE.md ("Opening the mobile app for a HUMAN to test").

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func init() {
	registerOpsVerb(opsVerbSpec{
		Name: "mobile-test-open",
		Description: "Open the Yaver mobile app (RN-web) for testing at a REAL mobile viewport. " +
			"mode=open (default) launches a headed Chromium window at iPhone 13 viewport with touch + a persistent " +
			"profile so a human can sign in and test; mode=verify runs the headless closed-loop assertion that the " +
			"task-detail LiveConsoleSection rendered the streamed opencode console. Never substitute a narrowed " +
			"desktop Chrome window for the mobile app — RN-web renders a different component tree without the device " +
			"context (AGENTS.md viewport rule).",
		Schema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"mode": map[string]interface{}{
					"type": "string", "enum": []string{"open", "verify"},
					"description": "open = headed window for a human (default). verify = headless closed-loop assertion.",
				},
				"profile": map[string]interface{}{
					"type":        "string",
					"description": "Persistent profile name/path for mode=open. Default ~/.yaver-e2e-profile; use a fresh one when the default is locked by another Chromium instance.",
				},
				"url": map[string]interface{}{
					"type":        "string",
					"description": "Mobile web URL. Default http://localhost:8081 (Metro).",
				},
				"timeout_sec": map[string]interface{}{
					"type":        "integer",
					"description": "Max seconds to wait (verify mode, and Metro start in open mode). Default 180.",
				},
			},
			"additionalProperties": false,
		},
		Handler:    opsMobileTestOpenHandler,
		Streaming:  false,
		AllowGuest: false,
	})
}

type mobileTestOpenRequest struct {
	Mode      string `json:"mode"`
	Profile   string `json:"profile"`
	URL       string `json:"url"`
	TimeoutSec int   `json:"timeout_sec"`
}

func opsMobileTestOpenHandler(c OpsContext, payload json.RawMessage) OpsResult {
	var req mobileTestOpenRequest
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &req); err != nil {
			return OpsResult{OK: false, Code: "bad_payload", Error: "mobile-test-open payload: " + err.Error()}
		}
	}
	mode := req.Mode
	if mode == "" {
		mode = "open"
	}
	if mode != "open" && mode != "verify" {
		return OpsResult{OK: false, Code: "bad_payload", Error: fmt.Sprintf("mode must be 'open' or 'verify', got %q", mode)}
	}
	timeout := time.Duration(req.TimeoutSec) * time.Second
	if req.TimeoutSec <= 0 {
		timeout = 180 * time.Second
	}

	// Repo root = the agent's work dir. The e2e scripts live in <repo>/e2e.
	repoRoot := ""
	if c.Server != nil && c.Server.taskMgr != nil {
		repoRoot = c.Server.taskMgr.workDir
	}
	if repoRoot == "" {
		// Fall back to the process CWD if the server context lacks a work dir.
		if wd, err := os.Getwd(); err == nil {
			repoRoot = wd
		}
	}
	e2eDir := filepath.Join(repoRoot, "e2e")
	if info, err := os.Stat(filepath.Join(e2eDir, "open-mobile-app.mjs")); err != nil || info.IsDir() {
		return OpsResult{OK: false, Code: "not_found",
			Error: fmt.Sprintf("e2e/open-mobile-app.mjs not found under %q — is the work-dir the yaver repo root?", repoRoot)}
	}

	// nodePath: prefer the agent runtime node, then system node. The
	// managed runtime lives at ~/.yaver/runtimes/node/bin/node; the
	// testkit resolves it the same way (detectManagedOrSystemNode).
	node := ""
	if n, err := exec.LookPath("node"); err == nil {
		node = n
	} else if home, herr := os.UserHomeDir(); herr == nil {
		candidate := filepath.Join(home, ".yaver", "runtimes", "node", "bin", "node")
		if info, serr := os.Stat(candidate); serr == nil && !info.IsDir() {
			node = candidate
		}
	}
	if node == "" {
		return OpsResult{OK: false, Code: "unavailable", Error: "node not found on PATH or ~/.yaver/runtimes/node/bin"}
	}

	url := req.URL
	if url == "" {
		url = "http://localhost:8081"
	}

	// Metro must be up before either mode runs. Probe it; if it is not
	// answering, start `cd mobile && npm run web` (expo start --web) and wait.
	if !httpReady(url, 2*time.Second) {
		started, err := ensureMetroWeb(repoRoot, timeout)
		if err != nil {
			return OpsResult{OK: false, Code: "metro_start_failed",
				Error: fmt.Sprintf("Metro not serving %s and could not be started: %v", url, err)}
		}
		if started {
			// Give the first bundle a moment after the server answers.
			time.Sleep(3 * time.Second)
		}
	}

	switch mode {
	case "open":
		profile := req.Profile
		if profile == "" {
			profile = filepath.Join(os.Getenv("HOME"), ".yaver-e2e-profile")
		}
		cmd := exec.Command(node, filepath.Join(e2eDir, "open-mobile-app.mjs"))
		cmd.Env = append(os.Environ(), "MOBILE_WEB_URL="+url, "E2E_PROFILE="+profile)
		if err := cmd.Start(); err != nil {
			return OpsResult{OK: false, Code: "spawn_failed", Error: fmt.Sprintf("launch open-mobile-app.mjs: %v", err)}
		}
		return OpsResult{OK: true, Initial: map[string]interface{}{
			"mode":    "open",
			"pid":     cmd.Process.Pid,
			"profile": profile,
			"url":     url,
			"note":    "Headed Chromium at iPhone 13 viewport (touch enabled, persistent profile). Sign in by hand; the session persists for later runs. Leave it open and run mobile-test-open mode=verify to assert the LiveConsoleSection.",
		}}
	default: // verify
		cmd := exec.Command(node, filepath.Join(e2eDir, "verify_live_console.mjs"))
		cmd.Env = append(os.Environ(), "MOBILE_WEB_URL="+url)
		ctx, cancel := context.WithTimeout(context.Background(), timeout+30*time.Second)
		defer cancel()
		cmd = exec.CommandContext(ctx, node, filepath.Join(e2eDir, "verify_live_console.mjs"))
		cmd.Env = append(os.Environ(), "MOBILE_WEB_URL="+url)
		out, err := cmd.CombinedOutput()
		tail := string(out)
		if len(tail) > 4000 {
			tail = tail[len(tail)-4000:]
		}
		if err != nil {
			return OpsResult{OK: false, Code: "verify_failed",
				Error:  fmt.Sprintf("verify_live_console.mjs failed: %v", err),
				Initial: map[string]interface{}{"output": tail}}
		}
		return OpsResult{OK: true, Initial: map[string]interface{}{
			"mode":   "verify",
			"result": "ALL PASS — task detail rendered the LiveConsoleSection with the streamed opencode console",
			"output": tail,
		}}
	}
}

// httpReady probes a URL until it answers or the timeout elapses.
func httpReady(u string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(u)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode < 500 {
				return true
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

// ensureMetroWeb starts `npm run web` (expo start --web) in <repo>/mobile and
// waits until the URL answers. Returns true when it had to start Metro.
func ensureMetroWeb(repoRoot string, wait time.Duration) (bool, error) {
	mobileDir := filepath.Join(repoRoot, "mobile")
	if info, err := os.Stat(filepath.Join(mobileDir, "package.json")); err != nil || info.IsDir() {
		return false, fmt.Errorf("mobile/package.json not found under %q", repoRoot)
	}
	cmd := exec.Command("npm", "run", "web")
	cmd.Dir = mobileDir
	cmd.Env = append(os.Environ(), "CI=1")
	if err := cmd.Start(); err != nil {
		return false, err
	}
	// Let expo boot; poll the URL up to `wait`.
	deadline := time.Now().Add(wait)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get("http://localhost:8081")
		if err == nil {
			resp.Body.Close()
			return true, nil
		}
		time.Sleep(1 * time.Second)
	}
	// Process may still be warming up; don't kill it — report and let the
	// caller's retry or the human decide.
	return true, fmt.Errorf("Metro did not answer :8081 within %v (still starting?)", wait)
}

// Keep strings imported for the trim helper even if unused later.
var _ = strings.TrimSpace
