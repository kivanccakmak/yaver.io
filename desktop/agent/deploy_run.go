package main

// deploy_run.go — POST /deploy/ship: execute the vault-aware deploy
// script for an (app, target) on the host, streaming stdout + stderr
// to the caller via SSE. Named "ship" to disambiguate from the older
// /deploy/run release-pipeline endpoint in deploy_pipeline.go.
// The route is owner-only and runs against the owner's machine.
//
// Security envelope:
//
//  - Script body is generated server-side from vetted templates.
//    The JSON body cannot inject shell; callers only pick vetted
//    app/target values.
//  - Vault values are injected into the subprocess env; they never
//    appear in the script source or in any response.
//    Only stdout/stderr stream back, and the templates reference
//    vault secrets via $VAR expansions — their plaintext doesn't
//    land in a log line unless a user explicitly echoes it.
//  - Stack/path overrides are resolved and validated by the server.
//  - Runs are time-bounded; default 20 min, configurable via the
//    body's `timeout_sec` (capped at 60 min).
//
// Composite targets: POST body may carry `targets: [...]` (plural)
// for a server-side fan-out. All targets run in parallel behind a
// single SSE stream, each event tagged with its `target`. Preflight
// runs upfront for every target; if any fails we 409 before the
// stream opens. Each target still counts against the concurrency
// limiter, still gets its own DeployRun entry, and still fires the
// completion webhook independently.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// deployShipDefaultTimeoutSec is how long a single /deploy/ship can
// live without an explicit override.
const (
	deployShipDefaultTimeoutSec = 20 * 60
	deployShipMaxTimeoutSec     = 60 * 60
)

type deployShipRequest struct {
	App        string   `json:"app"`
	Target     string   `json:"target,omitempty"`  // single — legacy / simple path
	Targets    []string `json:"targets,omitempty"` // composite — if non-empty, Target is ignored
	Stack      string   `json:"stack,omitempty"`   // owner-only
	Path       string   `json:"path,omitempty"`    // owner-only
	TimeoutSec int      `json:"timeout_sec,omitempty"`
}

// targetPlan bundles everything prepared for one target before we
// open the SSE stream. Pre-computed on the main goroutine so that a
// preflight-or-tempfile failure still lets us 409 cleanly.
type targetPlan struct {
	target     string
	stack      string
	path       string
	script     string
	scriptPath string
	historyID  string
	historyRun *DeployRun
}

// handleDeployShip streams a /deploy/ship run as SSE.
//
// Body (single): {app, target, stack?, path?, timeout_sec?}
// Body (composite): {app, targets: [...], stack?, path?, timeout_sec?}
//
// Response stream events:
//
//	event: meta       — { id, app, target, stack, path, started_at, timeout_s }
//	event: line       — { id, target, stream: "stdout"|"stderr", text: "..." }
//	event: exit       — { id, target, code, duration_ms, ok, error_class, timed_out }
//	event: error      — { target?, error: "..." }
//	event: composite  — (composite only) { summary: [{target, id, ok, code, error_class}, ...] }
//
// Single-target callers can ignore the composite event and the
// target field.
func (s *HTTPServer) handleDeployShip(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonReply(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}

	var body deployShipRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	body.App = strings.TrimSpace(body.App)

	// Resolve the target list: explicit Targets wins; else fall back
	// to Target; else error. Dedup + trim so `targets:["x","x"]` or
	// whitespace doesn't get us to spawn two of the same thing.
	targets := normaliseTargetList(body.Targets, body.Target)
	if body.App == "" || len(targets) == 0 {
		jsonReply(w, http.StatusBadRequest, map[string]string{
			"error": "app and (target OR targets) are required",
		})
		return
	}

	// Every target in a composite counts
	// individually, because each spawns its own bash + xcodebuild.
	// Acquire all up front; roll back if any fails so we never leak
	// a half-acquired state.
	limiter := s.ensureDeployLimiter()
	limiterKey := "owner"
	maxInFlight := deployShipMaxInFlight
	acquired := 0
	for i := 0; i < len(targets); i++ {
		if !limiter.tryAcquire(limiterKey, maxInFlight) {
			for j := 0; j < acquired; j++ {
				limiter.release(limiterKey)
			}
			jsonReply(w, http.StatusTooManyRequests, map[string]interface{}{
				"error": "deploy concurrency cap reached — wait for an in-flight run to finish",
				"cap":   maxInFlight,
			})
			return
		}
		acquired++
	}
	defer func() {
		for j := 0; j < acquired; j++ {
			limiter.release(limiterKey)
		}
	}()

	// Resolve stack + path (shared across all targets of the same app).
	stack, path, err := resolveDeployStackPath(body.App, body.Stack, body.Path)
	if err != nil {
		jsonReply(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	// Preflight + script generation for every target. If any fails we
	// 409 BEFORE opening the SSE stream — the whole composite is
	// rejected atomically, nothing runs partially.
	plans := make([]*targetPlan, 0, len(targets))
	cleanupPlans := func() {
		for _, p := range plans {
			if p != nil && p.scriptPath != "" {
				_ = os.Remove(p.scriptPath)
			}
		}
	}
	for _, tgt := range targets {
		// Preflight — refuse to spawn if the toolchain is broken.
		preflight, perr := RunBuildDoctor(tgt, body.App, s.vaultStore)
		if perr == nil && !preflight.OK {
			cleanupPlans()
			jsonReply(w, http.StatusConflict, map[string]interface{}{
				"error":  "preflight failed — install missing tools / secrets first",
				"target": tgt,
				"doctor": preflight,
			})
			return
		}

		script, err := GenerateDeployScript(DeployScriptSpec{
			App:    body.App,
			Stack:  stack,
			Target: tgt,
			Path:   path,
		})
		if err != nil {
			cleanupPlans()
			jsonReply(w, http.StatusBadRequest, map[string]interface{}{
				"error":  err.Error(),
				"target": tgt,
			})
			return
		}
		f, ferr := os.CreateTemp("", "yaver-deploy-*.sh")
		if ferr != nil {
			cleanupPlans()
			jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "tempfile: " + ferr.Error()})
			return
		}
		if _, werr := f.WriteString(script); werr != nil {
			f.Close()
			_ = os.Remove(f.Name())
			cleanupPlans()
			jsonReply(w, http.StatusInternalServerError, map[string]string{"error": "write tempfile: " + werr.Error()})
			return
		}
		f.Close()
		_ = os.Chmod(f.Name(), 0700)
		plans = append(plans, &targetPlan{
			target:     tgt,
			stack:      stack,
			path:       path,
			script:     script,
			scriptPath: f.Name(),
		})
	}
	defer cleanupPlans()

	// Create history entries (one per target) BEFORE the SSE opens so
	// the first meta events already have their IDs.
	startedAt := time.Now()
	hist := s.ensureDeployHistory()
	for _, p := range plans {
		p.historyRun = hist.Start(DeployRun{
			App:       body.App,
			Target:    p.target,
			Stack:     p.stack,
			Path:      p.path,
			StartedAt: startedAt.UnixMilli(),
		})
		p.historyID = p.historyRun.ID
	}

	// Subprocess env — shared across all targets of the same app, so
	// computed once.
	env := buildDeployShipEnv(s.vaultStore, body.App)

	timeoutSec := body.TimeoutSec
	if timeoutSec <= 0 {
		timeoutSec = deployShipDefaultTimeoutSec
	}
	if timeoutSec > deployShipMaxTimeoutSec {
		timeoutSec = deployShipMaxTimeoutSec
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	// Open the SSE stream.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	// sseWriter serialises writes from the per-target goroutines.
	// Each write is one SSE frame; if the client has disconnected,
	// w.Write returns an error and we noop so the goroutines can
	// still drain their subprocesses cleanly.
	sw := &sseWriter{w: w, flusher: flusher}

	// One goroutine per target, independent lifecycle. Exit events
	// interleave; composite event at the end collects results.
	composite := len(plans) > 1
	var wg sync.WaitGroup
	results := make([]targetResult, len(plans))
	for i, plan := range plans {
		wg.Add(1)
		go func(idx int, plan *targetPlan) {
			defer wg.Done()
			results[idx] = runOneDeployTarget(ctx, sw, plan, env, body.App, timeoutSec, startedAt, hist, composite)
		}(i, plan)
	}
	wg.Wait()

	if composite {
		// Summary event — lets clients render a "2/3 ok" line without
		// parsing individual exit events.
		summary := make([]map[string]interface{}, 0, len(results))
		anyFailure := false
		for _, r := range results {
			summary = append(summary, map[string]interface{}{
				"target":      r.target,
				"id":          r.id,
				"ok":          r.ok,
				"code":        r.exitCode,
				"error_class": string(r.errorClass),
				"duration_ms": r.durationMs,
			})
			if !r.ok {
				anyFailure = true
			}
		}
		sw.writeEvent("composite", map[string]interface{}{
			"summary":     summary,
			"all_ok":      !anyFailure,
			"any_failure": anyFailure,
		})
	}
}

// targetResult captures the per-target outcome for the composite
// summary event. Mirrors what runOneDeployTarget emits in its own
// `exit` event.
type targetResult struct {
	target     string
	id         string
	ok         bool
	exitCode   int
	errorClass DeployErrorClass
	timedOut   bool
	durationMs int64
}

// runOneDeployTarget spawns bash on the plan's script and streams
// stdout/stderr to the shared sseWriter. Returns the per-target
// result that feeds the composite summary. Safe to run concurrently
// with other targets against the same writer.
func runOneDeployTarget(ctx context.Context, sw *sseWriter, plan *targetPlan, env []string, app string, timeoutSec int, startedAt time.Time, hist *DeployHistory, composite bool) targetResult {
	metaPayload := map[string]interface{}{
		"id":         plan.historyID,
		"app":        app,
		"target":     plan.target,
		"stack":      plan.stack,
		"path":       plan.path,
		"started_at": startedAt.UnixMilli(),
		"timeout_s":  timeoutSec,
	}
	if composite {
		metaPayload["composite"] = true
	}
	sw.writeEvent("meta", metaPayload)

	cmd := exec.CommandContext(ctx, "bash", plan.scriptPath)
	cmd.Env = env
	cmd.Dir = plan.path
	stdout, serr := cmd.StdoutPipe()
	if serr != nil {
		sw.writeEvent("error", map[string]string{
			"target": plan.target,
			"id":     plan.historyID,
			"error":  "stdout pipe: " + serr.Error(),
		})
		hist.Finish(plan.historyID, -1, false)
		final, _ := hist.Get(plan.historyID)
		FireDeployWebhook(final)
		return targetResult{target: plan.target, id: plan.historyID, ok: false, exitCode: -1, errorClass: final.ErrorClass}
	}
	stderr, serr := cmd.StderrPipe()
	if serr != nil {
		sw.writeEvent("error", map[string]string{
			"target": plan.target,
			"id":     plan.historyID,
			"error":  "stderr pipe: " + serr.Error(),
		})
		hist.Finish(plan.historyID, -1, false)
		final, _ := hist.Get(plan.historyID)
		FireDeployWebhook(final)
		return targetResult{target: plan.target, id: plan.historyID, ok: false, exitCode: -1, errorClass: final.ErrorClass}
	}
	if err := cmd.Start(); err != nil {
		sw.writeEvent("error", map[string]string{
			"target": plan.target,
			"id":     plan.historyID,
			"error":  "spawn: " + err.Error(),
		})
		hist.Finish(plan.historyID, -1, false)
		final, _ := hist.Get(plan.historyID)
		FireDeployWebhook(final)
		return targetResult{target: plan.target, id: plan.historyID, ok: false, exitCode: -1, errorClass: final.ErrorClass}
	}

	var wg sync.WaitGroup
	streamPipe := func(label string, rd io.Reader) {
		defer wg.Done()
		scanner := bufio.NewScanner(rd)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			text := scanner.Text()
			sw.writeEvent("line", map[string]string{
				"id":     plan.historyID,
				"target": plan.target,
				"stream": label,
				"text":   text,
			})
			hist.Append(plan.historyID, text)
		}
	}
	wg.Add(2)
	go streamPipe("stdout", stdout)
	go streamPipe("stderr", stderr)

	// Drain both pipes before Wait closes them. os/exec explicitly requires
	// StdoutPipe/StderrPipe reads to complete before Wait; doing this in the
	// opposite order intermittently dropped a fast target's final line while
	// still reporting exit 0 in a composite deploy. The scanners run
	// concurrently, so neither child pipe can fill and deadlock the process.
	wg.Wait()
	waitErr := cmd.Wait()

	exitCode := 0
	timedOut := false
	if waitErr != nil {
		if ee, ok := waitErr.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else {
			exitCode = -1
			sw.writeEvent("error", map[string]string{
				"target": plan.target,
				"id":     plan.historyID,
				"error":  waitErr.Error(),
			})
		}
		if ctx.Err() == context.DeadlineExceeded {
			timedOut = true
			exitCode = -1
		}
	}
	duration := time.Since(startedAt)
	hist.Finish(plan.historyID, exitCode, timedOut)
	finalRun, _ := hist.Get(plan.historyID)
	sw.writeEvent("exit", map[string]interface{}{
		"id":          plan.historyID,
		"target":      plan.target,
		"code":        exitCode,
		"duration_ms": duration.Milliseconds(),
		"ok":          finalRun.OK,
		"error_class": string(finalRun.ErrorClass),
		"timed_out":   timedOut,
	})
	FireDeployWebhook(finalRun)
	return targetResult{
		target:     plan.target,
		id:         plan.historyID,
		ok:         finalRun.OK,
		exitCode:   exitCode,
		errorClass: finalRun.ErrorClass,
		timedOut:   timedOut,
		durationMs: duration.Milliseconds(),
	}
}

// sseWriter serialises writeEvent calls across goroutines. SSE
// framing is "event: <name>\ndata: <json>\n\n"; two overlapping
// writes would interleave and corrupt the stream, so we hold the
// mutex around each frame.
type sseWriter struct {
	mu      sync.Mutex
	w       io.Writer
	flusher http.Flusher
}

func (s *sseWriter) writeEvent(event string, payload interface{}) {
	b, _ := json.Marshal(payload)
	s.mu.Lock()
	defer s.mu.Unlock()
	fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, b)
	if s.flusher != nil {
		s.flusher.Flush()
	}
}

// normaliseTargetList accepts the composite-or-single pair from the
// request body and returns the canonical ordered, deduped, trimmed
// list. `target` (singular) is appended as a fallback ONLY when
// `targets` is empty — otherwise it's ignored.
func normaliseTargetList(targets []string, target string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, t := range targets {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if _, dup := seen[t]; dup {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	if len(out) == 0 {
		t := strings.TrimSpace(target)
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}

// resolveDeployStackPath runs the workspace-manifest lookup (+path
// absolutisation) that the old inline code did. Extracted so both
// single and composite paths behave identically.
func resolveDeployStackPath(app, stack, path string) (string, string, error) {
	if stack != "" && path != "" {
		if !filepath.IsAbs(path) {
			if abs, err := filepath.Abs(path); err == nil {
				path = abs
			}
		}
		return stack, path, nil
	}

	ref, err := resolveProjectRef(app, path)
	if err != nil {
		return "", "", fmt.Errorf("could not resolve stack and path for %q — declare the app in yaver.workspace.yaml, ensure it is discoverable locally, or pass --stack --path (owner only)", app)
	}
	if stack == "" {
		stack = ref.Stack
	}
	if path == "" {
		path = ref.Path
	}
	if stack == "" || path == "" {
		return "", "", fmt.Errorf("could not resolve stack and path for %q — declare the app in yaver.workspace.yaml, ensure it is discoverable locally, or pass --stack --path (owner only)", app)
	}
	return stack, path, nil
}

// buildDeployShipEnv composes the owner subprocess env plus project
// vault values (project-scoped + globals, project wins on collision).
func buildDeployShipEnv(vs *VaultStore, project string) []string {
	base := append([]string(nil), os.Environ()...)

	if vs == nil {
		return base
	}
	seen := map[string]int{}
	for i, kv := range base {
		if eq := strings.IndexByte(kv, '='); eq > 0 {
			seen[kv[:eq]] = i
		}
	}
	setEnv := func(k, v string) {
		kv := k + "=" + v
		if idx, ok := seen[k]; ok {
			base[idx] = kv
		} else {
			seen[k] = len(base)
			base = append(base, kv)
		}
	}
	// Globals first so the project values can override.
	for _, sum := range vs.List("") {
		entry, err := vs.Get("", sum.Name)
		if err == nil && entry != nil {
			setEnv(entry.Name, entry.Value)
		}
	}
	for _, sum := range vs.List(project) {
		entry, err := vs.Get(project, sum.Name)
		if err == nil && entry != nil {
			setEnv(entry.Name, entry.Value)
		}
	}
	return base
}
