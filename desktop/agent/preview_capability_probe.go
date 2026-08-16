package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os/exec"
	"strings"
	"time"
)

// preview_capability_probe.go — can this workspace ACTUALLY stream a preview?
//
// ─── Why a probe and not a config check ─────────────────────────────────────
//
// This session produced eight failures, and every single one was the same
// shape: something declared present that could not perform:
//
//	cx32/cx42/cx52/gex44   configured default SKUs that DO NOT EXIST
//	tagged-cleanup         declared capability whose impl returned []
//	managed=true           orphan sweep filtering on a label nothing wrote
//	cax11                  relay SKU sold out in every EU datacenter
//	chromium-browser       installs a SNAP STUB that cannot launch
//	swift:6.3-jammy        a tag that can never match its own SDK
//	Tokamak                a framework abandoned three years ago
//	hermes-push            a named transport that no longer exists
//
// Not one would have been caught by asking "is it configured?". Every one was
// caught by attempting the operation. So this file never reads a flag, an env
// var, or a capability list — it runs the thing and reports what happened.
//
// The output is deliberately shaped for a UI: every surface (web, mobile,
// tablet, AR/VR, car, watch) can render the same struct, and a user on a watch
// gets the same diagnosis as one on a desktop. A capability only the CLI can
// see does not exist for a user on their phone.

// ProbeResult is one capability, probed.
type ProbeResult struct {
	Name string `json:"name"`
	OK   bool   `json:"ok"`
	// Detail is what was OBSERVED, not what was expected. On failure it names
	// the remedy: "install X" beats "X unavailable", and the difference is
	// measured in whole debugging sessions.
	Detail string `json:"detail"`
	// Blocking marks a capability without which the preview cannot work at all,
	// so a UI can distinguish "degraded" from "impossible".
	Blocking bool          `json:"blocking"`
	Took     time.Duration `json:"-"`
	TookMs   int64         `json:"tookMs"`
}

// PreviewCapabilityReport is the whole answer, renderable on every surface.
type PreviewCapabilityReport struct {
	Strategy PreviewStrategy `json:"strategy"`
	CanRun   bool            `json:"canRun"`
	// Summary is one sentence a WATCH can display. If it does not fit on a
	// watch it is too long for anyone.
	Summary string        `json:"summary"`
	Probes  []ProbeResult `json:"probes"`
	// Remedy is the single most useful next action, or "" when healthy.
	Remedy string `json:"remedy"`
}

// ProbePreviewCapability attempts every operation the strategy depends on.
//
// Bounded by ctx: a diagnosis that hangs is worse than one that says "unknown",
// because the user cannot tell it apart from the thing they are diagnosing.
func ProbePreviewCapability(ctx context.Context, strategy PreviewStrategy, workDir string) PreviewCapabilityReport {
	report := PreviewCapabilityReport{Strategy: strategy}

	switch strategy {
	case PreviewChromeWebRTC:
		report.Probes = append(report.Probes,
			probeBrowserLaunches(ctx),
			probeDevServerReachable(ctx, 8080),
		)
	case PreviewHermesBundle:
		report.Probes = append(report.Probes, probeNodeToolchain(ctx))
	case PreviewRedroidWebRTC:
		report.Probes = append(report.Probes, probeContainerRuntime(ctx))
	case PreviewUnsupported, PreviewIOSSimulator:
		report.CanRun = false
		report.Summary = "Not available on this workspace"
		report.Remedy = "iOS previews need a Mac host; Linux workspaces cannot run a simulator"
		return report
	}

	// Swift adds a toolchain probe on top of whatever the strategy needs.
	if workDir != "" {
		if det := DetectSwiftProject(workDir); det.Kind == SwiftKindTokamak {
			report.Probes = append(report.Probes, probeSwiftWasmToolchain(ctx))
		}
	}

	blockingFailure := ""
	for _, p := range report.Probes {
		if !p.OK && p.Blocking && blockingFailure == "" {
			blockingFailure = p.Detail
		}
	}
	report.CanRun = blockingFailure == ""
	if report.CanRun {
		report.Summary = "Preview ready"
	} else {
		report.Summary = "Preview unavailable"
		report.Remedy = blockingFailure
	}
	return report
}

// probeBrowserLaunches actually STARTS the browser.
//
// ─── The false RED this used to produce ────────────────────────────────────
//
// The previous version searched `chromium` first and RETURNED on the first
// candidate that failed. Measured on the owner's ubuntu-4gb box, 2026-08-03:
//
//	chromium              /snap/bin/chromium         exit=1  (confined snap)
//	chromium-browser      /usr/bin/chromium-browser  exit=1  (snap redirector)
//	google-chrome         /usr/bin/google-chrome     exit=0  Chrome 150
//
// It stopped at line 1 and reported "Stream over WebRTC — not supported",
// with a remedy telling the user to install a chromium deb. A perfectly good
// Google Chrome was sitting on the same box, already installed, already
// working. The product told the user their machine could not do something it
// could do, and pointed them at an install they did not need.
//
// That is the mirror image of the bug this file's header is about: not "the
// inventory says yes while the operation says no", but "one operation said no,
// so we never asked the others". A search that abandons after the first
// failure is not a probe, it is a guess with extra steps.
//
// It now shares resolveLaunchableChrome with the capture path (browser.go), so
// the capability report and the thing it reports ON can never disagree about
// which browser this box has — and the detail names every candidate tried.
func probeBrowserLaunches(ctx context.Context) ProbeResult {
	start := time.Now()
	r := ProbeResult{Name: "browser", Blocking: true}

	path, attempts := resolveLaunchableChrome(ctx)
	for _, a := range attempts {
		if a.OK {
			r.OK = true
			r.Detail = fmt.Sprintf("%s — %s", a.Path, a.Detail)
			r.Took = time.Since(start)
			r.TookMs = r.Took.Milliseconds()
			return r
		}
	}

	if len(attempts) == 0 {
		r.Detail = "no browser found — chrome-webrtc previews need Chrome or Chromium installed in the workspace image. " +
			"Install one with `apt-get install -y google-chrome-stable`."
	} else {
		// Every candidate was RUN and every one failed. Report all of them:
		// "chromium is broken" sends a user to reinstall chromium, while the
		// full list shows the shape of the problem (all confined snaps → the
		// box needs an unconfined build).
		r.Detail = fmt.Sprintf("no Chrome on this box could be launched. %s", chromeAttemptsSummary(attempts))
		if path != "" {
			r.Detail += fmt.Sprintf(" (best candidate was %s)", path)
		}
	}
	r.Took = time.Since(start)
	r.TookMs = r.Took.Milliseconds()
	return r
}

// probeDevServerReachable opens a real TCP connection.
//
// Non-blocking: the dev server may legitimately not be running yet. Reported so
// a UI can say "starting" rather than "broken".
func probeDevServerReachable(ctx context.Context, port int) ProbeResult {
	start := time.Now()
	r := ProbeResult{Name: "dev-server", Blocking: false}
	d := net.Dialer{Timeout: 2 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		r.Detail = fmt.Sprintf("nothing listening on :%d yet (normal before the dev server starts)", port)
	} else {
		_ = conn.Close()
		r.OK = true
		r.Detail = fmt.Sprintf("serving on :%d", port)
	}
	r.Took = time.Since(start)
	r.TookMs = r.Took.Milliseconds()
	return r
}

// probeSwiftWasmToolchain runs the compiler and asks the SDK list directly.
//
// This is the probe that would have caught the version-mismatch bug: `swift sdk
// list` succeeding proves an SDK is INSTALLED, which is not the same as it
// being COMPATIBLE. So the detail carries both versions and lets a human see
// the mismatch rather than hiding it behind a boolean.
func probeSwiftWasmToolchain(ctx context.Context) ProbeResult {
	start := time.Now()
	r := ProbeResult{Name: "swiftwasm", Blocking: true}
	defer func() { r.Took = time.Since(start); r.TookMs = r.Took.Milliseconds() }()

	swiftPath, err := exec.LookPath("swift")
	if err != nil {
		r.Detail = "swift not found — SwiftWasm previews need the Swift toolchain baked into the workspace image"
		return r
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	verOut, _ := exec.CommandContext(cctx, swiftPath, "--version").CombinedOutput()
	compiler := probeFirstLine(string(verOut))

	sdkOut, sdkErr := exec.CommandContext(cctx, swiftPath, "sdk", "list").CombinedOutput()
	sdks := strings.TrimSpace(string(sdkOut))
	if sdkErr != nil || sdks == "" || strings.Contains(sdks, "No Swift SDKs") {
		r.Detail = fmt.Sprintf("%s is present but NO wasm SDK is installed — "+
			"run `swift sdk install <artifactbundle> --checksum <sum>`", compiler)
		return r
	}
	if !strings.Contains(sdks, "wasm32") {
		r.Detail = fmt.Sprintf("%s has SDKs installed but none target wasm32: %s", compiler, sdks)
		return r
	}
	r.OK = true
	// Both versions, deliberately: an exact mismatch between them is the silent
	// failure that cost this session two builds, and a boolean would hide it.
	r.Detail = fmt.Sprintf("%s; wasm SDK: %s", compiler, strings.ReplaceAll(sdks, "\n", ", "))
	return r
}

func probeNodeToolchain(ctx context.Context) ProbeResult {
	start := time.Now()
	r := ProbeResult{Name: "node", Blocking: true}
	path, err := exec.LookPath("node")
	if err != nil {
		r.Detail = "node not found — Hermes bundle builds need it"
	} else {
		cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
		out, e := exec.CommandContext(cctx, path, "--version").CombinedOutput()
		cancel()
		if e != nil {
			r.Detail = fmt.Sprintf("node is on PATH but failed to run: %v", e)
		} else {
			r.OK = true
			r.Detail = "node " + strings.TrimSpace(string(out))
		}
	}
	r.Took = time.Since(start)
	r.TookMs = r.Took.Milliseconds()
	return r
}

func probeContainerRuntime(ctx context.Context) ProbeResult {
	start := time.Now()
	r := ProbeResult{Name: "container-runtime", Blocking: true}
	path, err := exec.LookPath("docker")
	if err != nil {
		r.Detail = "docker not found — Redroid previews run Android in a container"
	} else {
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		// `info` not `--version`: the CLI can be installed while the DAEMON is
		// down, and only the daemon can actually run anything.
		out, e := exec.CommandContext(cctx, path, "info", "--format", "{{.ServerVersion}}").CombinedOutput()
		cancel()
		if e != nil {
			r.Detail = "docker CLI is present but the daemon is not responding — Redroid cannot start"
		} else {
			r.OK = true
			r.Detail = "docker daemon " + strings.TrimSpace(string(out))
		}
	}
	r.Took = time.Since(start)
	r.TookMs = r.Took.Milliseconds()
	return r
}

// probeFirstLine is local to avoid colliding with runner_agent_session.go's
// firstLine — same idea, different package-level owner.
func probeFirstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

// JSON renders the report for every client surface.
//
// ONE payload for web, mobile, tablet, AR/VR, car and watch — cross-surface
// parity is a rule here, and a diagnosis only the CLI can see does not exist
// for a user on their phone. `Summary` is watch-length by construction.
func (r PreviewCapabilityReport) JSON() ([]byte, error) { return json.Marshal(r) }
