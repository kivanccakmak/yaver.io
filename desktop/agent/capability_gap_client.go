package main

// capability_gap_client.go — the CLI is a CLIENT SURFACE, and it was the only
// one that could not see a capability gap.
//
// WHY THIS FILE EXISTS. `capability_gap.go` produces a structured gap — a
// named capability, a sentence, and either a route (`method + path + stream`)
// or the constraint explaining why no route exists. It rides three channels:
// the /dev/start 412 body, the /dev/events SSE frame, and the /tasks failure
// body. Mobile and web both parse it (mobile/src/lib/capabilityGap.ts,
// web/lib/capabilityGap.ts) and render an Install button that streams.
//
// The CLI parsed none of it, for one structural reason in one function:
// `localAgentRequestAuth` (session_cmd.go) read `result["error"]` out of a
// non-2xx body and threw the rest of the object away. So `yaver dev start` on
// a box without Flutter printed
//
//     Error: no dev server framework detected for this project
//
// and exited 1, while the SAME response carried `capabilityGap.fix.path =
// /install/flutter` and the phone showed a button. That is the 2026-07-26
// incident's exact shape — a truthful agent plus a client that drops the truth
// — one surface over.
//
// THE OBLIGATIONS THIS DISCHARGES (CLAUDE.md, "a missing toolchain is a
// product requirement, not a user error"):
//   1. NAME IT, on the surface the user is looking at — here, stderr.
//   2. OFFER THE FIX when a fix exists. On a CLI the runnable command IS the
//      button, so we print the exact `yaver install <tool>` line — and we only
//      print it after checking the installer actually knows that tool, because
//      advertising an install that cannot run is worse than saying nothing.
//   3. NAME THE CONSTRAINT when it does not. No fake button.
//
// This file only READS capability_gap.go's types; it never edits them.

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// CapabilityGapError is the transport-level carrier for a refusal that came
// with a route. It wraps rather than replaces the flat message: every existing
// call site that prints `%v` keeps printing exactly what it printed before, and
// only the call sites that ask for the gap get more.
type CapabilityGapError struct {
	Gap     *CapabilityGap
	Message string
}

func (e *CapabilityGapError) Error() string { return e.Message }

// AsCapabilityGapError unwraps err into a *CapabilityGapError, or nil.
// Deliberately tolerant of wrapping (`fmt.Errorf("%w")`) so a command that
// decorates the error on its way up still gets the gap.
func AsCapabilityGapError(err error) *CapabilityGapError {
	for err != nil {
		if gapErr, ok := err.(*CapabilityGapError); ok {
			return gapErr
		}
		unwrapped, ok := err.(interface{ Unwrap() error })
		if !ok {
			return nil
		}
		err = unwrapped.Unwrap()
	}
	return nil
}

// decodeCapabilityGapError sniffs a non-2xx body for a `capabilityGap` and
// returns a typed error when it finds one. Returns nil for everything else, so
// the caller falls through to its existing flat-message path unchanged.
//
// Mirrors decodeCloudWorkspaceRequiredError (task_placement_client.go), which
// is the established idiom for "this refusal is structured, promote it".
//
// Status-agnostic on purpose: the gap rides a 412 from /dev/start, a 500 from
// /tasks, and a 200-with-status-failed task body. Keying on a status code would
// have shipped a parser that works on one lane and silently not the others —
// which is the whole class of bug this seam exists to end.
func decodeCapabilityGapError(raw []byte, fallbackMessage string) error {
	if len(raw) == 0 {
		return nil
	}
	var body struct {
		Gap          *CapabilityGap `json:"capabilityGap"`
		AltGap       *CapabilityGap `json:"gap"`
		Error        string         `json:"error"`
		ErrorSummary string         `json:"errorSummary"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil
	}
	gap := body.Gap
	if gap == nil {
		gap = body.AltGap
	}
	// A gap with no code or no summary is half-formed. Rendering it would put a
	// heading with no sentence under it — worse than the flat error we already
	// had. Fall through instead.
	if gap == nil || strings.TrimSpace(gap.Code) == "" || strings.TrimSpace(gap.Summary) == "" {
		return nil
	}
	message := strings.TrimSpace(body.Error)
	if message == "" {
		message = strings.TrimSpace(body.ErrorSummary)
	}
	if message == "" {
		message = strings.TrimSpace(fallbackMessage)
	}
	if message == "" {
		message = gap.Summary
	}
	return &CapabilityGapError{Gap: gap, Message: message}
}

// capabilityGapInstallTool derives the `yaver install <tool>` argument from the
// fix path, or "" when the fix is not an install route. Same derivation the
// phone uses (mobile/src/lib/capabilityGap.ts::gapInstallTool) so the two
// surfaces cannot disagree about which tool a gap means.
func capabilityGapInstallTool(fix *GapFix) string {
	if fix == nil {
		return ""
	}
	path := strings.TrimSpace(fix.Path)
	if !strings.HasPrefix(path, "/install/") {
		return ""
	}
	return strings.Trim(strings.TrimPrefix(path, "/install/"), "/")
}

// capabilityGapCommand returns the exact command line that fixes the gap on
// THIS machine, or "" when there is none the CLI can honestly offer.
//
// The check against the installer's own tables is the point. `POST
// /install/<tool>` and `yaver install <tool>` resolve through the same
// lookupIntegration → metaInstallPlan pair, so if neither knows the tool then
// printing the command would send the user to
// `unknown integration "x". Try 'yaver install list'.` — a remedy that fails is
// how a product teaches people to stop trusting its remedies.
func capabilityGapCommand(gap *CapabilityGap) string {
	if gap == nil || gap.Fix == nil {
		return ""
	}
	tool := capabilityGapInstallTool(gap.Fix)
	if tool == "" {
		return ""
	}
	if _, ok := lookupIntegration(tool); !ok {
		if _, ok := metaInstallPlan(tool); !ok {
			return ""
		}
	}
	return "yaver install " + tool
}

// capabilityResourceLine renders the headroom measurement behind a warning or
// constraint. The agent pre-formats the human strings precisely so no surface
// invents its own byte formatter — so this only arranges them, never divides.
func capabilityResourceLine(res *CapabilityResource) string {
	if res == nil {
		return ""
	}
	parts := []string{}
	if free := strings.TrimSpace(res.FreeHuman); free != "" {
		where := strings.TrimSpace(res.Path)
		if where == "" {
			parts = append(parts, free+" free")
		} else {
			parts = append(parts, fmt.Sprintf("%s free on %s", free, where))
		}
	}
	if need := strings.TrimSpace(res.NeedHuman); need != "" {
		parts = append(parts, "needs "+need)
	}
	if reclaim := strings.TrimSpace(res.ReclaimableHuman); reclaim != "" {
		parts = append(parts, reclaim+" reclaimable")
	}
	if len(parts) == 0 {
		return ""
	}
	return "Disk:  " + strings.Join(parts, " · ")
}

// printCapabilityGap writes the gap to w in the CLI's own idiom: a
// command-prefixed headline, then indented detail, then either the exact
// command that fixes it or the reason there is none.
//
// The shape follows deploy_cmd.go's vault remedy (state the fact, then the
// literal command to type) and wire_cmd.go's indented "here is what I looked
// for" block. It deliberately does NOT invent glyphs or colour: a gap printed
// during a piped build must stay grep-able.
//
// `prefix` is the command name the caller already prints its errors under
// ("yaver dev start", "code", "wire push") so the line reads the same as every
// other failure from that command.
func printCapabilityGap(w io.Writer, prefix string, gap *CapabilityGap) {
	if gap == nil {
		return
	}
	head := strings.TrimSpace(prefix)
	if head != "" {
		head += ": "
	}
	fmt.Fprintf(w, "%s%s\n", head, gap.Summary)

	if detail := strings.TrimSpace(gap.Detail); detail != "" {
		fmt.Fprintf(w, "  %s\n", detail)
	}
	// A warning rides BESIDE a fix — the operation can start, and here is what
	// may still go wrong. The user must hear it before waiting ten minutes.
	if warning := strings.TrimSpace(gap.Warning); warning != "" {
		fmt.Fprintf(w, "  Heads-up: %s\n", warning)
	}
	if line := capabilityResourceLine(gap.Resource); line != "" {
		fmt.Fprintf(w, "  %s\n", line)
	}

	if cmd := capabilityGapCommand(gap); cmd != "" {
		fmt.Fprintf(w, "  Fix:   %s\n", cmd)
		if est := strings.TrimSpace(gap.Fix.Est); est != "" {
			fmt.Fprintf(w, "         %s\n", est)
		}
		if gap.Fix.Retry {
			fmt.Fprintf(w, "  Then:  re-run this command\n")
		}
	} else if gap.Fix != nil {
		// There IS a route, but not one this CLI can spell as a command — e.g.
		// a confirm-gated reclaim. Name the endpoint rather than pretending
		// there is nothing to do.
		fmt.Fprintf(w, "  Fix:   %s %s (from the dashboard or phone)\n",
			strings.TrimSpace(gap.Fix.Method), strings.TrimSpace(gap.Fix.Path))
	} else if constraint := strings.TrimSpace(gap.Constraint); constraint != "" {
		// No fixer here. Say why. "Check your configuration" is the vague error
		// whose cost is measured in whole sessions.
		fmt.Fprintf(w, "  Why:   %s\n", constraint)
	}

	// Disk is the one blocker that ships with its own way out.
	if gap.Reclaim != nil {
		label := strings.TrimSpace(gap.Reclaim.Label)
		if label == "" {
			label = "Free up space"
		}
		fmt.Fprintf(w, "  Space: %s — %s %s\n", label,
			strings.TrimSpace(gap.Reclaim.Method), strings.TrimSpace(gap.Reclaim.Path))
	}

	if gap.Fix != nil && strings.TrimSpace(gap.Fix.Stream) != "" {
		fmt.Fprintf(w, "  Watch: yaver stream %s\n", strings.TrimSpace(gap.Fix.Stream))
	}
}

// printCapabilityGapForError is the one-liner every command's error path calls.
// Returns true when it printed a gap, so the caller can skip its own flat
// `Error: %v` line and not say the same thing twice in two different shapes.
func printCapabilityGapForError(w io.Writer, prefix string, err error) bool {
	gapErr := AsCapabilityGapError(err)
	if gapErr == nil || gapErr.Gap == nil {
		return false
	}
	printCapabilityGap(w, prefix, gapErr.Gap)
	return true
}
