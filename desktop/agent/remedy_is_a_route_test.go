package main

// remedy_is_a_route_test.go — a `remedy` that NAMES an action must carry the
// route to it.
//
// THE MEASUREMENT (docs/handoff/session-2026-08-03-remaining-work.md #4): of the
// four wire-level `remedy` producers in the agent, exactly ONE emitted something
// invocable (`stream-over-webrtc`). The other three were English prose in a
// field whose name promises a route.
//
// Prose in `remedy` is WORSE than an empty field. It looks structured, so layer
// D gets ticked off in review — "the remedy is there" — while the surface still
// has nothing it can render as a button, and the user is left retyping a command
// the product could have run. The worked example is verbatim from the codebase:
// runner_model_probe told the reader to run `install_tool {tool:"codex"}` while
// POST /install/codex existed, streamed, and was one call away.
//
// THE RULE THIS PINS. If a remedy string names an invocable thing — an ops verb,
// an agent endpoint, a `yaver <cmd>` — the same reply must carry the typed route
// (a `capabilityGap` with a `fix`, or an equivalent structured field). A remedy
// that only DESCRIBES a state ("check the runner is signed in") is allowed to
// stay prose: there is nothing to invoke, and inventing a button for it would be
// the opposite failure.
//
// Like reason_code_wiring_test.go this is a RATCHET: prose-only remedies that
// have not been converted are listed with the reason, and the test fails both
// when a new one appears and when a listed one has been fixed and left listed.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// proseOnlyRemedies are remedy strings that deliberately stay prose, and why.
// Keyed by a distinctive fragment of the string. Deleting an entry is how a
// conversion gets recorded.
var proseOnlyRemedies = map[string]string{
	// EMPTY, and that is the current measured state — not an oversight.
	//
	// Every remedy the agent emits that NAMES an invocable action now carries the
	// typed route beside it (today: exactly one, runner_model_probe's missing
	// codex, converted 2026-08-04). The other prose remedies survive because they
	// name nothing to invoke:
	//
	//   runner_model_probe:113  "add a probe recipe" — developer-facing; the
	//                           reader is whoever writes the recipe.
	//   runner_model_probe:179  "no probed model was usable" — a diagnosis with
	//                           several possible causes; one button would guess.
	//   mcp_appdev:64           "set APP_STORE_KEY_PATH…" — three secrets only
	//                           App Store Connect can issue; a button opening an
	//                           empty form is not a fix.
	//
	// Those are skipped by rxInvocable, correctly, so they never need an entry
	// here. Add one ONLY for a remedy that genuinely names an action and
	// genuinely cannot be routed — with the reason, in this comment's style.
}

// rxInvocable matches a remedy that names something the product can run.
var rxInvocable = regexp.MustCompile(
	`ops verb |install_tool|POST /|GET /|yaver install|yaver auth|/install/`)

// TestRemedyThatNamesAnActionCarriesTheRoute walks the agent's Go sources for
// `"remedy":` map literals and checks each one.
func TestRemedyThatNamesAnActionCarriesTheRoute(t *testing.T) {
	root := repoRoot(t)
	dir := filepath.Join(root, "desktop", "agent")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read agent dir: %v", err)
	}

	checked, prose := 0, 0
	// Which allowlist entries were actually reached. An entry that matches
	// nothing protects nothing, and a ratchet with dead keys drifts back into
	// being a document — the exact failure this file's sibling was written to
	// correct.
	hit := map[string]bool{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		src := string(body)
		lines := strings.Split(src, "\n")
		for i, line := range lines {
			if !strings.Contains(line, `"remedy"`) {
				continue
			}
			if strings.HasPrefix(strings.TrimSpace(line), "//") {
				continue
			}
			// A remedy can be written across continued string concatenations;
			// take a small window so the invocable check sees the whole sentence.
			end := i + 4
			if end > len(lines) {
				end = len(lines)
			}
			stmt := strings.Join(lines[i:end], " ")
			checked++

			if !rxInvocable.MatchString(stmt) {
				continue // describes a state; prose is correct here
			}

			listed := ""
			for frag := range proseOnlyRemedies {
				if strings.Contains(stmt, frag) {
					listed = frag
					hit[frag] = true
					break
				}
			}

			// Does the SAME reply carry a typed route? Look in a slightly wider
			// window for the structured field beside it.
			wide := i + 12
			if wide > len(lines) {
				wide = len(lines)
			}
			near := strings.Join(lines[i-min(i, 8):wide], " ")
			hasRoute := strings.Contains(near, "capabilityGap") ||
				strings.Contains(near, "CapabilityGap") ||
				strings.Contains(near, "GapFix") ||
				strings.Contains(near, `"fix"`)

			switch {
			case hasRoute && listed != "":
				t.Errorf("%s:%d — this remedy now carries a route; delete %q from proseOnlyRemedies. An allowlist that outlives its defect is how an audit becomes wrong.",
					e.Name(), i+1, listed)
			case !hasRoute && listed == "":
				t.Errorf("%s:%d — remedy NAMES an invocable action but the reply carries no typed route:\n    %s\n"+
					"Emit a capabilityGap with a GapFix beside it, or add the string to proseOnlyRemedies with the reason it cannot be a route.",
					e.Name(), i+1, strings.TrimSpace(stmt))
			case !hasRoute:
				prose++
			}
		}
	}

	for frag := range proseOnlyRemedies {
		if !hit[frag] {
			t.Errorf("proseOnlyRemedies key %q matched no remedy the guard examined — either the string changed, or it never reached the invocable check. A key that protects nothing is how an allowlist becomes fiction; delete it or fix the fragment.", frag)
		}
	}

	if checked == 0 {
		t.Fatal(`found no "remedy" producers at all — the shape changed and this guard went blind`)
	}
	t.Logf(`checked %d "remedy" sites · %d deliberately prose-only`, checked, prose)
}
