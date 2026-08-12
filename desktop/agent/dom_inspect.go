// dom_inspect.go — the ELEMENT the user clicked in the preview, carried into
// the prompt.
//
// ── What this is ─────────────────────────────────────────────────────────
//
// DOM mode (Orca's "Design Mode"): in the web UI the user toggles inspect,
// hovers any element in the live preview (it highlights), clicks one, and the
// element's outerHTML + computed CSS + rect + a cropped screenshot reach the
// runner with the next prompt — so "deep audit this element" or "the spacing
// on this card is wrong" arrives with the element attached instead of sending
// the runner on a blind grep for "card".
//
// The pipeline is byte-for-byte the screen-context pipeline
// (screen_context.go): a probe injected into every previewed document
// (dom_inspect_probe.js → dom_inspect_inject.go) captures the element and
// posts it to its HOST SURFACE; the surface — which holds the user's bearer
// token — forwards it here over the authenticated /dom-inspect route. The
// anonymous /dev/ preview can never write into the agent directly.
//
// ── How it differs from screen context ──────────────────────────────────
//
// Screen context is AMBIENT (always-on, reports what is on screen, 3-min TTL,
// ~1 KB block). DOM mode is DELIBERATE: the user explicitly enables it and
// explicitly clicks an element, so the TTL is longer (10 min) and the block is
// richer (HTML + CSS + screenshot, up to ~64 KB). A deliberately-selected
// element stays believable far longer than an ambient observation — but not
// forever, and a stale element is worse than none, so it still expires.
//
// ── Deliberate non-goals ────────────────────────────────────────────────
//
//   - NEVER input VALUES. The probe reads text, labels and computed styles —
//     all authored by the app — and never `input.value`. The clicked element
//     may well be a form field the user is typing into.
//   - The screenshot is best-effort garnish. A vision-capable runner can use
//     it; a text-only runner gets the HTML + CSS, which is the payload. A
//     probe that cannot render the canvas degrades to no screenshot, never a
//     failed capture.
//   - NEVER Convex. Work-derived content; the privacy contract forbids it and
//     convex_privacy_test.go enforces it.
package main

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// Hard caps. Every field is clamped at the seam where it ENTERS the agent —
// a cap enforced only by the probe (which lives inside a third-party app) is
// not a cap. The block can legitimately be larger than screen context because
// it carries markup, but it is still bounded so the user's own words can never
// be evicted from the context window.
const (
	maxDomSelectorRunes = 200
	maxDomTagRunes      = 40
	maxDomIDRunes       = 120
	maxDomClassesRunes  = 240
	maxDomTextRunes     = 400
	maxDomHTMLBytes     = 24000
	maxDomCSSBytes      = 16000
	maxDomShotBytes     = 16000 // base64 JPEG dataURL
	maxDomRectRunes     = 120
	maxDomBlockBytes    = 64000
)

// domInspectTTL — how long a clicked element stays believable.
//
// Deliberately longer than screenContextTTL (3 min): an element is not
// something the user merely sat in front of, it is something they pointed at.
// But a selection from ten minutes ago describes a page the user has probably
// navigated away from, so it still expires.
const domInspectTTL = 10 * time.Minute

// DomElement is one user-selected element from the live preview.
type DomElement struct {
	// WorkDir is the project the element belongs to. The registry key.
	WorkDir string `json:"workDir,omitempty"`
	// Selector is a bounded css-path (tag#id.first > …), for locating the
	// element in the source.
	Selector string `json:"selector,omitempty"`
	// Tag is the element's tag name, lowercased.
	Tag string `json:"tag,omitempty"`
	// ID and Classes are the element's own attributes.
	ID      string `json:"id,omitempty"`
	Classes string `json:"classes,omitempty"`
	// Text is the element's visible text, flattened to one line.
	Text string `json:"text,omitempty"`
	// HTML is the element's outerHTML, clamped. The primary payload.
	HTML string `json:"html,omitempty"`
	// CSS is the visual subset of the element's computed style, clamped.
	CSS string `json:"css,omitempty"`
	// Rect is a compact "x:.. y:.. w:.. h:.." geometry string.
	Rect string `json:"rect,omitempty"`
	// Shot is a cropped JPEG dataURL of the element, clamped. Best-effort —
	// a probe that cannot render the canvas sends "".
	Shot string `json:"shot,omitempty"`
	// Lane records HOW this was observed: "browser" or "webview".
	Lane string `json:"lane,omitempty"`
	// CapturedAt is unix milliseconds, set by the agent on receipt — never
	// trusted from the client, whose clock may be anything at all.
	CapturedAt int64 `json:"capturedAt,omitempty"`
}

// IsEmpty reports whether there is nothing worth telling a runner. An element
// with no tag, no text and no html is not an element.
func (d DomElement) IsEmpty() bool {
	return d.Selector == "" && d.Tag == "" && d.Text == "" && d.HTML == ""
}

// NormalizeDomElement is the ONLY door into the registry.
func NormalizeDomElement(in DomElement) DomElement {
	out := DomElement{
		WorkDir:    strings.TrimSpace(in.WorkDir),
		Selector:   truncateRunes(collapseScreenText(in.Selector), maxDomSelectorRunes),
		Tag:        truncateRunes(collapseScreenText(in.Tag), maxDomTagRunes),
		ID:         truncateRunes(collapseScreenText(in.ID), maxDomIDRunes),
		Classes:    truncateRunes(collapseScreenText(in.Classes), maxDomClassesRunes),
		Text:       truncateRunes(collapseScreenText(in.Text), maxDomTextRunes),
		Rect:       truncateRunes(collapseScreenText(in.Rect), maxDomRectRunes),
		Lane:       strings.TrimSpace(in.Lane),
		CapturedAt: in.CapturedAt,
	}
	switch out.Lane {
	case "browser", "webview", "native":
	default:
		out.Lane = ""
	}
	// Byte-level clamps for the three big fields. collapseScreenText already
	// flattened whitespace; these bound the total.
	if len(in.HTML) > maxDomHTMLBytes {
		out.HTML = truncateRunes(in.HTML, maxDomHTMLBytes/4) + "…"
	} else {
		out.HTML = in.HTML
	}
	if len(in.CSS) > maxDomCSSBytes {
		out.CSS = truncateRunes(in.CSS, maxDomCSSBytes/4) + "…"
	} else {
		out.CSS = in.CSS
	}
	if len(in.Shot) > maxDomShotBytes {
		// A shot that is too big is dropped rather than truncated: a cut
		// dataURL is a broken image, which is worse than no image.
		out.Shot = ""
	} else {
		out.Shot = in.Shot
	}
	return out
}

// IsFresh reports whether this selection is still worth injecting.
func (d DomElement) IsFresh(now time.Time) bool {
	if d.CapturedAt <= 0 {
		return false
	}
	age := now.Sub(time.UnixMilli(d.CapturedAt))
	return age >= 0 && age <= domInspectTTL
}

// FormatDomElementBlock renders the prompt prefix, or "" when there is
// nothing honest to say. Same shape rules as FormatScreenContextBlock: it is
// FACTUAL (states what was selected, never what to conclude), DELIMITED with
// the repo's sentinel so stripPromptEcho can slice it out, and NAMES ITSELF
// as attached-by-Yaver.
func FormatDomElementBlock(d DomElement) string {
	if d.IsEmpty() {
		return ""
	}
	var parts []string
	if d.Selector != "" {
		parts = append(parts, "selector: "+d.Selector)
	}
	if d.Tag != "" {
		parts = append(parts, "tag: "+d.Tag)
	}
	if d.Text != "" {
		parts = append(parts, "text: "+d.Text)
	}
	if d.Rect != "" {
		parts = append(parts, "rect: "+d.Rect)
	}
	if d.HTML != "" {
		parts = append(parts, "html: "+d.HTML)
	}
	if d.CSS != "" {
		parts = append(parts, "css: "+d.CSS)
	}
	if d.Shot != "" {
		parts = append(parts, "screenshot: "+d.Shot)
	}

	var sb strings.Builder
	sb.WriteString("\n\n")
	sb.WriteString(promptEchoSentinel)
	sb.WriteString("\n[DOM element the user selected in the live preview — captured by Yaver, not typed by the user]\n")
	for _, p := range parts {
		sb.WriteString(p)
		sb.WriteString("\n")
	}
	sb.WriteString("If the user says \"this element\", \"it\", or asks to audit, fix, restyle or explain it, they mean THIS element. Start from the source file that renders it.\n")
	sb.WriteString(promptEchoSentinel)
	sb.WriteString("\n")

	out := sb.String()
	if len(out) > maxDomBlockBytes {
		// Every field is already capped; reaching here means a cap regressed.
		// Truncate the whole block rather than shipping an unbounded prefix —
		// and note that truncating a block containing a dataURL can cut the
		// screenshot mid-base64, which is why the shot is best-effort anyway.
		out = truncateRunes(out, maxDomBlockBytes/4) + "\n"
	}
	return out
}

// domInspectStore is the agent's last-selected-element registry, keyed by
// workDir. In memory only: an element selection cannot outlive the agent.
type domInspectStore struct {
	mu sync.RWMutex
	m  map[string]DomElement
}

const maxTrackedElements = 16

func newDomInspectStore() *domInspectStore {
	return &domInspectStore{m: make(map[string]DomElement)}
}

// globalDomElements is the process-wide registry, mirroring
// globalScreenContexts: one surface per human, so a single store keyed by the
// workDir the task already carries keeps dispatch to a map read.
var globalDomElements = newDomInspectStore()

// Put stores a selection, stamping CapturedAt from the agent's own clock.
func (s *domInspectStore) Put(d DomElement, now time.Time) DomElement {
	d = NormalizeDomElement(d)
	d.CapturedAt = now.UnixMilli()
	key := screenContextKey(d.WorkDir) // same key normalisation as screen context
	if key == "" || d.IsEmpty() {
		return DomElement{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.m) >= maxTrackedElements {
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
	s.m[key] = d
	return d
}

// Get returns the last-known FRESH selection for a working directory.
func (s *domInspectStore) Get(workDir string, now time.Time) (DomElement, bool) {
	key := screenContextKey(workDir)
	if key == "" {
		return DomElement{}, false
	}
	s.mu.RLock()
	d, ok := s.m[key]
	s.mu.RUnlock()
	if !ok {
		return DomElement{}, false
	}
	if !d.IsFresh(now) {
		s.mu.Lock()
		if cur, still := s.m[key]; still && cur.CapturedAt == d.CapturedAt {
			delete(s.m, key)
		}
		s.mu.Unlock()
		return DomElement{}, false
	}
	return d, true
}

// Clear drops a project's selection — used when DOM mode is turned off, so the
// next prompt does not inherit an element nobody selected anymore.
func (s *domInspectStore) Clear(workDir string) {
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
func (d DomElement) Summary() string {
	if d.IsEmpty() {
		return ""
	}
	name := d.Selector
	if name == "" {
		name = d.Tag
	}
	if d.Text != "" {
		name = fmt.Sprintf("%s — %s", name, truncateRunes(d.Text, 48))
	}
	return name
}

// ── Interactive-items inventory ──────────────────────────────────────────
//
// "The agent provides DOM items through client surfaces": on demand, the probe
// walks the preview and returns the visible interactive elements
// (button/a/input/role=…), and the agent holds that list keyed by workDir so
// ANY surface — the phone included, where hovering is hard — can fetch the
// same inventory and let the user pick an element to audit. Short TTL: a DOM
// inventory describes a screen that can change any moment.

// domItemsTTL — how long a captured inventory stays believable.
const domItemsTTL = 60 * time.Second

// DomItem is one visible interactive element from the preview inventory.
type DomItem struct {
	Selector string `json:"selector,omitempty"`
	Tag      string `json:"tag,omitempty"`
	ID       string `json:"id,omitempty"`
	Classes  string `json:"classes,omitempty"`
	Text     string `json:"text,omitempty"`
	Rect     string `json:"rect,omitempty"`
}

// DomItems is one captured inventory for one workDir.
type DomItems struct {
	WorkDir    string    `json:"workDir,omitempty"`
	Items      []DomItem `json:"items,omitempty"`
	CapturedAt int64     `json:"capturedAt,omitempty"`
}

func NormalizeDomItems(in DomItems) DomItems {
	out := DomItems{WorkDir: strings.TrimSpace(in.WorkDir)}
	seen := make(map[string]bool, len(in.Items))
	for _, it := range in.Items {
		item := DomItem{
			Selector: truncateRunes(collapseScreenText(it.Selector), maxDomSelectorRunes),
			Tag:      truncateRunes(collapseScreenText(it.Tag), maxDomTagRunes),
			ID:       truncateRunes(collapseScreenText(it.ID), maxDomIDRunes),
			Classes:  truncateRunes(collapseScreenText(it.Classes), maxDomClassesRunes),
			Text:     truncateRunes(collapseScreenText(it.Text), maxDomTextRunes),
			Rect:     truncateRunes(collapseScreenText(it.Rect), maxDomRectRunes),
		}
		if item.Selector == "" && item.Tag == "" {
			continue
		}
		key := item.Selector + "\x00" + item.Tag
		if seen[key] {
			continue
		}
		seen[key] = true
		out.Items = append(out.Items, item)
		if len(out.Items) >= 40 {
			break
		}
	}
	return out
}

func (d DomItems) IsEmpty() bool { return len(d.Items) == 0 }

func (d DomItems) IsFresh(now time.Time) bool {
	if d.CapturedAt <= 0 {
		return false
	}
	age := now.Sub(time.UnixMilli(d.CapturedAt))
	return age >= 0 && age <= domItemsTTL
}

// domItemsStore is the agent's last-known-inventory registry, keyed by workDir.
type domItemsStore struct {
	mu sync.RWMutex
	m  map[string]DomItems
}

func newDomItemsStore() *domItemsStore { return &domItemsStore{m: make(map[string]DomItems)} }

var globalDomItems = newDomItemsStore()

func (s *domItemsStore) Put(d DomItems, now time.Time) DomItems {
	d = NormalizeDomItems(d)
	d.CapturedAt = now.UnixMilli()
	key := screenContextKey(d.WorkDir)
	if key == "" || d.IsEmpty() {
		return DomItems{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[key] = d
	return d
}

func (s *domItemsStore) Get(workDir string, now time.Time) (DomItems, bool) {
	key := screenContextKey(workDir)
	if key == "" {
		return DomItems{}, false
	}
	s.mu.RLock()
	d, ok := s.m[key]
	s.mu.RUnlock()
	if !ok {
		return DomItems{}, false
	}
	if !d.IsFresh(now) {
		s.mu.Lock()
		delete(s.m, key)
		s.mu.Unlock()
		return DomItems{}, false
	}
	return d, true
}

func (s *domItemsStore) Clear(workDir string) {
	key := screenContextKey(workDir)
	if key == "" {
		return
	}
	s.mu.Lock()
	delete(s.m, key)
	s.mu.Unlock()
}
