package main

import (
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// The incident: Flutter's index.html ships <base href="/">, served under the
// /dev/ proxy, so flutter.js resolves to the agent root and 404s. These pin the
// rewrite that makes assets resolve through the proxy — the difference between
// "the app renders on the phone" and "the overlay waits forever".

func TestRewriteFlutterBaseHref(t *testing.T) {
	// The real shape Flutter emits (verified against e-mobile).
	in := `<!DOCTYPE html><html><head>
  <base href="/">
  <script src="flutter.js" defer></script></head>
  <body><picture id="splash"></picture></body></html>`
	out := rewriteDevIndexBaseHrefHTML(in)
	if !strings.Contains(out, `<base href="./">`) {
		t.Fatalf("base href not rewritten to ./:\n%s", out)
	}
	if strings.Contains(out, `<base href="/">`) {
		t.Fatal("the root base href must be gone — assets would still 404")
	}
	// A relative script tag must be left untouched: it now resolves under the
	// rewritten base, which is the whole point.
	if !strings.Contains(out, `src="flutter.js"`) {
		t.Fatal("relative asset paths must not be altered")
	}
}

func TestRewriteBaseHrefQuoteAndSpacingVariants(t *testing.T) {
	for _, in := range []string{
		`<base href="/">`,
		`<base href='/'>`,
		`<base   href = "/" >`,
		`<base href="">`, // Flutter's build sometimes emits an empty base
		`<BASE HREF="/">`,
	} {
		out := rewriteDevIndexBaseHrefHTML(in)
		if !strings.Contains(out, `"./"`) {
			t.Fatalf("variant not rewritten: %q -> %q", in, out)
		}
	}
}

func TestRewriteLeavesExplicitBaseAlone(t *testing.T) {
	// A dev server that already sets a real base must NOT be clobbered — that
	// would break a project that intentionally serves from a subpath.
	in := `<head><base href="/myapp/"><script src="a.js"></script></head>`
	out := rewriteDevIndexBaseHrefHTML(in)
	if out != in {
		t.Fatalf("explicit non-root base was altered:\n  in:  %s\n  out: %s", in, out)
	}
}

func TestRewriteNoBaseIsNoOp(t *testing.T) {
	// A page with no base and only RELATIVE assets is unchanged.
	in := `<html><head><script src="foo.js"></script></head></html>`
	if rewriteDevIndexBaseHrefHTML(in) != in {
		t.Fatal("a document with no base tag and only relative assets must be unchanged")
	}
	// But a root-absolute asset is made relative even without a base tag —
	// otherwise it 404s through the /dev/ proxy (the whole point).
	got := rewriteDevIndexBaseHrefHTML(`<script src="/foo.js"></script>`)
	if !strings.Contains(got, `src="foo.js"`) {
		t.Fatalf("root-absolute asset not made relative: %s", got)
	}
}

// The ModifyResponse hook must only touch HTML — a rewrite that corrupted a JS
// bundle or an image would be far worse than the bug it fixes.
func TestModifyResponseOnlyTouchesHTML(t *testing.T) {
	jsBody := `var x = '<base href="/">';` // a string that LOOKS like a base tag
	resp := &http.Response{
		Header: http.Header{"Content-Type": []string{"application/javascript"}},
		Body:   io.NopCloser(strings.NewReader(jsBody)),
	}
	if err := rewriteDevIndexBaseHref(resp); err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	if string(got) != jsBody {
		t.Fatalf("JS body was modified — the rewrite must be HTML-only:\n%s", got)
	}
	// The one header EVERY dev-proxied response must carry, bundles included:
	// Metro serves changed bundles under the same URL, so a cached 200 makes
	// every edit→reload cycle serve a stale preview that looks healthy
	// (measured 2026-07-27: direct fetch fresh, Chromium cache stale).
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("dev-proxied response missing Cache-Control: no-store (got %q)", resp.Header.Get("Cache-Control"))
	}
}

func TestModifyResponseSetsNoStoreOnHTMLToo(t *testing.T) {
	resp := &http.Response{
		Header: http.Header{"Content-Type": []string{"text/html"}},
		Body:   io.NopCloser(strings.NewReader(`<head></head>`)),
	}
	if err := rewriteDevIndexBaseHref(resp); err != nil {
		t.Fatal(err)
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("HTML dev response missing Cache-Control: no-store (got %q)", resp.Header.Get("Cache-Control"))
	}
}

func TestModifyResponseRewritesHTMLBody(t *testing.T) {
	html := `<head><base href="/"><script src="flutter.js"></script></head>`
	resp := &http.Response{
		Header: http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
		Body:   io.NopCloser(strings.NewReader(html)),
	}
	if err := rewriteDevIndexBaseHref(resp); err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(got), `<base href="./">`) {
		t.Fatalf("HTML body was not rewritten:\n%s", got)
	}
	// Content-Length must match the new body or the client truncates/hangs.
	if resp.Header.Get("Content-Length") != strconv.Itoa(len(got)) {
		t.Fatalf("Content-Length %q does not match rewritten body length %d",
			resp.Header.Get("Content-Length"), len(got))
	}
}

func TestModifyResponseNilSafe(t *testing.T) {
	if err := rewriteDevIndexBaseHref(nil); err != nil {
		t.Fatal("nil response must be a no-op, not an error")
	}
	resp := &http.Response{Header: http.Header{"Content-Type": []string{"text/html"}}}
	if err := rewriteDevIndexBaseHref(resp); err != nil {
		t.Fatal("nil body must be a no-op")
	}
}

// Live Metro (Expo web) serves its entry as a ROOT-ABSOLUTE path, which ignores
// <base href> and 404s through the /dev/ proxy. Static `expo export` uses
// relative paths, which is why fixtures missed this. Pin the fix.
func TestRewriteMakesAbsoluteMetroBundleRelative(t *testing.T) {
	in := `<head><base href="/"><script src="/node_modules/expo/AppEntry.bundle?platform=web&dev=true"></script></head>`
	out := rewriteDevIndexBaseHrefHTML(in)
	if strings.Contains(out, `src="/node_modules`) {
		t.Fatalf("absolute bundle path not made relative — it will 404 through the proxy:\n%s", out)
	}
	if !strings.Contains(out, `src="node_modules/expo/AppEntry.bundle?platform=web&dev=true"`) {
		t.Fatalf("expected base-relative bundle path:\n%s", out)
	}
}

func TestRewriteLeavesProtocolRelativeAndAbsoluteURLsAlone(t *testing.T) {
	for _, in := range []string{
		`<script src="//cdn.example.com/x.js"></script>`,
		`<script src="https://cdn.example.com/x.js"></script>`,
		`<link href="https://fonts.example/x.css">`,
	} {
		if got := rewriteDevIndexBaseHrefHTML(in); got != in {
			t.Fatalf("external/protocol-relative URL was altered:\n  in:  %s\n  out: %s", in, got)
		}
	}
}

// The relay authenticates EVERY proxied request, and a browser cannot put
// ?token/&__rp on the sub-resource requests the HTML parser issues. The agent
// grew applyPreviewRelayAuth for exactly this — and it was never called from
// the proxy hook, so over the relay the page loaded and every script 401'd
// (measured live 2026-07-26: /d/<id>/dev-web/...entry.bundle → 401 while the
// page showed its empty #root). Pin the wiring, not just the helper.
func TestModifyResponsePropagatesAuthQueryOntoAssets(t *testing.T) {
	html := `<html><head></head><body><script src="node_modules/expo-router/entry.bundle?platform=web&dev=true"></script></body></html>`
	req, _ := http.NewRequest("GET", "http://127.0.0.1:18080/dev-web/?token=tok123&__rp=pw456", nil)
	resp := &http.Response{
		Header:  http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
		Body:    io.NopCloser(strings.NewReader(html)),
		Request: req,
	}
	if err := rewriteDevIndexBaseHref(resp); err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	s := string(got)
	if !strings.Contains(s, "entry.bundle?platform=web&dev=true&__rp=pw456&token=tok123") {
		t.Fatalf("static script src did not gain the page's auth query — over the relay it will 401:\n%s", s)
	}
	if !strings.Contains(s, "yaver-preview-auth-shim") {
		t.Fatalf("dynamic-loader auth shim was not injected:\n%s", s)
	}
}

// No auth query on the page request → no auth material may appear in the
// output (the router base-path script still injects; that part is unrelated).
// LAN direct traffic is header-authenticated and must never gain query creds.
func TestModifyResponseLeavesUnauthedPagesWithoutAuth(t *testing.T) {
	html := `<html><head></head><body><script src="app.js"></script></body></html>`
	req, _ := http.NewRequest("GET", "http://127.0.0.1:18080/dev/", nil)
	resp := &http.Response{
		Header:  http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
		Body:    io.NopCloser(strings.NewReader(html)),
		Request: req,
	}
	if err := rewriteDevIndexBaseHref(resp); err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	s := string(got)
	if strings.Contains(s, "yaver-preview-auth-shim") {
		t.Fatalf("auth shim injected on a page with no auth query:\n%s", s)
	}
	if !strings.Contains(s, `src="app.js"`) {
		t.Fatalf("asset src was altered without an auth query to carry:\n%s", s)
	}
}
