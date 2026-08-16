package main

// vibe_preview.go — VibePreviewManager: live screenshot stream of a remote
// dev server, viewable from the mobile app while vibe-coding.
//
// Distinct from preview.go (PreviewManager), which deploys git-worktree
// branch previews on a chosen port. This subsystem captures the rendered
// output of an already-running dev server at FPS, so a phone-side modal
// can watch the UI change as the AI runner edits the codebase.
//
// Phase 1: in-memory ringbuffer, no HTTP exposure beyond start/stop/status,
// no summary pipeline. Frames are captured via BrowserManager.captureState
// and stored as raw PNG bytes; a stderr log line is emitted per capture so
// integration tests can verify the loop without parsing SSE.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"log"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ─── Profile ──────────────────────────────────────────────────────────────────

// VibePreviewProfile selects FPS / resolution / quality for a session.
// Resolution + quality are honoured in Phase 2 (JPEG transcode); Phase 1
// only acts on FPS.
type VibePreviewProfile struct {
	Name    string  `json:"name"`
	FPS     float64 `json:"fps"`
	Width   int     `json:"width"`
	Height  int     `json:"height"`
	Quality int     `json:"quality"`    // JPEG 1-100; 0 = keep PNG
	MaxKB   int     `json:"maxFrameKB"` // throttle target; 0 = unbounded
}

// vibePreviewProfiles is the set of named profiles. Selection rules in
// ProfileFor: explicit name wins; otherwise pick from the netMode hint;
// fall back to "live-relay-wifi".
var vibePreviewProfiles = map[string]VibePreviewProfile{
	"live-direct":     {Name: "live-direct", FPS: 8, Width: 1280, Height: 720, Quality: 75, MaxKB: 300},
	"live-relay-wifi": {Name: "live-relay-wifi", FPS: 4, Width: 1280, Height: 720, Quality: 60, MaxKB: 200},
	"live-relay-cell": {Name: "live-relay-cell", FPS: 2, Width: 854, Height: 480, Quality: 50, MaxKB: 80},
	"change-only":     {Name: "change-only", FPS: 0, Width: 1280, Height: 720, Quality: 70, MaxKB: 250},
	"summary-only":    {Name: "summary-only", FPS: 0, Width: 854, Height: 480, Quality: 55, MaxKB: 100},
}

// ProfileFor resolves a profile name + netMode hint to a concrete profile.
// netMode values: "direct", "relay-wifi", "relay-cell". Empty = wifi.
func ProfileFor(name, netMode string) VibePreviewProfile {
	if name != "" {
		if p, ok := vibePreviewProfiles[name]; ok {
			return p
		}
	}
	switch netMode {
	case "direct":
		return vibePreviewProfiles["live-direct"]
	case "relay-cell", "cellular", "cell":
		return vibePreviewProfiles["live-relay-cell"]
	default:
		return vibePreviewProfiles["live-relay-wifi"]
	}
}

// ─── Session + frame record ──────────────────────────────────────────────────

// VibePreviewMode controls capture cadence semantics.
//
//	live         — capture at profile.FPS continuously
//	change-only  — capture only when an external trigger fires (Phase 2+)
//	summary-only — capture only for before/after diffs (Phase 4+)
type VibePreviewMode string

const (
	VibePreviewModeLive        VibePreviewMode = "live"
	VibePreviewModeChangeOnly  VibePreviewMode = "change-only"
	VibePreviewModeSummaryOnly VibePreviewMode = "summary-only"
)

// VibePreviewSession is a single active preview, one per (project, target).
type VibePreviewSession struct {
	ID      string `json:"id"`
	Project string `json:"project"`
	// Surface that started this session, when it said so (X-Yaver-Surface or the
	// body field). Empty on older clients — the refusal then says "another
	// surface", which is honest, rather than inventing a holder.
	Surface    string             `json:"surface,omitempty"`
	TargetURL  string             `json:"targetUrl"`
	BrowserID  string             `json:"browserId"`
	WorkDir    string             `json:"workDir,omitempty"` // the project this preview belongs to; used by /vibing/preview/select to key the selected element
	Mode       VibePreviewMode    `json:"mode"`
	Profile    VibePreviewProfile `json:"profile"`
	StartedAt  time.Time          `json:"startedAt"`
	LastFrame  time.Time          `json:"lastFrame"`
	FrameCount uint64             `json:"frameCount"`
	StableHits uint64             `json:"stableHits"` // captures that hashed identical to prior
	Errors     uint64             `json:"errors"`

	// runtime
	cancel  context.CancelFunc
	stopped atomic.Bool
}

// vibeFrameRecord is one entry in the per-session ringbuffer.
// PNG bytes are kept in memory for the most-recent few frames so cold
// re-subscribers can serve a frame without disk I/O; older frames evict
// to disk-only and are read back on /frames/:hash GET.
type vibeFrameRecord struct {
	Seq         uint64
	Hash        string // first 12 hex of sha256(bytes)
	Bytes       []byte // PNG (chromedp default) — may be cleared after persist
	Width       int
	Height      int
	CapturedAt  time.Time
	diskPath    string // ~/.yaver/vibe-preview/<sessionId>/<hash>.png; "" = not persisted
	crashTagged bool   // set by OnCrashDetected — surfaced in /frames/<hash> headers
}

// ─── Manager ─────────────────────────────────────────────────────────────────

// vibePreviewRingCap is the per-session frame ringbuffer capacity.
const vibePreviewRingCap = 200

// vibePreviewSubBufSize is the per-subscriber channel buffer. 16 events of
// slack absorbs short bursts without dropping; beyond that, slow consumers
// lose frames (intentional — better than stalling capture).
const vibePreviewSubBufSize = 16

// VibeClipRecord is the Phase 2.5 clip metadata shape. Defined here as a
// forward-declared type so Phase 2 can hold a slice of clips per session
// without circular imports. The full lifecycle (record, store, serve)
// lives in vibe_preview_clip.go.
type VibeClipRecord struct {
	ID          string    `json:"id"`
	Project     string    `json:"project"`
	Source      string    `json:"source"` // browser|sim-ios|sim-android|phone
	StartedAt   time.Time `json:"startedAt"`
	EndedAt     time.Time `json:"endedAt,omitempty"`
	DurationSec float64   `json:"durationSec,omitempty"`
	SizeBytes   int64     `json:"sizeBytes,omitempty"`
	Status      string    `json:"status"`             // recording|ready|failed
	Path        string    `json:"-"`                  // on-disk MP4 path; never JSON-leaked
	PosterPath  string    `json:"-"`                  // on-disk poster JPG; never JSON-leaked
	ShareURL    string    `json:"shareUrl,omitempty"` // durable presigned URL (P4) when object storage is configured; outlives the box
	Err         string    `json:"err,omitempty"`
}

// vibePreviewBrowserGetter is the slice of BrowserManager that
// VibePreviewManager actually depends on. Lets tests inject a fake.
type vibePreviewBrowserGetter interface {
	OpenSession(id string, headful bool) error
	// OpenSessionWithViewport opens at a SPECIFIC window size.
	//
	// Added 2026-08-03 because Start's Width/Height were stored on the session
	// and echoed back to callers while the browser was opened at a hardcoded
	// 1280x900 — /vibing/preview/status said 1920x1080 and the PNG was
	// 1280x757. A capture at the wrong size makes every TV/visionOS/watch
	// verdict a statement about a layout no user of that surface ever sees.
	OpenSessionWithViewport(id string, headful bool, proxyURL, profileDir string, width, height int) error
	Navigate(id, url string) (*BrowserActionResult, error)
	Screenshot(id string) (*BrowserActionResult, error)
	CloseSession(id string) error
}

// vibePreviewEventHistory keeps the last N events per session for replay
// on SSE subscribe. Mirrors DevServer's behavior so a late web-dashboard
// reconnect sees what just happened.
const vibePreviewEventHistory = 50

// VibePreviewEvent flows on the /vibing/preview/events SSE channel. Type
// values are the public protocol — be careful changing them.
type VibePreviewEvent struct {
	Type      string  `json:"type"` // frame|stable|throttle|capture_error|started|stopped|clip_started|clip_ready|summary
	Project   string  `json:"project,omitempty"`
	Seq       uint64  `json:"seq,omitempty"`
	Hash      string  `json:"hash,omitempty"`
	Size      int     `json:"size,omitempty"`
	Width     int     `json:"width,omitempty"`
	Height    int     `json:"height,omitempty"`
	FPS       float64 `json:"fps,omitempty"`
	Mode      string  `json:"mode,omitempty"`
	ClipID    string  `json:"clipId,omitempty"`
	Source    string  `json:"source,omitempty"` // browser|sim-ios|sim-android|phone
	DurationS float64 `json:"durationSec,omitempty"`
	Message   string  `json:"message,omitempty"`
	Timestamp string  `json:"ts"` // RFC3339 UTC
}

// VibePreviewManager owns active sessions and their ringbuffers. One per
// agent process. Lifecycle is tied to HTTPServer.
type VibePreviewManager struct {
	mu       sync.Mutex
	sessions map[string]*VibePreviewSession
	ring     map[string][]*vibeFrameRecord // sessionID -> ringbuffer
	seqCtr   map[string]*uint64

	// SSE fan-out + replay buffer per session. Subscribers are channels
	// with non-blocking sends (select-default drop) so a slow consumer
	// can never stall the capture loop.
	subs     map[string][]chan VibePreviewEvent
	eventLog map[string][]VibePreviewEvent

	// Phase 2.5 — clip records keyed by project, populated by clip recorder.
	// Manager-owned so list/list-by-session queries don't need a second
	// layer of locking.
	clips map[string][]*VibeClipRecord

	browser vibePreviewBrowserGetter
	// nowFn lets tests freeze the clock.
	nowFn func() time.Time

	// diskRoot is where frame bytes + clips live. Empty = "~/.yaver/vibe-preview".
	// Tests inject a tempdir.
	diskRoot string

	// lastCrash dedups identical crash messages within a 1 s window.
	// Read + written under m.mu.
	lastCrash *VibeCrashSignal

	// summaryCtr is the seq number assigned to the next QueueSummary
	// call. Persisted in summaries.jsonl alongside the text.
	summaryCtr uint64

	// liveLoops counts capture goroutines that have started and not yet
	// returned, per project.
	//
	// It exists so "is the preview released yet?" can be ANSWERED rather than
	// waited out. Stop() removes the session from the map and closes the browser
	// synchronously, so `sessions` is empty the instant Stop returns — but the
	// capture goroutine may still be inside captureOnce, holding the browser
	// target that the NEXT surface is about to ask for. The all-surfaces e2e loop
	// papered over exactly that window with `await sleep(4000)`, which is both
	// slower than necessary and wrong under load.
	//
	// HEADLESS FIRST, from CLAUDE.md: a question you can only answer by waiting
	// is a missing endpoint. This counter is the measurement behind that endpoint.
	liveLoops map[string]int
}

// activeVibePreviewMgr is the process-wide singleton accessor. main.go's
// runServe sets it after constructing the HTTPServer; loop_exec.go reads
// it during the smart-develop-mode gate. Tests can swap it in/out via
// SetActiveVibePreviewManager.
//
// Package-level singleton instead of threading a reference through every
// LoopState because the manager is genuinely process-scoped (one Chrome
// browser pool per agent) and forwarding through every spec/state struct
// would be churn for no gain.
var activeVibePreviewMgr atomic.Value // stores *VibePreviewManager (or nil)

// SetActiveVibePreviewManager registers the global manager. Idempotent;
// last writer wins. Pass nil to clear.
func SetActiveVibePreviewManager(m *VibePreviewManager) {
	if m == nil {
		activeVibePreviewMgr.Store((*VibePreviewManager)(nil))
		return
	}
	activeVibePreviewMgr.Store(m)
}

// ActiveVibePreviewManager returns the registered manager or nil. Safe
// from any goroutine.
func ActiveVibePreviewManager() *VibePreviewManager {
	v, _ := activeVibePreviewMgr.Load().(*VibePreviewManager)
	return v
}

// NewVibePreviewManager returns a manager wired to the supplied
// BrowserManager. Pass nil for tests that don't need real captures —
// Start will return an error if browser is nil.
func NewVibePreviewManager(browser vibePreviewBrowserGetter) *VibePreviewManager {
	return &VibePreviewManager{
		sessions:  make(map[string]*VibePreviewSession),
		ring:      make(map[string][]*vibeFrameRecord),
		seqCtr:    make(map[string]*uint64),
		subs:      make(map[string][]chan VibePreviewEvent),
		eventLog:  make(map[string][]VibePreviewEvent),
		clips:     make(map[string][]*VibeClipRecord),
		liveLoops: make(map[string]int),
		browser:   browser,
		nowFn:     time.Now,
	}
}

// SetDiskRoot overrides the default disk root (~/.yaver/vibe-preview).
// Used by tests; callers should call before Start.
func (m *VibePreviewManager) SetDiskRoot(path string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.diskRoot = path
}

// resolveDiskRoot returns the on-disk root for frames + clips, mkdir-ing if
// missing. Empty diskRoot means "default to ~/.yaver/vibe-preview".
func (m *VibePreviewManager) resolveDiskRoot() string {
	m.mu.Lock()
	root := m.diskRoot
	m.mu.Unlock()
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = os.TempDir()
		}
		root = filepath.Join(home, ".yaver", "vibe-preview")
	}
	return root
}

// VibePreviewStartOpts is the input to Start.
type VibePreviewStartOpts struct {
	Project   string          `json:"project"`
	TargetURL string          `json:"targetUrl"`
	Mode      VibePreviewMode `json:"mode"`
	Profile   string          `json:"profile"` // explicit profile name
	NetMode   string          `json:"netMode"` // "direct" | "relay-wifi" | "relay-cell"
	// Width/Height override the profile's capture viewport when > 0, so a caller
	// can request a phone (390×844) or tablet (820×1180) render instead of the
	// profile's default. The TV surface uses this to preview a web app at a
	// chosen form factor. Zero means "use the profile".
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
	// Surface is who is asking — "tv", "vision", "mobile", "web". Read from the
	// X-Yaver-Surface header when the body omits it, which every native surface
	// already sends on every request (tvos/YaverTV/AgentClient.swift:623), so the
	// commonest collision (TV vs headset) names itself with no client change.
	// Recorded on the session purely so the NEXT surface's refusal can say who
	// holds the lock instead of "another surface".
	Surface string `json:"surface,omitempty"`
	// WorkDir/Framework are carried into the target-unreachable gap's /dev/start
	// body so the "Start the dev server" route is invocable without the surface
	// guessing which project to boot. Optional: when absent the route still
	// exists (auto-detect), but the pre-filled body is what makes it a button
	// rather than a form.
	WorkDir   string `json:"workDir,omitempty"`
	Framework string `json:"framework,omitempty"`
}

// Start boots a new preview session: opens a headless Chrome, navigates to
// targetUrl, and (for live mode) launches the capture loop.
//
// Returns an error if a session for the project already exists, the browser
// manager is missing, or the initial navigation fails. Caller is expected
// to surface errors verbatim — they're already user-readable.
func (m *VibePreviewManager) Start(opts VibePreviewStartOpts) (*VibePreviewSession, error) {
	if m == nil {
		return nil, fmt.Errorf("vibe-preview manager not initialised")
	}
	if m.browser == nil {
		// Typed for the same reason as the lock above: the 503 used to be picked
		// by matching this sentence. Routed to the shared capability-gap producer
		// at the HTTP layer, so "no browser" gets a streamed Install button.
		return nil, &PreviewBrowserUnavailableError{}
	}
	if opts.Project == "" {
		return nil, fmt.Errorf("project is required")
	}
	if opts.TargetURL == "" {
		return nil, fmt.Errorf("targetUrl is required (e.g. http://127.0.0.1:3000)")
	}
	if opts.Mode == "" {
		opts.Mode = VibePreviewModeLive
	}

	profile := ProfileFor(opts.Profile, opts.NetMode)
	// Caller-requested viewport wins over the profile's default (e.g. a TV asking
	// for a phone/tablet render). Bounded to sane pixels so a bad value can't ask
	// Chrome for a 100k-wide canvas.
	if opts.Width >= 200 && opts.Width <= 3840 {
		profile.Width = opts.Width
	}
	if opts.Height >= 200 && opts.Height <= 2160 {
		profile.Height = opts.Height
	}

	// One session per project — caller must Stop before re-Starting.
	//
	// TYPED, not a sentence: the HTTP layer used to prose-match this very string
	// to choose a status code, and the surfaces rendered a "Try again" that could
	// not succeed while the lock was held. The error carries the holding session
	// so the refusal can become a takeover route (vibe_preview_takeover.go).
	m.mu.Lock()
	if existing, exists := m.sessions[opts.Project]; exists {
		held := cloneSession(existing)
		m.mu.Unlock()
		return nil, &PreviewSessionActiveError{Project: opts.Project, Active: held}
	}
	m.mu.Unlock()

	now := m.nowFn()
	browserID := fmt.Sprintf("vibe-preview-%s-%d", sanitizeBranchName(opts.Project), now.UnixNano()%1_000_000)

	// Pre-probe the targetUrl BEFORE opening Chrome. A missing dev server
	// otherwise costs a browser session + a navigate that fails seconds later
	// with a bare chromedp sentence — and, worse, the failure was previously
	// returned as a raw error with no code and no route, so the panel showed
	// "navigate to http://127.0.0.1:3000: ... net::ERR_CONNECTION_REFUSED" with
	// no button. Probe the operation (can I connect?) instead of the inventory
	// (is a dev server "configured"?), so a connect-green-but-vibe-dead box is
	// refused in milliseconds with a named cause and a /dev/start route.
	if probeErr := m.probeTargetURL(opts.TargetURL); probeErr != nil {
		return nil, &PreviewTargetUnreachableError{
			TargetURL: opts.TargetURL,
			Project:   opts.Project,
			WorkDir:   opts.WorkDir,
			Framework: opts.Framework,
		}
	}

	// Open at the profile's size, not at whatever the browser layer defaults to
	// — the caller's requested viewport is the whole point of the profile, and
	// reporting it without applying it is a false green (see the interface note
	// on OpenSessionWithViewport).
	if err := m.browser.OpenSessionWithViewport(browserID, false, "", "", profile.Width, profile.Height); err != nil {
		return nil, fmt.Errorf("open browser: %w", err)
	}
	if _, err := m.browser.Navigate(browserID, opts.TargetURL); err != nil {
		_ = m.browser.CloseSession(browserID)
		// The pre-probe already caught a refused port, but the navigate can
		// still hit a refused connection (e.g. the dev server died between the
		// probe and the navigation, or the address is a hostname that resolves
		// to a non-listening port). Classify connection refusals as the same
		// named cause so no surface ever sees the raw chromedp sentence.
		if looksLikeConnectionRefused(err) {
			return nil, &PreviewTargetUnreachableError{
				TargetURL: opts.TargetURL,
				Project:   opts.Project,
				WorkDir:   opts.WorkDir,
				Framework: opts.Framework,
			}
		}
		return nil, fmt.Errorf("navigate to %s: %w", opts.TargetURL, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	var seq uint64
	sess := &VibePreviewSession{
		ID:        browserID,
		Project:   opts.Project,
		Surface:   opts.Surface,
		TargetURL: opts.TargetURL,
		BrowserID: browserID,
		WorkDir:   opts.WorkDir,
		Mode:      opts.Mode,
		Profile:   profile,
		StartedAt: now,
		LastFrame: now,
		cancel:    cancel,
	}

	m.mu.Lock()
	m.sessions[opts.Project] = sess
	m.ring[opts.Project] = make([]*vibeFrameRecord, 0, vibePreviewRingCap)
	m.seqCtr[opts.Project] = &seq
	m.mu.Unlock()

	// Emit lifecycle event before any capture so subscribers see a clean
	// {started → frame → ...} sequence.
	m.emit(opts.Project, VibePreviewEvent{
		Type:    "started",
		Project: opts.Project,
		Mode:    string(opts.Mode),
		FPS:     profile.FPS,
		Width:   profile.Width,
		Height:  profile.Height,
	})

	// Live mode: drive the capture loop.
	// Other modes still capture an initial frame so callers see something.
	if _, err := m.captureOnce(opts.Project); err != nil {
		log.Printf("[vibe-preview] initial capture failed: %v", err)
	}
	if opts.Mode == VibePreviewModeLive && profile.FPS > 0 {
		go m.runCaptureLoop(ctx, opts.Project, profile.FPS)
	}

	return cloneSession(sess), nil
}

// probeTargetURL makes a bounded TCP connect to the targetUrl's host:port and
// reports whether anything is listening. This is the "probe the operation, not
// the inventory" half of the target-unreachable fix: the device card's
// "Connected" only means the AGENT answers — it says nothing about a dev server
// serving on the preview port. A refused connect here means the preview cannot
// capture, and the refusal carries a /dev/start route instead of a Chrome
// sentence.
//
// The probe is deliberately TCP-only (no HTTP round trip): a dev server that
// accepts connections but is still compiling should not be refused, and an
// HTTP-only probe would race a booting server. If the URL is malformed, the
// probe reports unreachable (the caller's refusal names the URL either way).
func (m *VibePreviewManager) probeTargetURL(targetURL string) error {
	u, err := url.Parse(strings.TrimSpace(targetURL))
	if err != nil {
		return fmt.Errorf("unparseable targetUrl %q", targetURL)
	}
	host := u.Hostname()
	port := u.Port()
	if host == "" {
		return fmt.Errorf("targetUrl %q has no host", targetURL)
	}
	if port == "" {
		switch strings.ToLower(u.Scheme) {
		case "https":
			port = "443"
		case "http":
			port = "80"
		default:
			return fmt.Errorf("targetUrl %q has no port and no known scheme", targetURL)
		}
	}
	// Hostnames like "localhost" may resolve to ::1; try the literal host then
	// the bracketed IPv6 form. Bounded: a dev server that is up answers a TCP
	// handshake in single-digit ms; 750ms is generous for a busy box without
	// stalling the refusal path.
	addr := net.JoinHostPort(host, port)
	conn, err := net.DialTimeout("tcp", addr, 750*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		return nil
	}
	// Fallback: an IPv6 literal in the hostname (e.g. "[::1]:3000" was already
	// handled by JoinHostPort, but a bare "::1" host from a URL like
	// "http://[::1]:3000" is what url.Parse yields) — net.DialTimeout handles
	// the bracket form directly, so the first dial already covered it. Keep the
	// error: the refusal names the URL, not the dial detail.
	return fmt.Errorf("connect to %s: %w", addr, err)
}

// looksLikeConnectionRefused classifies a chromedp navigation error as "the
// address refused to accept a connection" — the signal for
// PreviewTargetUnreachableError. We match the stable substrings chromedp and
// the Chrome devtools protocol emit (net::ERR_CONNECTION_REFUSED,
// ECONNREFUSED), never a full sentence, so a Chrome version bump cannot break
// the classifier.
func looksLikeConnectionRefused(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	for _, needle := range []string{
		"ERR_CONNECTION_REFUSED",
		"ERR_CONNECTION_RESET",
		"ECONNREFUSED",
		"connect: connection refused",
		"failed to connect",
	} {
		if strings.Contains(msg, needle) {
			return true
		}
	}
	return false
}

// targetHostPort extracts host:port from a targetUrl for the unreachable gap's
// summary. Best-effort; returns the raw string when parsing fails.
func targetHostPort(targetURL string) string {
	u, err := url.Parse(strings.TrimSpace(targetURL))
	if err != nil || u.Host == "" {
		return targetURL
	}
	if u.Port() != "" {
		return u.Host
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return net.JoinHostPort(u.Hostname(), "443")
	case "http":
		return net.JoinHostPort(u.Hostname(), "80")
	}
	return u.Host
}

// Stop tears down a session by project name. Idempotent: missing project
// returns a typed error; double-stop is a no-op on the second call.
func (m *VibePreviewManager) Stop(project string) error {
	if m == nil {
		return fmt.Errorf("vibe-preview manager not initialised")
	}
	m.mu.Lock()
	sess, ok := m.sessions[project]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("no preview session for project %q", project)
	}
	delete(m.sessions, project)
	delete(m.ring, project)
	delete(m.seqCtr, project)
	m.mu.Unlock()

	if !sess.stopped.Swap(true) {
		if sess.cancel != nil {
			sess.cancel()
		}
		if m.browser != nil && sess.BrowserID != "" {
			if err := m.browser.CloseSession(sess.BrowserID); err != nil {
				// Browser may have already gone away; warn but don't fail.
				log.Printf("[vibe-preview] close browser %s: %v", sess.BrowserID, err)
			}
		}
	}
	m.emit(project, VibePreviewEvent{Type: "stopped", Project: project})
	// Tear down subscribers — late SSE clients reconnecting will get a
	// 404 / empty event log and know the session is over.
	m.mu.Lock()
	for _, ch := range m.subs[project] {
		close(ch)
	}
	delete(m.subs, project)
	delete(m.eventLog, project)
	m.mu.Unlock()
	return nil
}

// Status returns a snapshot copy of every active session. Safe for handlers
// to JSON-encode directly.
func (m *VibePreviewManager) Status() []*VibePreviewSession {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*VibePreviewSession, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, cloneSession(s))
	}
	return out
}

// Snapshot forces a one-shot capture for an existing session. Used by the
// /vibing/preview/snapshot endpoint and by the change-only/summary-only hooks.
func (m *VibePreviewManager) Snapshot(project string) (*vibeFrameRecord, error) {
	return m.captureOnce(project)
}

// LatestFrame returns the most recent frame for a project, or nil if none.
// The returned record is a shallow copy — callers must not mutate Bytes.
func (m *VibePreviewManager) LatestFrame(project string) *vibeFrameRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	ring := m.ring[project]
	if len(ring) == 0 {
		return nil
	}
	return ring[len(ring)-1]
}

// PreviewSelectMeta is the surface-side metadata the agent returns alongside a
// DOM selection so the client (tvOS cursor, remote runtime, web overlay) can
// map display coordinates to viewport coordinates WITHOUT guessing:
//
//	Viewport  — the box's requested capture size (the session profile).
//	FrameSize — the ACTUAL pixel size of the latest captured frame, decoded
//	            from the PNG once per select. The two differ whenever the
//	            browser rendered at a real size that diverged from the
//	            requested profile (letterboxing, device-pixel-ratio, a frame
//	            captured before the viewport applied). The client scales its
//	            cursor by frameSize, not by the viewport it happens to know.
type PreviewSelectMeta struct {
	Project   string `json:"project"`
	ViewportW int    `json:"viewportW"`
	ViewportH int    `json:"viewportH"`
	FrameW    int    `json:"frameW,omitempty"`
	FrameH    int    `json:"frameH,omitempty"`
}

// SelectMeta assembles the metadata for a selection on a project. Bounded: one
// PNG header decode (image.DecodeConfig reads only the header, not the pixels),
// so the cost is one header parse per select — not per frame, and never on the
// capture hot path.
func (m *VibePreviewManager) SelectMeta(project string) PreviewSelectMeta {
	m.mu.Lock()
	sess, ok := m.sessions[project]
	var vw, vh int
	if ok {
		vw, vh = sess.Profile.Width, sess.Profile.Height
	}
	m.mu.Unlock()

	meta := PreviewSelectMeta{Project: project, ViewportW: vw, ViewportH: vh}
	if !ok {
		return meta
	}
	rec := m.LatestFrame(project)
	if rec == nil || len(rec.Bytes) == 0 {
		return meta
	}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(rec.Bytes)); err == nil {
		meta.FrameW, meta.FrameH = cfg.Width, cfg.Height
	}
	return meta
}

// FrameByHash returns a frame matching the given hash prefix, or nil.
// O(N) over the ringbuffer; fine for ring caps in the hundreds.
func (m *VibePreviewManager) FrameByHash(project, hash string) *vibeFrameRecord {
	if hash == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, f := range m.ring[project] {
		if f.Hash == hash {
			return f
		}
	}
	return nil
}

// Stop all sessions. Called on agent shutdown.
func (m *VibePreviewManager) StopAll() {
	if m == nil {
		return
	}
	m.mu.Lock()
	projects := make([]string, 0, len(m.sessions))
	for p := range m.sessions {
		projects = append(projects, p)
	}
	m.mu.Unlock()
	for _, p := range projects {
		_ = m.Stop(p)
	}
}

// vibePreviewInputBrowser is the slice of BrowserManager a select needs on top
// of the capture getter: dispatch a REAL mouse move/click at viewport
// coordinates and evaluate JS in the page. Optional — a manager whose browser
// cannot do input (a fake, an old browser layer) reports the gap by name
// instead of pretending to select.
type vibePreviewInputBrowser interface {
	Evaluate(id, js string) (interface{}, error)
	DispatchMouse(id string, x, y int, click bool) error
}

// SelectElement is the tvOS "mouse-like" DOM selection: the TV draws a cursor
// over the captured frame and sends a viewport coordinate; the box turns that
// coordinate into a real click in the headless Chrome that produced the frame,
// captures the clicked element (html/css/rect/screenshot — the same payload the
// in-page DOM probe builds), and registers it in the shared domInspectStore so
// the per-turn hook attaches it to the next prompt. "Deep audit this element"
// from the couch works because the runner receives the element, not a grep
// request.
//
// workDir fallback order: explicit argument, then the session's own WorkDir
// (set from /vibing/preview/start). Empty after both means "no project" — the
// selection cannot be keyed, so it is refused, because an element stored under
// the wrong (or no) project would leak into every prompt.
func (m *VibePreviewManager) SelectElement(project string, x, y int, workDir string, now time.Time) (DomElement, error) {
	if m == nil {
		return DomElement{}, fmt.Errorf("vibe-preview manager not initialised")
	}
	if x < 0 || y < 0 {
		return DomElement{}, fmt.Errorf("coordinates must be non-negative")
	}
	m.mu.Lock()
	sess, ok := m.sessions[project]
	m.mu.Unlock()
	if !ok {
		return DomElement{}, fmt.Errorf("no preview session for project %q", project)
	}
	if workDir == "" {
		workDir = sess.WorkDir
	}
	if strings.TrimSpace(workDir) == "" {
		return DomElement{}, fmt.Errorf("select needs a workDir — pass it or start the preview with one")
	}

	in, ok := m.browser.(vibePreviewInputBrowser)
	if !ok {
		return DomElement{}, fmt.Errorf("this browser cannot dispatch input (no Evaluate/DispatchMouse)")
	}

	// The click is the OPERATION, the capture is the measurement. A click that
	// fails (browser went away mid-preview) means the selection is a lie — fail
	// rather than report an element nobody actually clicked. But the click is
	// dispatched with no wait between press/release; the page reacts in its own
	// time and elementFromPoint does not need the click to have landed.
	if err := in.DispatchMouse(sess.BrowserID, x, y, true); err != nil {
		return DomElement{}, fmt.Errorf("dispatch click at %d,%d: %w", x, y, err)
	}

	// Capture the element at the clicked point — the server-side twin of the
	// probe's capture(); same caps, same selector path, same CSS subset. The
	// script is self-contained (no page-global state), so it works even on a
	// page where the probe was never injected.
	raw, err := in.Evaluate(sess.BrowserID, domCaptureScript(x, y))
	if err != nil {
		return DomElement{}, fmt.Errorf("capture element at %d,%d: %w", x, y, err)
	}
	var capRes struct {
		OK  bool   `json:"ok"`
		Err string `json:"error"`
		El  struct {
			Selector string `json:"selector"`
			Tag      string `json:"tag"`
			ID       string `json:"id"`
			Classes  string `json:"classes"`
			Text     string `json:"text"`
			HTML     string `json:"html"`
			CSS      string `json:"css"`
			Rect     string `json:"rect"`
		} `json:"el"`
	}
	if err := remarshalJSON(raw, &capRes); err != nil {
		return DomElement{}, fmt.Errorf("decode element capture: %w", err)
	}
	if !capRes.OK {
		return DomElement{}, fmt.Errorf("capture reported: %s", capRes.Err)
	}

	// The screenshot is best-effort garnish, exactly as on every other
	// surface: an async canvas render that cannot complete inside the
	// Evaluate budget must not fail the selection. The HTML + CSS is the
	// payload.
	shot, _ := in.Evaluate(sess.BrowserID, domShotScript(x, y))
	shotStr, _ := shot.(string)

	d := NormalizeDomElement(DomElement{
		WorkDir:  workDir,
		Selector: capRes.El.Selector,
		Tag:      capRes.El.Tag,
		ID:       capRes.El.ID,
		Classes:  capRes.El.Classes,
		Text:     capRes.El.Text,
		HTML:     capRes.El.HTML,
		CSS:      capRes.El.CSS,
		Rect:     capRes.El.Rect,
		Shot:     shotStr,
		Lane:     "browser",
	})
	if d.IsEmpty() {
		return DomElement{}, fmt.Errorf("captured element is empty at %d,%d", x, y)
	}
	stored := globalDomElements.Put(d, now)
	return stored, nil
}

// MoveCursor dispatches a mouse-MOVE (no click) at viewport coordinates —
// the live hover half of the tvOS cursor. While DOM mode is on, the probe
// paints its highlight on whatever the box's mouse is over, so each swipe of
// the Siri Remote touchpad makes the NEXT captured frame show the highlight
// tracking the cursor. Deliberately stores NOTHING: a hover is not a
// selection, and a hovered-but-never-clicked element must never ride a prompt.
// The tap is what calls SelectElement.
func (m *VibePreviewManager) MoveCursor(project string, x, y int) error {
	if m == nil {
		return fmt.Errorf("vibe-preview manager not initialised")
	}
	if x < 0 || y < 0 {
		return fmt.Errorf("coordinates must be non-negative")
	}
	m.mu.Lock()
	sess, ok := m.sessions[project]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("no preview session for project %q", project)
	}
	in, ok := m.browser.(vibePreviewInputBrowser)
	if !ok {
		return fmt.Errorf("this browser cannot dispatch input")
	}
	if err := in.DispatchMouse(sess.BrowserID, x, y, false); err != nil {
		return fmt.Errorf("dispatch mouse move at %d,%d: %w", x, y, err)
	}
	return nil
}

// SetDomMode enables or disables DOM mode IN THE CAPTURED PAGE.// tvOS has no WebKit: the probe lives in the box's headless Chrome, so
// "toggle DOM mode" means posting the same {source:"yaver-dom",
// t:"yaver-dom-mode"} command the web/mobile surfaces post into their
// iframes/WebViews. While enabled, the probe's hover overlay paints on
// whatever the box's mouse passes over — so the TV's next captured frame shows
// the highlight tracking the Siri Remote cursor. Disabling also clears the
// stored element for the project's workDir — the "off means the agent holds
// nothing" contract every surface shares (the web surface deletes via
// DELETE /dom-inspect on Browse; this is the tvOS equivalent).
//
// Returns the workDir the mode was scoped to (explicit argument, else the
// session's own) so the surface can clear its local "Inspect" state in sync.
func (m *VibePreviewManager) SetDomMode(project string, enabled bool, workDir string) (string, error) {
	if m == nil {
		return "", fmt.Errorf("vibe-preview manager not initialised")
	}
	m.mu.Lock()
	sess, ok := m.sessions[project]
	m.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("no preview session for project %q", project)
	}
	if workDir == "" {
		workDir = sess.WorkDir
	}
	in, ok := m.browser.(vibePreviewInputBrowser)
	if !ok {
		return "", fmt.Errorf("this browser cannot dispatch input")
	}
	js := fmt.Sprintf(`window.postMessage({source:"yaver-dom", t:"yaver-dom-mode", enabled:%t}, "*"); true`, enabled)
	if _, err := in.Evaluate(sess.BrowserID, js); err != nil {
		return "", fmt.Errorf("set dom mode %t: %w", enabled, err)
	}
	if !enabled && strings.TrimSpace(workDir) != "" {
		globalDomElements.Clear(workDir)
		globalDomItems.Clear(workDir)
	}
	return workDir, nil
}

// remarshalJSON round-trips an Evaluate result through JSON so the typed
// struct decode is the ONLY interpretation of the page's answer. The capture
// scripts JSON.stringify their payload, so chromedp delivers a Go string whose
// VALUE is the JSON — that case must be decoded directly, not re-marshalled
// (which would wrap it in quotes and fail the struct decode).
func remarshalJSON(raw interface{}, out interface{}) error {
	if s, ok := raw.(string); ok {
		return json.Unmarshal([]byte(s), out)
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

// domCaptureScript returns a self-contained, never-throwing, synchronous
// script that captures the element at viewport (x,y) — elementFromPoint →
// selector path / text / outerHTML / computed-CSS subset / rect, all clamped
// to the same caps the in-page probe enforces (dom_inspect_probe.js). Returns
// a JSON string the agent decodes. No input.value is ever read.
func domCaptureScript(x, y int) string {
	return fmt.Sprintf(`(function(){
  function clamp(s,n){ s = String(s==null?"":s); return s.length>n ? s.slice(0,n) : s; }
  function txt(el){ try { var t=(el.innerText||el.textContent||""); return clamp(t.replace(/\s+/g," ").replace(/^ | $/g,""), 400); } catch(e){ return ""; } }
  function sel(el){ try {
    var parts=[], node=el, guard=0;
    while(node && node.nodeType===1 && guard<6){
      var step=String(node.tagName||"").toLowerCase(); if(!step) break;
      if(node.id) step+="#"+node.id;
      else if(node.className && typeof node.className==="string"){ var f=node.className.split(/\s+/)[0]; if(f) step+="."+f; }
      parts.unshift(step); if(node.id) break; node=node.parentNode; guard++;
    }
    return clamp(parts.join(" > "), 200);
  } catch(e){ return ""; } }
  var PROPS=("display,position,float,top,right,bottom,left,zIndex,width,minWidth,maxWidth,height,minHeight,maxHeight,"+
    "marginTop,marginRight,marginBottom,marginLeft,paddingTop,paddingRight,paddingBottom,paddingLeft,"+
    "flex,flexDirection,flexWrap,alignItems,alignContent,justifyContent,gap,rowGap,columnGap,order,flexGrow,flexShrink,"+
    "backgroundColor,backgroundImage,backgroundSize,backgroundPosition,backgroundRepeat,color,opacity,"+
    "borderTopWidth,borderRightWidth,borderBottomWidth,borderLeftWidth,borderTopStyle,borderTopColor,borderRadius,"+
    "boxShadow,outline,outlineOffset,fontFamily,fontSize,fontWeight,fontStyle,lineHeight,letterSpacing,textAlign,"+
    "textDecoration,textTransform,whiteSpace,wordBreak,overflow,overflowX,overflowY,visibility,transform,"+
    "transition,animation,boxSizing,cursor,pointerEvents,userSelect,aspectRatio,objectFit").split(",");
  function css(el){ try {
    var cs=window.getComputedStyle(el); if(!cs) return "";
    var out=[], len=0;
    for(var i=0;i<PROPS.length;i++){ try {
      var v=cs.getPropertyValue(PROPS[i]);
      if(v && v!=="auto" && v!=="none" && v!=="0px" && v!=="normal" && v!=="0"){ var bit=PROPS[i]+": "+v; len+=bit.length+2; if(len>16000) break; out.push(bit); }
    } catch(e){} }
    return clamp(out.join("; "), 16000);
  } catch(e){ return ""; } }
  try {
    var el = document.elementFromPoint(%[1]d, %[2]d);
    if(!el) return JSON.stringify({ok:false, error:"no element at %[1]d,%[2]d"});
    if(el.getAttribute && el.getAttribute("data-yaver-dom-overlay")==="1") return JSON.stringify({ok:false, error:"overlay"});
    var r = el.getBoundingClientRect();
    return JSON.stringify({ok:true, el:{
      selector: sel(el),
      tag: String(el.tagName||"").toLowerCase(),
      id: clamp(el.id||"",120),
      classes: clamp(typeof el.className==="string"?el.className:"",240),
      text: txt(el),
      html: clamp(el.outerHTML||"",24000),
      css: css(el),
      rect: "x:"+Math.round(r.x||r.left)+" y:"+Math.round(r.y||r.top)+" w:"+Math.round(r.width)+" h:"+Math.round(r.height)
    }});
  } catch(e){ return JSON.stringify({ok:false, error:String(e&&e.message||e)}); }
})()`, x, y)
}

// domShotScript returns a promise-resolving, best-effort cropped-JPEG capture
// of the element at (x,y) — the foreignObject-clone twin of the probe's
// captureShot. Bounded by a hard 800 ms timeout so an unloadable image can
// never hang the CDP Evaluate. Returns "" (resolves empty string) on any
// failure; the caller treats it as garnish, never a gate.
func domShotScript(x, y int) string {
	return fmt.Sprintf(`(function(){
  return new Promise(function(resolve){
    var done=false;
    function finish(v){ if(done) return; done=true; resolve(v||""); }
    try {
      var el = document.elementFromPoint(%[1]d, %[2]d);
      if(!el || (el.getAttribute && el.getAttribute("data-yaver-dom-overlay")==="1")) return finish("");
      var r = el.getBoundingClientRect();
      var w=Math.max(1,Math.round(r.width)), h=Math.max(1,Math.round(r.height));
      var scale=1; if(w>240||h>240) scale=240/Math.max(w,h);
      var cw=Math.max(1,Math.round(w*scale)), ch=Math.max(1,Math.round(h*scale));
      var clone=el.cloneNode(true);
      var live=[el], nodes=clone.getElementsByTagName("*"), all=[];
      for(var i=0;i<nodes.length&&i<400;i++) all.push(nodes[i]);
      var guard=0;
      while(live.length&&guard<all.length){ var src=live.shift(), dst=all[guard]; guard++;
        try { var cs=window.getComputedStyle(src); for(var p=0;p<cs.length&&p<300;p++){ var prop=cs[p], val=cs.getPropertyValue(prop); if(val) dst.style.setProperty(prop,val); } } catch(e){}
      }
      var xhtml="http://www.w3.org/1999/xhtml", svgNS="http://www.w3.org/2000/svg";
      var wrap=document.createElementNS(xhtml,"div"); wrap.appendChild(clone);
      var xml=new XMLSerializer().serializeToString(wrap);
      var svg='<svg xmlns="'+svgNS+'" width="'+cw+'" height="'+ch+'"><foreignObject width="100%%" height="100%%">'+xml+"</foreignObject></svg>";
      var canvas=document.createElement("canvas"); canvas.width=cw; canvas.height=ch;
      var ctx=canvas.getContext("2d"); if(!ctx) return finish("");
      var img=new Image();
      var t=setTimeout(function(){ finish(""); }, 800);
      img.onload=function(){ try { clearTimeout(t); ctx.clearRect(0,0,cw,ch); ctx.drawImage(img,0,0,cw,ch); var u=canvas.toDataURL("image/jpeg",0.8); finish(u.length>16000?"":u); } catch(e){ finish(""); } };
      img.onerror=function(){ clearTimeout(t); finish(""); };
      img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);
    } catch(e){ finish(""); }
  });
})()`, x, y)
}

// ─── Internal: capture loop ──────────────────────────────────────────────────

// runCaptureLoop ticks at fps Hz and captures frames until ctx is cancelled.
// Errors are logged + counted on the session but do not abort the loop —
// the dev server may have hiccuped and will recover.
func (m *VibePreviewManager) runCaptureLoop(ctx context.Context, project string, fps float64) {
	if fps <= 0 {
		return
	}
	// Register BEFORE the first tick and release on every exit path, so
	// PreviewRelease can report the truth rather than a guess. The increment
	// happens inside the goroutine on purpose: a counter bumped by the caller
	// and decremented by the goroutine is a leak the first time an fps<=0 loop
	// returns early, which is precisely the shape above.
	m.mu.Lock()
	m.liveLoops[project]++
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		if m.liveLoops[project] <= 1 {
			delete(m.liveLoops, project)
		} else {
			m.liveLoops[project]--
		}
		m.mu.Unlock()
	}()
	interval := time.Duration(float64(time.Second) / fps)
	if interval < 50*time.Millisecond {
		interval = 50 * time.Millisecond // hard floor 20 FPS
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := m.captureOnce(project); err != nil {
				m.bumpErrors(project)
				log.Printf("[vibe-preview] %s: capture failed: %v", project, err)
				// Backoff a little on consecutive errors.
				time.Sleep(500 * time.Millisecond)
			}
		}
	}
}

// captureOnce takes one screenshot via the browser manager, hashes it, and
// pushes onto the ringbuffer. Returns the new record, or nil + error.
func (m *VibePreviewManager) captureOnce(project string) (*vibeFrameRecord, error) {
	m.mu.Lock()
	sess, ok := m.sessions[project]
	if !ok {
		m.mu.Unlock()
		return nil, fmt.Errorf("no session for project %q", project)
	}
	browserID := sess.BrowserID
	m.mu.Unlock()

	if m.browser == nil {
		return nil, fmt.Errorf("browser unavailable")
	}
	res, err := m.browser.Screenshot(browserID)
	if err != nil {
		return nil, err
	}
	raw, err := base64.StdEncoding.DecodeString(res.ScreenshotB64)
	if err != nil {
		return nil, fmt.Errorf("decode screenshot: %w", err)
	}

	sum := sha256.Sum256(raw)
	hash := hex.EncodeToString(sum[:])[:12]

	rec := &vibeFrameRecord{
		Hash:       hash,
		Bytes:      raw,
		CapturedAt: m.nowFn(),
	}

	// Persist to disk *outside* the lock — disk I/O can block. Failures
	// are logged but don't drop the in-memory record; the relay-side
	// fetch will fall back to bytes if the file is missing.
	if path, err := m.persistFrame(project, rec); err != nil {
		log.Printf("[vibe-preview] persist %s/%s: %v", project, hash, err)
	} else {
		rec.diskPath = path
	}

	m.mu.Lock()
	// Session may have been stopped while we held the screenshot above.
	sess, ok = m.sessions[project]
	if !ok {
		m.mu.Unlock()
		return nil, fmt.Errorf("session %q ended during capture", project)
	}
	ctr := m.seqCtr[project]
	*ctr++
	rec.Seq = *ctr

	// Stable-frame collapse: identical hash to the most recent frame is
	// not stored a second time, but we still emit a "stable" event so
	// the consumer can update FPS/heartbeat state.
	ring := m.ring[project]
	if len(ring) > 0 && ring[len(ring)-1].Hash == hash {
		sess.StableHits++
		stableSeq := rec.Seq
		m.mu.Unlock()
		log.Printf("[vibe-preview] %s seq=%d hash=%s STABLE (no change)", project, stableSeq, hash)
		m.emit(project, VibePreviewEvent{
			Type:    "stable",
			Project: project,
			Seq:     stableSeq,
			Hash:    hash,
		})
		return ring[len(ring)-1], nil
	}

	var evicted *vibeFrameRecord
	if len(ring) >= vibePreviewRingCap {
		evicted = ring[0]
		ring = ring[1:]
	}
	ring = append(ring, rec)
	m.ring[project] = ring

	sess.FrameCount++
	sess.LastFrame = rec.CapturedAt
	emitSeq := rec.Seq
	emitSize := len(raw)
	m.mu.Unlock()

	// Disk delete + emit happen after lock release — both can block.
	if evicted != nil {
		_ = m.removeDiskFrame(project, evicted)
	}

	log.Printf("[vibe-preview] %s seq=%d hash=%s bytes=%d", project, emitSeq, hash, emitSize)
	m.emit(project, VibePreviewEvent{
		Type:    "frame",
		Project: project,
		Seq:     emitSeq,
		Hash:    hash,
		Size:    emitSize,
	})
	return rec, nil
}

func (m *VibePreviewManager) bumpErrors(project string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[project]; s != nil {
		s.Errors++
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Disk persistence ─────────────────────────────────────────────────────────

// persistFrame writes the frame bytes to disk and returns the path.
// Idempotent: if the hashed file already exists, returns the existing path
// without rewriting. Caller does not need to hold the manager lock.
func (m *VibePreviewManager) persistFrame(project string, rec *vibeFrameRecord) (string, error) {
	if rec == nil || len(rec.Bytes) == 0 {
		return "", nil
	}
	dir := filepath.Join(m.resolveDiskRoot(), sanitizeBranchName(project))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, rec.Hash+".png")
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	if err := os.WriteFile(path, rec.Bytes, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// removeDiskFrame deletes the on-disk artifact for an evicted record.
// Best-effort: errors are logged but not surfaced.
func (m *VibePreviewManager) removeDiskFrame(project string, rec *vibeFrameRecord) error {
	if rec == nil || rec.diskPath == "" {
		return nil
	}
	if err := os.Remove(rec.diskPath); err != nil && !os.IsNotExist(err) {
		log.Printf("[vibe-preview] evict %s: %v", rec.diskPath, err)
		return err
	}
	return nil
}

// ReadFrameBytes returns the PNG bytes for a given hash. Looks in the
// in-memory ring first; falls back to disk; returns nil + error if neither.
// Caller is the HTTP frame-fetch handler.
func (m *VibePreviewManager) ReadFrameBytes(project, hash string) ([]byte, error) {
	if hash == "" {
		return nil, fmt.Errorf("hash required")
	}
	rec := m.FrameByHash(project, hash)
	if rec != nil && len(rec.Bytes) > 0 {
		// Return a copy to avoid handing the http handler a slice that
		// the manager could mutate (eviction sets Bytes=nil today, but
		// future code might compact; cheap to be safe).
		out := make([]byte, len(rec.Bytes))
		copy(out, rec.Bytes)
		return out, nil
	}
	// Disk fallback — content-addressed by filename, project-scoped.
	dir := filepath.Join(m.resolveDiskRoot(), sanitizeBranchName(project))
	path := filepath.Join(dir, hash+".png")
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("frame %s/%s not found: %w", project, hash, err)
	}
	return b, nil
}

// ─── SSE event broadcasting ───────────────────────────────────────────────────

// emit appends to the per-session event log and fans out to live subscribers.
// Non-blocking: a slow subscriber loses events, never stalls the producer.
func (m *VibePreviewManager) emit(project string, ev VibePreviewEvent) {
	if ev.Timestamp == "" {
		ev.Timestamp = m.nowFn().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	if ev.Project == "" {
		ev.Project = project
	}

	m.mu.Lock()
	log := m.eventLog[project]
	if len(log) >= vibePreviewEventHistory {
		log = log[1:]
	}
	log = append(log, ev)
	m.eventLog[project] = log

	// Snapshot the subscriber slice so we can release the lock before
	// pushing — channel sends with select-default are still non-blocking,
	// but holding the manager lock during fan-out would serialize the
	// whole agent if there are many subscribers.
	subs := make([]chan VibePreviewEvent, len(m.subs[project]))
	copy(subs, m.subs[project])
	m.mu.Unlock()

	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
			// Slow consumer: drop. Their /events SSE will see a gap.
		}
	}
}

// Subscribe registers a new SSE consumer for project events. Returns the
// channel + a snapshot of the recent event log (for replay) + an
// unsubscribe func. Caller is expected to drain the channel and call
// unsubscribe when the connection closes.
func (m *VibePreviewManager) Subscribe(project string) (<-chan VibePreviewEvent, []VibePreviewEvent, func()) {
	ch := make(chan VibePreviewEvent, vibePreviewSubBufSize)

	m.mu.Lock()
	m.subs[project] = append(m.subs[project], ch)
	histCopy := make([]VibePreviewEvent, len(m.eventLog[project]))
	copy(histCopy, m.eventLog[project])
	m.mu.Unlock()

	unsubscribe := func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		curr := m.subs[project]
		for i, c := range curr {
			if c == ch {
				curr = append(curr[:i], curr[i+1:]...)
				m.subs[project] = curr
				// Drain + close so the writer goroutine doesn't leak.
				go func() {
					for range ch {
					}
				}()
				close(ch)
				return
			}
		}
	}
	return ch, histCopy, unsubscribe
}

// EmitClipEvent is the entry point used by Phase 2.5 clip recorder + Phase 4
// summary pipeline to push events into the same per-session SSE channel.
// Exposed because the clip recorder is in another file.
func (m *VibePreviewManager) EmitClipEvent(project string, ev VibePreviewEvent) {
	m.emit(project, ev)
}

// RegisterClip adds a clip record to the per-project list and emits a
// `clip_ready` event when status flips to ready. Idempotent on ID.
func (m *VibePreviewManager) RegisterClip(project string, clip *VibeClipRecord) {
	if clip == nil {
		return
	}
	m.mu.Lock()
	list := m.clips[project]
	for i, c := range list {
		if c.ID == clip.ID {
			list[i] = clip
			m.clips[project] = list
			m.mu.Unlock()
			return
		}
	}
	m.clips[project] = append(list, clip)
	m.mu.Unlock()
}

// ListClips returns a copy of clip records for a project, newest first.
func (m *VibePreviewManager) ListClips(project string) []*VibeClipRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	src := m.clips[project]
	out := make([]*VibeClipRecord, len(src))
	for i, c := range src {
		cp := *c
		out[len(src)-1-i] = &cp
	}
	return out
}

// ClipByID looks up a clip by ID across every project. O(N) over all
// recorded clips; fine for the few-dozen-clips ringbuffer the manager is
// expected to hold.
func (m *VibePreviewManager) ClipByID(id string) *VibeClipRecord {
	if id == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, list := range m.clips {
		for _, c := range list {
			if c.ID == id {
				cp := *c
				return &cp
			}
		}
	}
	return nil
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// cloneSession returns a JSON-safe copy that omits internal fields.
// Builds a fresh struct field-by-field rather than struct-copy because
// VibePreviewSession contains sync/atomic.Bool (noCopy).
func cloneSession(s *VibePreviewSession) *VibePreviewSession {
	if s == nil {
		return nil
	}
	return &VibePreviewSession{
		ID:      s.ID,
		Project: s.Project,
		// Field-by-field means every new field must be added HERE too, or it
		// silently reads as empty everywhere the clone is what ships. Surface is
		// what lets a refusal name the surface holding the lock.
		Surface:    s.Surface,
		TargetURL:  s.TargetURL,
		BrowserID:  s.BrowserID,
		Mode:       s.Mode,
		Profile:    s.Profile,
		StartedAt:  s.StartedAt,
		LastFrame:  s.LastFrame,
		FrameCount: s.FrameCount,
		StableHits: s.StableHits,
		Errors:     s.Errors,
	}
}
