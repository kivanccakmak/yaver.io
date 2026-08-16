package main

// vibe_preview_takeover.go — the preview lock, as a route instead of a wall.
//
// THE INCIDENT (2026-08-03, tvOS and visionOS in the same run). One surface
// opened project "sfmg"; every other surface then got
//
//	Preview unavailable
//	preview session for project "sfmg" already active; stop it first
//	[ Try again ]
//
// and `Try again` could not succeed for as long as the lock was held. The
// all-surfaces loop hit it too, and was worked around in the test runner rather
// than in the product — which is how a defect stops being visible without
// stopping being real.
//
// Four layers, and all four were broken at once:
//
//	A DETECTION — fine. The manager knew exactly which project was held.
//	B SIGNAL    — a bare `fmt.Errorf` string. vibe_preview_http.go then
//	              PROSE-MATCHED the agent's own sentence
//	              (`strings.Contains(msg, "already active")`) to choose a status
//	              code. The agent regexing itself is the drift this codebase
//	              keeps paying for, one layer earlier than usual.
//	C UI        — "Preview unavailable" + the raw sentence.
//	D ROUTE     — none, and worse: a `Try again` button in its place. Meanwhile
//	              POST /vibing/preview/stop had existed the whole time and every
//	              client already wrapped it (mobile/src/lib/vibePreview.ts:149,
//	              web/lib/agent-client.ts:5278, tvos/.../AgentClient.swift:354).
//
// The fix is not a better sentence. It is a CapabilityGap carrying the stop
// route with its body pre-filled and Instant set, so every surface renders
// "Stop it and take over" and suppresses the retry — the same object, off the
// same `code`, on the surfaces that cannot share a line of code.
//
// WHY CapabilityGap AND NOT A NEW TYPE. The envelope is code + summary + detail
// + (route | constraint), keyed off Code, already parsed by
// mobile/src/lib/capabilityGap.ts, web/lib/capabilityGap.ts and
// tvos/YaverTV/FailureSignals.swift. FAILURE_PLUMBING_ARCHITECTURE.md §7 says
// so explicitly ("PlaybookEntry.Verb/Args becomes a GapFix for free") — the type
// is the product's generic named-cause-with-a-route, and a held lock is one.
// Inventing a second envelope would mean a second renderer per surface, which is
// how the same fix ships on two of seven surfaces.

import (
	"fmt"
	"strings"
	"time"
)

// PreviewSessionActiveError is the TYPED refusal for "one session per project".
//
// Typed so the HTTP layer can pick a status with errors.As instead of grepping
// the message it just produced. The fields are the facts a user needs before
// taking a screen away from another surface: what is being shown, at what form
// factor, since when, and — when the holder announced itself — from where.
type PreviewSessionActiveError struct {
	Project string
	// Active is the session holding the lock. Never nil in practice; guarded
	// anyway, because a nil deref inside an error path takes the whole refusal
	// down and turns a named cause into a 500.
	Active *VibePreviewSession
}

func (e *PreviewSessionActiveError) Error() string {
	// The sentence stays close to what shipped: a view that renders only the
	// message must not lose information when the typed fields arrive beside it.
	return fmt.Sprintf("preview session for project %q already active; stop it first", e.Project)
}

// PreviewBrowserUnavailableError is "this box has no browser to capture with".
// Typed for the same reason: the 503 used to be chosen by matching the phrase
// "browser automation unavailable" against the agent's own error string.
type PreviewBrowserUnavailableError struct{}

func (e *PreviewBrowserUnavailableError) Error() string {
	return "browser automation unavailable: install Chrome/Chromium"
}

// PreviewTargetUnreachableError is "nothing is listening at the targetUrl the
// preview was told to capture". Distinct from a page that LOADS and errors:
// this is a connection refusal, measured by the pre-probe (or by Chrome's own
// navigate when the pre-probe is skipped), and it has a deterministic fix —
// the project's dev server is not running and /dev/start can start it.
//
// TargetURL and WorkDir are carried so the HTTP layer can build a route-to-fix
// without the surface guessing which project to start. This is the
// connect-green-but-vibe-dead class: the agent is reachable, so the device card
// says Connected, while nothing serves the port the preview needs.
type PreviewTargetUnreachableError struct {
	TargetURL string
	Project   string
	WorkDir   string
	Framework string
}

func (e *PreviewTargetUnreachableError) Error() string {
	return fmt.Sprintf("nothing is serving %s — start the project's dev server first (vibe preview cannot capture a port with no listener)", e.TargetURL)
}

// previewSurfaceLabel is how a holding surface is named to a human. Keyed off
// the X-Yaver-Surface header the native surfaces already send on every request
// (tvos/YaverTV/AgentClient.swift, watch/YaverWatch/Backend.swift), so the
// common collision — TV vs headset vs phone — names itself with no client
// change at all. Unknown or absent means we say "another surface", which is
// true; guessing would not be.
func previewSurfaceLabel(surface string) string {
	switch normalizeSessionScope(surface) {
	case "tv":
		return "your TV"
	case "watch":
		return "your watch"
	case "vision":
		return "your headset"
	case "spatial":
		return "your glasses"
	}
	switch surface {
	case "mobile", "phone", "ios", "android":
		return "your phone"
	case "tablet", "ipad":
		return "your tablet"
	case "web", "dashboard", "web-ui":
		return "the web dashboard"
	case "car", "carplay":
		return "your car"
	case "":
		return "another surface"
	}
	return "another surface"
}

// previewSessionActiveGap turns the held lock into a named cause with ONE
// invocable route.
//
// Instant + Retry, deliberately: the stop answers in milliseconds and the
// original start is then re-issued, so the user's next frame IS the
// confirmation. There is nothing to stream and nothing to confirm — offering a
// preview-then-apply gate for taking over your own preview would be friction
// pretending to be safety, and the label already says exactly what happens.
//
// No Constraint is set, and that is the whole point: this refusal HAS a fix, so
// the surfaces must render the fix and suppress the retry.
func previewSessionActiveGap(err *PreviewSessionActiveError) *CapabilityGap {
	if err == nil {
		return nil
	}
	holder := "another surface"
	detail := ""
	if s := err.Active; s != nil {
		holder = previewSurfaceLabel(s.Surface)
		// State what would be interrupted, in the order a user decides in:
		// where it is pointed, at what size, and how long it has been up.
		detail = fmt.Sprintf("%s has been previewing %s at %d×%d for %s. "+
			"Stopping it hands the preview to this surface — nothing else about the project changes, "+
			"and the other surface can take it back the same way.",
			capitalizeFirst(holder), s.TargetURL, s.Profile.Width, s.Profile.Height,
			shortPreviewAge(s.StartedAt))
	} else {
		detail = "Stopping it hands the preview to this surface. Nothing else about the project changes."
	}

	return &CapabilityGap{
		Code:       ReasonPreviewSessionActive,
		Capability: "preview-session",
		Summary:    fmt.Sprintf("%s is already previewing %q.", capitalizeFirst(holder), err.Project),
		Detail:     detail,
		Fix: &GapFix{
			Label:  "Stop it and take over",
			Method: "POST",
			Path:   "/vibing/preview/stop",
			// Pre-filled because the endpoint REQUIRES it. A takeover button
			// assembled from method+path alone would 400 — one more action that
			// cannot succeed, which is the bug, not the fix.
			Body:    map[string]interface{}{"project": err.Project},
			Instant: true,
			Retry:   true,
		},
	}
}

// previewBrowserUnavailableGap routes the 503 through the SAME producer every
// other missing tool uses, so the preview panel gets a streamed Install button
// instead of a sentence. `chromium` has an install recipe (install_cmd.go), and
// capabilityGapForMissingTools validates that against the same tables
// `yaver install` consults — so this can never advertise a route that 404s, and
// on a platform where it cannot work it degrades to an honest Constraint.
func previewBrowserUnavailableGap() *CapabilityGap {
	return capabilityGapForMissingTools([]string{"chromium"})
}

// previewTargetUnreachableGap turns "nothing is serving the targetUrl" into a
// named cause with ONE invocable route: POST /dev/start, body pre-filled with
// the project, workDir and framework, with a stream so the user watches the dev
// server boot. Retry=true re-issues the preview start when the dev server
// reports ready — the user's first frame IS the confirmation.
//
// WorkDir/Framework are best-effort: the manager may not always know them (a
// bare targetUrl with no project context). When unknown, the route still
// exists — /dev/start accepts a workDir-less body and auto-detects from the
// agent's current project — but the summary must not claim a certainty the
// route does not have. No Constraint: this class always has a fixer.
func previewTargetUnreachableGap(err *PreviewTargetUnreachableError) *CapabilityGap {
	if err == nil {
		return nil
	}
	body := map[string]interface{}{}
	if strings.TrimSpace(err.Project) != "" {
		body["projectName"] = err.Project
	}
	if strings.TrimSpace(err.WorkDir) != "" {
		body["workDir"] = err.WorkDir
	}
	if strings.TrimSpace(err.Framework) != "" {
		body["framework"] = err.Framework
	}
	summary := fmt.Sprintf("Nothing is serving %s on this machine.", err.TargetURL)
	if strings.TrimSpace(err.Project) != "" {
		summary = fmt.Sprintf("The %q dev server isn't running — nothing is serving %s.", err.Project, err.TargetURL)
	}
	return &CapabilityGap{
		Code:       ReasonPreviewTargetUnreachable,
		Capability: "preview-target",
		Summary:    summary,
		Detail:     "The device is connected, but no dev server is listening at the preview address — there is nothing to capture yet. Starting the project's dev server first makes the preview work.",
		Fix: &GapFix{
			Label:  "Start the dev server",
			Method: "POST",
			Path:   "/dev/start",
			Stream: "devserver",
			Body:   body,
			Retry:  true,
		},
	}
}

// ─── "Is it released yet?" ───────────────────────────────────────────────────

// PreviewRelease answers the question the all-surfaces e2e loop could only
// answer by sleeping for four seconds.
//
// The blockers are named, not counted, because a caller that times out deserves
// to know WHICH half is still holding on — "the capture loop is still running"
// and "the session was never stopped" have different fixes, and a bare
// `released:false` sends the reader to guess.
type PreviewRelease struct {
	Project  string   `json:"project"`
	Released bool     `json:"released"`
	Blockers []string `json:"blockers,omitempty"`
	// Holder is the surface still holding the session, when one is. Lets a
	// caller decide between waiting and taking over.
	Holder string `json:"holder,omitempty"`
}

// ReleaseState reports whether a NEW preview session for this project could be
// claimed right now.
//
// It probes the two things that are genuinely still in flight after Stop()
// returns — the session entry and the capture goroutine — rather than the proxy
// ("did Stop return?"), which is always true and therefore says nothing. That
// distinction is the whole rule: the inventory answers instantly and lies; the
// operation is what the next caller actually collides with.
func (m *VibePreviewManager) ReleaseState(project string) PreviewRelease {
	out := PreviewRelease{Project: project, Released: true}
	if m == nil {
		return out
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if sess, ok := m.sessions[project]; ok {
		out.Released = false
		out.Holder = sess.Surface
		out.Blockers = append(out.Blockers, "a preview session for this project is still active")
	}
	if n := m.liveLoops[project]; n > 0 {
		out.Released = false
		out.Blockers = append(out.Blockers,
			fmt.Sprintf("%d capture loop(s) still winding down — the browser target is not free yet", n))
	}
	return out
}

// shortPreviewAge is "4m", "1h 12m", "just now" — enough to decide with, never
// a timestamp the user has to subtract from.
func shortPreviewAge(started time.Time) string {
	if started.IsZero() {
		return "a while"
	}
	d := time.Since(started)
	switch {
	case d < 10*time.Second:
		return "a few seconds"
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	default:
		return fmt.Sprintf("%dh %dm", int(d.Hours()), int(d.Minutes())%60)
	}
}

func capitalizeFirst(s string) string {
	if s == "" {
		return s
	}
	r := []rune(s)
	if r[0] >= 'a' && r[0] <= 'z' {
		r[0] = r[0] - 'a' + 'A'
	}
	return string(r)
}
