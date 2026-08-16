// screen_context.go — what the user is ACTUALLY LOOKING AT, carried into the
// prompt.
//
// ── The incident this fixes (2026-07-26) ───────────────────────────────────
//
// A user watching the browser preview of `sfmg / mobile` in web Vibing →
// Runtime typed:
//
//	"so in sfmg i selected menejer initially it only has ileri i may
//	 changed my mind it should have geri as well"
//
// The screen in front of them was the onboarding step titled "Adın ne?" with a
// name field, a "Karışık" shuffle button and exactly one "İleri →" (next)
// button. The runner (codex) received ONLY that sentence. It had no idea which
// of the app's screens "it" referred to, so it fell back to blind repo-wide
// ripgrep over `transitionTo(`, `onboardingBack`, and `tr.ts` keys — burning a
// minute of tool calls to rediscover a fact that was on the user's monitor the
// whole time.
//
// This is the same shape as every other defect in this codebase: the
// INVENTORY (the agent knew a preview session was live, knew the workDir, knew
// the framework) said yes, while the OPERATION (does the runner know which
// screen?) said no. The information existed one process away and died at the
// prompt boundary.
//
// ── What this file is ──────────────────────────────────────────────────────
//
// A last-known-screen registry, keyed by working directory, fed by a probe the
// agent injects into every HTML document it proxies for a preview
// (screen_context_probe.js → screen_context_inject.go). Reported by the
// authenticated surface, never by the anonymous preview itself, so a stranger
// on the LAN cannot dictate text into somebody's AI prompt.
//
// ── Deliberate non-goals ───────────────────────────────────────────────────
//
//   - NOT a screenshot. Text is ~1 KB instead of ~200 KB, it is greppable by
//     the runner, it survives a text-only transport, and it cannot leak a
//     password manager overlay or a background window. Frames already have a
//     home (vibe_preview_snapshot / browser_screenshot); this is the cheap
//     always-on channel.
//   - NOT input VALUES. The probe reads control LABELS and placeholders — both
//     authored by the app — and never `input.value`. On the very screen that
//     motivated this file the user was typing their own name into that field.
//   - NEVER Convex. This is work-derived content; the privacy contract forbids
//     it and convex_privacy_test.go enforces it.
package main

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// Hard caps. A prompt prefix that can grow without bound is a prompt prefix
// that will one day push the user's actual words out of the context window, so
// every field is clamped at the seam where it ENTERS the agent — not at the
// seam where it is rendered. Numbers chosen so a fully-populated context is
// ~1 KB and the absolute worst case stays under 4 KB.
const (
	maxScreenControls   = 25
	maxScreenLabelRunes = 80
	maxScreenTitleRunes = 120
	maxScreenRouteRunes = 200
	maxScreenBlockBytes = 4096
)

// screenContextTTL — how long a captured screen stays believable.
//
// Deliberately short. A stale screen context is WORSE than none: it points the
// runner confidently at a screen the user navigated away from ten minutes ago,
// which is the "inventory says yes / operation says no" failure wearing a
// friendly face. The probe re-posts on every route change and on a slow
// heartbeat, so a genuinely-open preview refreshes this well inside the window.
const screenContextTTL = 3 * time.Minute

// ScreenContext is one observation of one rendered screen.
//
// Every field is app-authored UI text or a route — deliberately no user input,
// no query string (the preview URL carries a `sig` token), and no origin.
type ScreenContext struct {
	// WorkDir is the project this screen belongs to. The registry key.
	WorkDir string `json:"workDir,omitempty"`
	// Route is the in-app path plus hash, with the agent's own `/dev/` proxy
	// prefix and the query string already stripped by the probe.
	Route string `json:"route,omitempty"`
	// Title is document.title.
	Title string `json:"title,omitempty"`
	// Heading is the first visible heading — the human name of the screen.
	Heading string `json:"heading,omitempty"`
	// Controls are visible interactive labels in DOM order: buttons, links,
	// tabs, and field labels/placeholders. Labels only, never values.
	Controls []string `json:"controls,omitempty"`
	// Component is a cheaply-available screen identifier (data-screen /
	// data-testid / data-component) when the app happens to publish one.
	Component string `json:"component,omitempty"`
	// Lane records HOW this was observed: "browser" (dashboard iframe) or
	// "webview" (mobile preview). Kept so a confusing context can be traced
	// back to the surface that reported it.
	Lane string `json:"lane,omitempty"`
	// CapturedAt is unix milliseconds, set by the agent on receipt — never
	// trusted from the client, whose clock may be anything at all.
	CapturedAt int64 `json:"capturedAt,omitempty"`
}

// IsEmpty reports whether there is nothing worth telling a runner. A context
// with only a route is still useful ("which screen"); one with nothing at all
// must never produce a prompt block, because an empty "[Screen…]" header reads
// as a fact and is not one.
func (sc ScreenContext) IsEmpty() bool {
	return sc.Route == "" && sc.Title == "" && sc.Heading == "" &&
		sc.Component == "" && len(sc.Controls) == 0
}

// truncateRunes clamps to n runes, appending an ellipsis when it cut. Rune-wise
// rather than byte-wise on purpose: this text is routinely Turkish ("Adın ne?",
// "İleri →"), Japanese, or emoji, and a byte slice through a multi-byte rune
// produces mojibake in the one place a human is reading for meaning.
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n <= 1 {
		return string(r[:n])
	}
	return string(r[:n-1]) + "…"
}

// collapseScreenText flattens a DOM text run to one clean line. Buttons
// routinely contain nested spans and newlines; a control label spanning three
// lines would wreck the single-line prompt block.
func collapseScreenText(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(s, " ", " ")), " ")
}

// NormalizeScreenContext is the ONLY door into the registry.
//
// It exists as a separate pure function so the caps are testable without an
// HTTP server, and so there is exactly one place that enforces them — a second
// , laxer path is how a "capped" field ends up uncapped in production.
func NormalizeScreenContext(in ScreenContext) ScreenContext {
	out := ScreenContext{
		WorkDir:    strings.TrimSpace(in.WorkDir),
		Route:      truncateRunes(collapseScreenText(in.Route), maxScreenRouteRunes),
		Title:      truncateRunes(collapseScreenText(in.Title), maxScreenTitleRunes),
		Heading:    truncateRunes(collapseScreenText(in.Heading), maxScreenTitleRunes),
		Component:  truncateRunes(collapseScreenText(in.Component), maxScreenLabelRunes),
		Lane:       strings.TrimSpace(in.Lane),
		CapturedAt: in.CapturedAt,
	}
	switch out.Lane {
	case "browser", "webview", "native":
	default:
		// An unrecognised lane is dropped rather than echoed. This string is
		// the one field a client could use to smuggle prose into the block.
		out.Lane = ""
	}

	seen := make(map[string]bool, len(in.Controls))
	for _, c := range in.Controls {
		label := truncateRunes(collapseScreenText(c), maxScreenLabelRunes)
		if label == "" {
			continue
		}
		// Dedupe case-insensitively: a list of 20 identical "Delete" buttons
		// from a table teaches the runner nothing and evicts the labels that
		// would have.
		key := strings.ToLower(label)
		if seen[key] {
			continue
		}
		seen[key] = true
		out.Controls = append(out.Controls, label)
		if len(out.Controls) >= maxScreenControls {
			break
		}
	}
	return out
}

// IsFresh reports whether this observation is still worth injecting.
func (sc ScreenContext) IsFresh(now time.Time) bool {
	if sc.CapturedAt <= 0 {
		return false
	}
	age := now.Sub(time.UnixMilli(sc.CapturedAt))
	return age >= 0 && age <= screenContextTTL
}

// FormatScreenContextBlock renders the prompt prefix, or "" when there is
// nothing honest to say.
//
// Shape rules, all of them load-bearing:
//
//   - It is FACTUAL. It states what is on screen and stops. It does not tell
//     the runner what to conclude, because the runner is better at that than a
//     format string and a wrong instruction is worse than a missing one.
//   - It is DELIMITED with the repo's existing sentinel convention so
//     stripPromptEcho can slice it out of a codex echo and it can never
//     surface as if the user had typed it.
//   - It NAMES ITSELF as attached-by-Yaver, so a runner reading a confusing
//     context knows where it came from and that the user did not write it.
func FormatScreenContextBlock(sc ScreenContext) string {
	if sc.IsEmpty() {
		return ""
	}
	var parts []string
	if sc.Route != "" {
		parts = append(parts, "route: "+sc.Route)
	}
	if sc.Heading != "" {
		parts = append(parts, "heading: "+sc.Heading)
	}
	// Title is redundant noise when it merely repeats the heading — very common
	// in SPAs that set document.title from the current screen.
	if sc.Title != "" && !strings.EqualFold(sc.Title, sc.Heading) {
		parts = append(parts, "title: "+sc.Title)
	}
	if sc.Component != "" {
		parts = append(parts, "component: "+sc.Component)
	}
	if len(sc.Controls) > 0 {
		parts = append(parts, "visible controls: "+strings.Join(sc.Controls, " · "))
	}

	var sb strings.Builder
	sb.WriteString("\n\n")
	sb.WriteString(promptEchoSentinel)
	sb.WriteString("\n[Screen the user is looking at — captured by Yaver from the live preview, not typed by the user]\n")
	for _, p := range parts {
		sb.WriteString(p)
		sb.WriteString("\n")
	}
	sb.WriteString("If the user says \"this screen\", \"it\", or names a control above, they mean THIS screen. Start from the source file that renders it.\n")
	sb.WriteString(promptEchoSentinel)
	sb.WriteString("\n")

	out := sb.String()
	if len(out) > maxScreenBlockBytes {
		// Belt-and-braces. Every field is already capped, so reaching here means
		// a cap regressed; truncating beats shipping an unbounded prefix.
		out = truncateRunes(out, maxScreenBlockBytes/4) + "\n"
	}
	return out
}

// screenContextStore is the agent's last-known-screen registry.
//
// In memory only, and that is the correct durability: a screen context that
// outlives the process describes a preview that certainly is not open anymore.
type screenContextStore struct {
	mu sync.RWMutex
	m  map[string]ScreenContext
}

// maxTrackedScreens bounds the map so a long-lived agent that previews many
// projects cannot grow it without limit. Small because a human is looking at
// one screen at a time.
const maxTrackedScreens = 32

func newScreenContextStore() *screenContextStore {
	return &screenContextStore{m: make(map[string]ScreenContext)}
}

// globalScreenContexts is the process-wide registry. One preview surface per
// human, so a single store rather than a per-session one keeps lookup at
// dispatch time to a map read on the workDir the task already carries.
var globalScreenContexts = newScreenContextStore()

// screenContextKey normalises the registry key. Trailing separators differ
// between the value a surface reports and the value a task carries, and a key
// mismatch here degrades silently to "no context" — the exact failure this
// whole file exists to remove.
func screenContextKey(workDir string) string {
	k := strings.TrimSpace(workDir)
	for len(k) > 1 && (strings.HasSuffix(k, "/") || strings.HasSuffix(k, "\\")) {
		k = k[:len(k)-1]
	}
	return k
}

// Put stores an observation, stamping CapturedAt from the agent's own clock.
func (s *screenContextStore) Put(sc ScreenContext, now time.Time) ScreenContext {
	sc = NormalizeScreenContext(sc)
	sc.CapturedAt = now.UnixMilli()
	key := screenContextKey(sc.WorkDir)
	if key == "" || sc.IsEmpty() {
		return ScreenContext{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Evict the oldest when full rather than refusing the write: the newest
	// observation is always the one a user is about to ask about.
	if len(s.m) >= maxTrackedScreens {
		if _, exists := s.m[key]; !exists {
			oldestKey, oldest := "", int64(0)
			for k, v := range s.m {
				if oldest == 0 || v.CapturedAt < oldest {
					oldestKey, oldest = k, v.CapturedAt
				}
			}
			delete(s.m, oldestKey)
		}
	}
	s.m[key] = sc
	return sc
}

// Get returns the last-known FRESH screen for a working directory. A stale
// entry returns (zero, false) and is dropped, so a caller can never be handed
// an old screen by accident.
func (s *screenContextStore) Get(workDir string, now time.Time) (ScreenContext, bool) {
	key := screenContextKey(workDir)
	if key == "" {
		return ScreenContext{}, false
	}
	s.mu.RLock()
	sc, ok := s.m[key]
	s.mu.RUnlock()
	if !ok {
		return ScreenContext{}, false
	}
	if !sc.IsFresh(now) {
		s.mu.Lock()
		if cur, still := s.m[key]; still && cur.CapturedAt == sc.CapturedAt {
			delete(s.m, key)
		}
		s.mu.Unlock()
		return ScreenContext{}, false
	}
	return sc, true
}

// Clear drops a project's entry — used when a preview stops, so the next
// prompt does not inherit a screen nobody is looking at.
func (s *screenContextStore) Clear(workDir string) {
	key := screenContextKey(workDir)
	if key == "" {
		return
	}
	s.mu.Lock()
	delete(s.m, key)
	s.mu.Unlock()
}

// Summary is the one-line description a surface shows the user so the
// attachment is never silent. Mirrors what the runner will actually receive.
func (sc ScreenContext) Summary() string {
	name := sc.Heading
	if name == "" {
		name = sc.Title
	}
	if name == "" {
		name = sc.Route
	}
	if name == "" {
		return ""
	}
	if len(sc.Controls) > 0 {
		return fmt.Sprintf("%s (%d control%s)", name, len(sc.Controls), pluralS(len(sc.Controls)))
	}
	return name
}
