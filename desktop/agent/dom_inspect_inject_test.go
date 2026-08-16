package main

import (
	"strings"
	"testing"
)

func TestInjectDomInspectProbe_LandsBeforeBodyClose(t *testing.T) {
	got := injectDomInspectProbe(sampleIndexHTML)
	if !strings.Contains(got, domProbeMarker) {
		t.Fatal("probe was not injected")
	}
	probeAt := strings.Index(got, domProbeMarker)
	bodyAt := strings.LastIndex(strings.ToLower(got), "</body>")
	if probeAt < 0 || bodyAt < 0 || probeAt > bodyAt {
		t.Fatalf("probe is not inside <body> (probe=%d bodyClose=%d)", probeAt, bodyAt)
	}
}

func TestInjectDomInspectProbe_IsIdempotent(t *testing.T) {
	once := injectDomInspectProbe(sampleIndexHTML)
	twice := injectDomInspectProbe(once)
	if once != twice {
		t.Fatal("second injection changed the document — two probes would double every capture")
	}
	if n := strings.Count(twice, domProbeMarker); n != 1 {
		t.Fatalf("expected exactly 1 probe, found %d", n)
	}
}

func TestInjectDomInspectProbe_LeavesNonHTMLAlone(t *testing.T) {
	for _, in := range []string{
		``,
		`{"status":"starting","detail":"metro is booting"}`,
		`export default function App(){return null}`,
		`just some text`,
	} {
		if got := injectDomInspectProbe(in); got != in {
			t.Errorf("non-HTML input was modified.\n in: %q\nout: %q", in, got)
		}
	}
}

// TestDomProbe_BothPreviewLanesInjectIt is the anti-drift guard. Two HTML
// preview lanes exist; a DOM mode that only one of them serves is a DOM mode
// that silently does not exist for half the previews. Prove it by deleting
// either call and watching this fail.
func TestDomProbe_BothPreviewLanesInjectIt(t *testing.T) {
	for _, lane := range []struct{ file, why string }{
		{"build_web.go", "static Expo/RN web bundle"},
		{"devserver_basehref.go", "live dev-server reverse proxy — Vite / Next.js / Flutter web"},
	} {
		src := readRepoFile(t, lane.file)
		if !strings.Contains(src, "injectDomInspectProbe(") {
			t.Errorf("%s never calls injectDomInspectProbe — %s would have no DOM mode, so clicking an element in that preview sends the runner nothing", lane.file, lane.why)
		}
	}
}

func TestDomProbeJS_ContractsThatMustHold(t *testing.T) {
	js := stripJSLineComments(domInspectProbeJS)
	if strings.TrimSpace(js) == "" {
		t.Fatal("embedded probe is empty")
	}
	// It must NEVER read an input's value — the clicked element may well be a
	// form field the user is typing into.
	if strings.Contains(js, ".value") {
		t.Error("probe reads .value — user-entered text must never be captured")
	}
	// It must not reach the network itself; it posts to its host surface.
	for _, banned := range []string{"XMLHttpRequest", "fetch(", "navigator.sendBeacon"} {
		if strings.Contains(js, banned) {
			t.Errorf("probe uses %s — it must post to its host surface, never write to the agent directly", banned)
		}
	}
	// Both host surfaces must be addressed.
	for _, need := range []string{"ReactNativeWebView", "window.parent"} {
		if !strings.Contains(js, need) {
			t.Errorf("probe never posts to %s", need)
		}
	}
	// It must listen for the enable command — without this the surface's
	// toggle can never turn it on.
	for _, need := range []string{`"yaver-dom-mode"`, `"yaver-dom-element"`} {
		if !strings.Contains(js, need) {
			t.Errorf("probe does not speak the %s protocol", need)
		}
	}
	// It must be OFF until asked. A probe that inspects by default would be
	// silently capturing a page the user never pointed at.
	if !strings.Contains(js, "enabled === true") && !strings.Contains(js, "data.enabled === true") {
		t.Error("probe does not gate mode on the explicit enable command")
	}
}

func TestDomProbeTag_IsWellFormed(t *testing.T) {
	tag := domInspectProbeTag()
	if !strings.HasPrefix(tag, "<script") || !strings.HasSuffix(tag, "</script>") {
		t.Fatal("probe tag is not a script element")
	}
	if strings.Count(tag, "</script>") != 1 {
		t.Fatal("probe body contains a </script> sequence — it would break out of its own tag")
	}
}

// TestDomProbe_AndScreenProbeCoexistInOneDocument: the two probes are injected
// independently and must not clobber each other's markers.
func TestDomProbe_AndScreenProbeCoexistInOneDocument(t *testing.T) {
	got := injectScreenContextProbe(sampleIndexHTML)
	got = injectDomInspectProbe(got)
	if !strings.Contains(got, screenProbeMarker) || !strings.Contains(got, domProbeMarker) {
		t.Fatal("the two probes do not coexist in one document")
	}
	// Idempotence must hold across BOTH: injecting the pair twice is a no-op.
	got2 := injectScreenContextProbe(injectDomInspectProbe(got))
	if got2 != got {
		t.Fatal("re-injecting both probes changed the document")
	}
}
