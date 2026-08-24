// dom_inspect_inject.go — put the DOM-mode probe into every previewed page.
//
// Same two HTML lanes as the screen probe, and the same reason this is a
// shared function rather than an inline snippet:
//
//  1. `serveWebBundleHTML` (build_web.go) — the static Expo/RN web bundle.
//  2. `rewriteDevIndexBaseHref` (devserver_basehref.go) — the live dev-server
//     reverse proxy: Vite, Next.js, Flutter web.
//
// A fix that lands in one of two preview implementations is not landed (that
// exact drift shipped a broken heartbeat in this repo). Guarded by
// dom_inspect_inject_test.go, which asserts both lanes.
package main

import (
	_ "embed"
	"strings"
)

// domInspectProbeJS is the canonical probe, embedded from the .js file so
// there is exactly one copy in the repo.
//
//go:embed dom_inspect_probe.js
var domInspectProbeJS string

// domInspectProbeTag is the injectable <script> element.
//
// `defer` is deliberately ABSENT and the script is self-guarding instead: it
// does nothing until the surface posts a DOM-mode command anyway.
func domInspectProbeTag() string {
	return "<script data-yaver-dom-probe=\"1\">" + domInspectProbeJS + "</script>"
}

// domProbeMarker identifies an already-injected document. Both lanes can touch
// the same bytes, and two probes would double every post.
const domProbeMarker = `data-yaver-dom-probe="1"`

// injectDomInspectProbe appends the probe just before </body>, or falls back
// to </head>, or to the end of the document. Best-effort by design, matching
// injectScreenContextProbe's contract: an input this function does not
// understand is returned UNCHANGED.
func injectDomInspectProbe(html string) string {
	if html == "" || strings.Contains(html, domProbeMarker) {
		return html
	}
	if indexASCIIFold(html, "<html") < 0 && indexASCIIFold(html, "<body") < 0 && indexASCIIFold(html, "<head") < 0 {
		return html
	}
	tag := domInspectProbeTag()
	if i := lastIndexASCIIFold(html, "</body>"); i >= 0 {
		return html[:i] + tag + html[i:]
	}
	if i := lastIndexASCIIFold(html, "</head>"); i >= 0 {
		return html[:i] + tag + html[i:]
	}
	return html + tag
}
