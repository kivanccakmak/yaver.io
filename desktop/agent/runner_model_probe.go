package main

// runner_model_probe — ask the RUNNER which models this login can actually run.
//
// WHY THIS VERB EXISTS (2026-08-02)
//
// Yaver drives coding agents on the user's OWN subscription, never an API key.
// Which models such a login may use is decided by the provider, changes
// without notice, and is NOT derivable from the model id — the day this
// shipped, `gpt-5.3-codex` (the one whose name says "codex") was refused while
// `gpt-5.6-terra` worked.
//
// Every layer of the product had guessed instead of asking, and they all
// guessed together: the web picker, both declared defaults, the Convex
// normalizer and the dispatch funnel were pointed at a model the account
// refuses, so every vibe turn died with runner.model.not_supported on every
// surface. Diagnosing it needed one command:
//
//	codex exec --model <id> "reply OK"
//
// That command existed only in a session transcript. Ninety seconds of truth
// that nobody could reach from the phone, the dashboard, the TV or a future
// session — so the same wrong guess could be made again tomorrow. This verb is
// that probe, promoted into the product, per the rule in CLAUDE.md: headless
// first, and every incident grows the headless layer a VERB.
//
// It probes the OPERATION. It does not read a catalogue, a config file or a
// version string — those are exactly the inventories that lied.

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// codexProbeCandidates is the set probed when the caller names none. It is a
// starting point, not a claim: the verdicts come from running each one.
var codexProbeCandidates = []string{
	"gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna",
	"gpt-5.5", "gpt-5.4", "gpt-5.4-mini",
}

type runnerModelProbeResult struct {
	Model    string `json:"model"`
	Usable   bool   `json:"usable"`
	Verdict  string `json:"verdict"` // works | rejected | error
	Detail   string `json:"detail,omitempty"`
	Duration string `json:"duration"`
}

// probeCodexModel runs the smallest possible real generation. A model the
// account cannot use fails fast and says so in its own words; anything else is
// reported as an error rather than being counted as a refusal, because "the
// network was down" must never become "this model is unusable" in a ledger
// that later rewrites the user's choice.
func probeCodexModel(ctx context.Context, model string) runnerModelProbeResult {
	started := time.Now()
	cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()

	cmd := exec.CommandContext(cctx, "codex", "exec",
		"--model", model, "--skip-git-repo-check", "reply with the single word OK")
	cmd.WaitDelay = 10 * time.Second // a context kill does not free us while a grandchild holds the pipe
	out, err := cmd.CombinedOutput()
	text := string(out)
	res := runnerModelProbeResult{Model: model, Duration: time.Since(started).Round(time.Millisecond).String()}

	switch {
	case strings.Contains(strings.ToLower(text), "not supported"):
		res.Verdict, res.Usable = "rejected", false
		res.Detail = firstMeaningfulLine(text)
	case err == nil:
		res.Verdict, res.Usable = "works", true
	case cctx.Err() == context.DeadlineExceeded:
		res.Verdict, res.Usable = "error", false
		res.Detail = "probe timed out after 90s — inconclusive, NOT a refusal"
	default:
		res.Verdict, res.Usable = "error", false
		res.Detail = firstMeaningfulLine(text)
		if res.Detail == "" {
			res.Detail = err.Error()
		}
	}
	return res
}

func firstMeaningfulLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "[") {
			if len(line) > 200 {
				return line[:200]
			}
			return line
		}
	}
	return ""
}

// mcpRunnerModelProbe is the verb body. Runner is currently codex-only: it is
// the only one whose model set the provider gates per auth kind, and claiming
// coverage we have not probed would be the very failure this exists to end.
func mcpRunnerModelProbe(runner string, models []string) interface{} {
	r := strings.ToLower(strings.TrimSpace(runner))
	if r == "" {
		r = "codex"
	}
	if r != "codex" {
		return map[string]interface{}{
			"error": fmt.Sprintf("runner_model_probe supports codex today, not %q", r),
			"remedy": "Codex is the runner whose model set is gated per auth kind. " +
				"Add a probe recipe here before claiming coverage for another runner.",
		}
	}
	if _, err := exec.LookPath("codex"); err != nil {
		return map[string]interface{}{
			"error":  "codex is not installed on this machine",
			"remedy": "Install it first — ops verb install_tool {tool:\"codex\"} — then re-probe.",
		}
	}

	candidates := models
	if len(candidates) == 0 {
		candidates = codexProbeCandidates
	}

	ctx := context.Background()
	results := make([]runnerModelProbeResult, 0, len(candidates))
	usable := make([]string, 0, len(candidates))
	rejected := make([]string, 0, len(candidates))
	for _, m := range candidates {
		m = strings.TrimSpace(m)
		if m == "" {
			continue
		}
		res := probeCodexModel(ctx, m)
		results = append(results, res)
		switch res.Verdict {
		case "works":
			usable = append(usable, m)
		case "rejected":
			rejected = append(rejected, m)
		}
	}

	out := map[string]interface{}{
		"runner":   "codex",
		"probed":   len(results),
		"usable":   usable,
		"rejected": rejected,
		"results":  results,
		"note": "Verdicts come from running a real generation, not from a catalogue. " +
			"'error' means inconclusive (timeout/network) and must never be recorded as a refusal.",
	}
	if len(usable) > 0 {
		out["recommended_default"] = usable[0]
	} else {
		out["remedy"] = "No probed model was usable. Check the runner is signed in " +
			"(runner_auth_status) before treating this as a model problem."
	}
	return out
}
