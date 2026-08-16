// screen_context_inject.go — put the screen probe into every previewed page.
//
// There are two HTML lanes and BOTH need this, which is the entire reason this
// is a shared function rather than an inline snippet:
//
//  1. `serveWebBundleHTML` (build_web.go) — the static Expo/RN web bundle. This
//     is the lane the sfmg incident happened on.
//  2. `rewriteDevIndexBaseHref` (devserver_basehref.go) — the live dev-server
//     reverse proxy: Vite, Next.js, Flutter web.
//
// A fix that lands in one of two preview implementations is not landed — that
// exact drift already shipped a broken heartbeat and dropped SSE frames in this
// repo. Guarded by screen_context_inject_test.go, which asserts both lanes.
package main

import (
	_ "embed"
	"strings"
)

// screenContextProbeJS is the canonical probe, embedded from the .js file so
// there is exactly one copy in the repo. Kept as a real .js file rather than a
// Go string literal so it is lintable, testable in a browser, and free of
// escaping hazards.
//
//go:embed screen_context_probe.js
var screenContextProbeJS string

// screenContextProbeTag is the injectable <script> element.
//
// `defer` is deliberately ABSENT and the script is self-guarding instead: it
// must survive being injected into documents whose head is rewritten by two
// other injectors (base href, router reset), and it does nothing until a
// timeout fires anyway.
func screenContextProbeTag() string {
	return "<script data-yaver-screen-probe=\"1\">" + screenContextProbeJS + "</script>"
}

// screenProbeMarker identifies an already-injected document. Both lanes can
// touch the same bytes (a proxied response that was also rewritten upstream),
// and two probes would double every post.
const screenProbeMarker = `data-yaver-screen-probe="1"`

// injectScreenContextProbe appends the probe just before </body>, or falls back
// to </head>, or to the end of the document.
//
// End-of-body rather than head: the probe reads rendered DOM, and a head-blocking
// script that walks the document before the app has mounted measures an empty
// page. It re-polls regardless, but starting late costs nothing and starting
// early costs a wasted first observation.
//
// Best-effort by design, matching rewriteDevIndexBaseHref's own contract: an
// input this function does not understand is returned UNCHANGED. A preview
// missing its probe degrades to today's behaviour; a preview whose HTML we
// corrupted is a broken product.
func injectScreenContextProbe(html string) string {
	if html == "" || strings.Contains(html, screenProbeMarker) {
		return html
	}
	// Only touch something that is plausibly an HTML document. A JSON error body
	// or a JS chunk that reached us by mistake must pass through untouched.
	lower := strings.ToLower(html)
	if !strings.Contains(lower, "<html") && !strings.Contains(lower, "<body") && !strings.Contains(lower, "<head") {
		return html
	}
	tag := screenContextProbeTag()
	if i := strings.LastIndex(lower, "</body>"); i >= 0 {
		return html[:i] + tag + html[i:]
	}
	if i := strings.LastIndex(lower, "</head>"); i >= 0 {
		return html[:i] + tag + html[i:]
	}
	return html + tag
}
