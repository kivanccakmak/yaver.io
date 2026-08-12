package main

import (
	"strings"
	"testing"
	"time"
)

func TestNormalizeDomElement_CapsAndLaneAllowlist(t *testing.T) {
	in := DomElement{
		WorkDir:  "/home/dev/app",
		Selector: strings.Repeat("a", 500),
		Tag:      "BUTTON",
		ID:       "submit-btn",
		Text:     strings.Repeat("t", 500),
		HTML:     strings.Repeat("h", maxDomHTMLBytes+100),
		CSS:      strings.Repeat("c", maxDomCSSBytes+100),
		Shot:     strings.Repeat("s", maxDomShotBytes+1),
		Rect:     "x:0 y:0 w:320 h:48",
		Lane:     "browser",
	}
	out := NormalizeDomElement(in)
	if runes := len([]rune(out.Selector)); runes > maxDomSelectorRunes {
		t.Fatalf("selector not capped: %d runes", runes)
	}
	if out.Tag != "BUTTON" {
		t.Fatalf("tag was lowercased/changed: %q", out.Tag)
	}
	if runes := len([]rune(out.Text)); runes > maxDomTextRunes {
		t.Fatalf("text not capped: %d runes", runes)
	}
	if len(out.HTML) > maxDomHTMLBytes {
		t.Fatalf("html not capped: %d bytes", len(out.HTML))
	}
	if len(out.CSS) > maxDomCSSBytes {
		t.Fatalf("css not capped: %d bytes", len(out.CSS))
	}
	if out.Shot != "" {
		t.Fatal("oversized shot must be DROPPED, not truncated — a cut dataURL is a broken image")
	}
	// A cut dataURL must never ship: truncating base64 mid-image is a broken
	// image that a vision runner would misinterpret.
	if strings.Contains(out.Shot, "data:image/jpeg") && len(out.Shot) == maxDomShotBytes {
		t.Fatal("shot at exactly the cap could be a cut dataURL — oversized shots are dropped")
	}

	// Unknown lanes are dropped rather than echoed — the one field a client
	// could use to smuggle prose into the block.
	bad := NormalizeDomElement(DomElement{Lane: "free prose", Tag: "div", Text: "x"})
	if bad.Lane != "" {
		t.Fatalf("unrecognised lane echoed: %q", bad.Lane)
	}
}

func TestDomElement_IsEmptyAndFresh(t *testing.T) {
	if !(DomElement{}).IsEmpty() {
		t.Fatal("zero-value DomElement must be empty")
	}
	if d := (DomElement{Tag: "div"}); d.IsEmpty() {
		t.Fatal("an element with a tag is not empty")
	}
	now := time.Now()
	d := DomElement{CapturedAt: now.UnixMilli()}
	if !d.IsFresh(now) {
		t.Fatal("fresh element judged stale")
	}
	stale := DomElement{CapturedAt: now.Add(-(domInspectTTL + time.Minute)).UnixMilli()}
	if stale.IsFresh(now) {
		t.Fatal("stale element judged fresh — a 10-minute-old selection describes a page the user left")
	}
}

func TestFormatDomElementBlock_SentinelAndFacts(t *testing.T) {
	d := DomElement{
		Selector: "div.card > button.submit",
		Tag:      "button",
		Text:     "İleri →",
		HTML:     `<button class="submit">İleri →</button>`,
		CSS:      "display:flex; background-color: #7c5cff",
		Rect:     "x:12 y:300 w:120 h:48",
	}
	block := FormatDomElementBlock(d)
	if block == "" {
		t.Fatal("block must not be empty for a real element")
	}
	if n := strings.Count(block, promptEchoSentinel); n != 2 {
		t.Fatalf("block must be delimited by exactly 2 sentinels, found %d", n)
	}
	for _, want := range []string{
		"selector: div.card > button.submit",
		"tag: button",
		"text: İleri →",
		"rect: x:12 y:300 w:120 h:48",
		"html: <button class=\"submit\">",
		"css: display:flex",
		"THIS element",
	} {
		if !strings.Contains(block, want) {
			t.Errorf("block missing %q:\n%s", want, block)
		}
	}
	if strings.Contains(block, "screenshot:") {
		t.Error("block claims a screenshot that was not provided")
	}
	// An empty element must never produce a block: an empty "[Element…]"
	// header reads as a fact and is not one.
	if FormatDomElementBlock(DomElement{}) != "" {
		t.Fatal("empty element produced a prompt block")
	}
}

func TestFormatDomElementBlock_WithScreenshot(t *testing.T) {
	d := DomElement{Tag: "img", Selector: "img.logo", Shot: "data:image/jpeg;base64,/9j/4AAQ=="}
	block := FormatDomElementBlock(d)
	if !strings.Contains(block, "screenshot: data:image/jpeg;base64") {
		t.Fatalf("block does not carry the screenshot:\n%s", block)
	}
}

func TestDomInspectStore_PutGetTTLClear(t *testing.T) {
	s := newDomInspectStore()
	now := time.Now()
	s.Put(DomElement{WorkDir: "/app/", Tag: "button", Text: "save"}, now)
	got, ok := s.Get("/app", now.Add(time.Second))
	if !ok {
		t.Fatal("stored element not found — key normalisation must strip trailing slashes")
	}
	if got.Tag != "button" {
		t.Fatalf("wrong element returned: %+v", got)
	}
	if got.CapturedAt != now.UnixMilli() {
		t.Fatal("CapturedAt must be stamped by the agent, not trusted from the client")
	}
	// Stale → gone.
	if _, ok := s.Get("/app", now.Add(domInspectTTL+time.Minute)); ok {
		t.Fatal("stale element still served")
	}
	// Clear → gone.
	s.Put(DomElement{WorkDir: "/app", Tag: "div", Text: "x"}, now)
	s.Clear("/app")
	if _, ok := s.Get("/app", now); ok {
		t.Fatal("cleared element still served — turning DOM mode off must delete what was reported")
	}
}

func TestDomInspectStore_RejectsEmptyWorkDir(t *testing.T) {
	s := newDomInspectStore()
	now := time.Now()
	got := s.Put(DomElement{WorkDir: "  ", Tag: "div"}, now)
	if !got.IsEmpty() {
		t.Fatal("element without a workDir was stored — it could never be looked up and would silently die at dispatch")
	}
}

// TestDomInspectStore_EvictsOldest pins the cap so a long-lived agent cannot
// grow the registry without bound.
func TestDomInspectStore_EvictsOldest(t *testing.T) {
	s := newDomInspectStore()
	now := time.Now()
	for i := 0; i < maxTrackedElements+5; i++ {
		s.Put(DomElement{WorkDir: "/proj" + string(rune('a'+i%26)) + "/", Tag: "div", Text: "x"}, now.Add(time.Duration(i)*time.Second))
	}
	// The newest must be present (it evicts the oldest, not itself). Read back
	// just inside the TTL so the freshness check cannot mask the eviction.
	if _, ok := s.Get("/proj"+string(rune('a'+(maxTrackedElements+4)%26)), now.Add(time.Minute)); !ok {
		t.Fatal("newest entry evicted")
	}
	// The store is bounded.
	if len(s.m) > maxTrackedElements {
		t.Fatalf("store grew past %d entries", maxTrackedElements)
	}
}

func TestDomElementSummary_NamesTheElement(t *testing.T) {
	d := DomElement{Selector: "div.card > button.submit", Text: "İleri →"}
	s := d.Summary()
	if s == "" {
		t.Fatal("summary empty")
	}
	if !strings.Contains(s, "div.card > button.submit") || !strings.Contains(s, "İleri") {
		t.Fatalf("summary does not name the element: %q", s)
	}
}

func TestNormalizeDomItems_DedupeAndCap(t *testing.T) {
	dup := DomItem{Selector: "button.submit", Tag: "button", Text: "Save"}
	in := DomItems{WorkDir: "/app", Items: []DomItem{
		{Selector: strings.Repeat("a", 500), Tag: "button"},
		dup,
		dup, // exact duplicate dropped
		{Selector: "", Tag: "", Text: "no selector or tag"}, // dropped
		{Selector: "input.email", Tag: "input"},
	}}
	out := NormalizeDomItems(in)
	if out.WorkDir != "/app" {
		t.Fatalf("workDir lost: %q", out.WorkDir)
	}
	if len(out.Items) != 3 {
		t.Fatalf("expected 3 unique items, got %d: %+v", len(out.Items), out.Items)
	}
	for _, it := range out.Items {
		if len([]rune(it.Selector)) > maxDomSelectorRunes {
			t.Fatalf("selector not capped: %d runes", len([]rune(it.Selector)))
		}
		if it.Selector == "" && it.Tag == "" {
			t.Fatal("item with neither selector nor tag survived")
		}
	}
	// Cap at 40 even when the input is larger.
	many := make([]DomItem, 0, 100)
	for i := 0; i < 100; i++ {
		many = append(many, DomItem{Selector: "el-" + string(rune('0'+i%10)), Tag: "div"})
	}
	if capped := NormalizeDomItems(DomItems{Items: many}); len(capped.Items) > 40 {
		t.Fatalf("items list not capped at 40: %d", len(capped.Items))
	}
}

func TestDomItemsStore_PutGetTTLClear(t *testing.T) {
	s := newDomItemsStore()
	now := time.Now()
	s.Put(DomItems{WorkDir: "/app/", Items: []DomItem{{Selector: "button.a", Tag: "button"}}}, now)
	got, ok := s.Get("/app", now.Add(time.Second))
	if !ok {
		t.Fatal("stored inventory not found — key normalisation must strip trailing slashes")
	}
	if len(got.Items) != 1 || got.Items[0].Selector != "button.a" {
		t.Fatalf("wrong inventory returned: %+v", got)
	}
	if got.CapturedAt != now.UnixMilli() {
		t.Fatal("CapturedAt must be stamped by the agent, not trusted from the client")
	}
	// Empty inventory never stored.
	if !s.Put(DomItems{WorkDir: "/app", Items: nil}, now).IsEmpty() {
		t.Fatal("empty inventory was stored")
	}
	// Stale → gone (60 s TTL).
	if _, ok := s.Get("/app", now.Add(domItemsTTL+time.Second)); ok {
		t.Fatal("stale inventory still served")
	}
	// Clear → gone.
	s.Put(DomItems{WorkDir: "/app", Items: []DomItem{{Selector: "div.a", Tag: "div"}}}, now)
	s.Clear("/app")
	if _, ok := s.Get("/app", now); ok {
		t.Fatal("cleared inventory still served")
	}
	// Empty workDir never stored.
	if !s.Put(DomItems{WorkDir: "  ", Items: []DomItem{{Selector: "div.a", Tag: "div"}}}, now).IsEmpty() {
		t.Fatal("inventory without a workDir was stored")
	}
}
