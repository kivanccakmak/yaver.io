package main

// devserver_basehref.go — rewrite a proxied dev-server index's <base href> so
// root-absolute asset paths resolve through the agent's /dev/ proxy.
//
// See the call site in devserver.go for the full incident. Short version: the
// browser lane serves the dev server under /dev/, but Flutter's index.html
// ships `<base href="/">`, so `flutter.js` resolves to the AGENT ROOT and 404s.
// The engine never boots and the mobile overlay waits forever. Rewriting the
// base to /dev/ makes every relative asset resolve under the proxy.

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// devBaseHrefRe matches a Flutter/SPA base tag: <base href="/"> with any quote
// style and spacing. Only a base pointing at the root ("/" or empty) is
// rewritten — a dev server that already sets a real base is left alone.
var devBaseHrefRe = regexp.MustCompile(`(?i)<base\s+href\s*=\s*["'](/?)["']\s*/?>`)

// devProxyBaseHref is where the browser lane is mounted. Kept as a const so the
// rewrite and any future route change stay in lockstep.
// A RELATIVE base, deliberately — never an absolute path.
//
// "/dev/" was wrong the moment the request arrived over the relay: the page is
// then served at /d/<deviceId>/dev/, so an absolute "/dev/" resolves to
// relay-root + /dev/ and drops the device prefix, 404ing every asset again.
// "./" resolves against the document's own directory, so it is correct for
// localhost (/dev/), LAN, relay (/d/<id>/dev/) and any future prefix — nothing
// about the transport is hardcoded.
const devProxyBaseHref = "./"

// devAbsAssetRe matches src="/..." / href="/..." with a SINGLE leading slash
// (i.e. root-absolute, not protocol-relative "//host"). Capture 1 is the attr,
// capture 2 is the path minus that leading slash.
var devAbsAssetRe = regexp.MustCompile(`(?i)\b(src|href)="/([^/"][^"]*)"`)

// devBaseTagRe matches a whole <base ...> tag, protected across the abs-asset
// pass so its href is never touched.
var devBaseTagRe = regexp.MustCompile(`(?i)<base\b[^>]*>`)

// devHeadOpenRe finds the opening <head> so a missing base can be inserted right
// after it — before any script the document might load.
var devHeadOpenRe = regexp.MustCompile(`(?i)<head[^>]*>`)

// rewriteDevIndexBaseHrefHTML rewrites a root <base href> to devProxyBaseHref.
// Pure and content-only so it can be unit-tested without a live proxy.
// Returns the input unchanged when there is nothing root-based to rewrite.
func rewriteDevIndexBaseHrefHTML(html string) string {
	// NOTE: no base tag is INSERTED when a document has none.
	//
	// Expo's live web index ships no base and loads its entry from a root-absolute
	// path. Stripping that leading slash (below) is what fixes it; a `<base href=
	// "./">` would NOT — with a document URL of /dev-web (no trailing slash), "./"
	// resolves to "/" just as a missing base does. The trailing-slash redirect in
	// handleDevWebProxy is the mechanism that closes that case, so inserting a base
	// here would only add a second, weaker copy of the same guarantee and would
	// alter documents that are already correct (see TestRewriteNoBaseIsNoOp).
	// Only touch a base that points at root; never clobber an explicit base.
	out := devBaseHrefRe.ReplaceAllStringFunc(html, func(m string) string {
		// m is the whole <base ...> tag. Guard: if the captured href was
		// non-root the outer regex wouldn't have matched, so any match here is
		// a root base and safe to replace.
		return `<base href="` + devProxyBaseHref + `">`
	})
	// Also make ROOT-ABSOLUTE asset paths base-relative.
	//
	// A relative <base href="./"> only fixes RELATIVE asset refs. A live Metro
	// dev server (Expo web) serves its entry as an ABSOLUTE path:
	//   <script src="/node_modules/expo/AppEntry.bundle?platform=web...">
	// and absolute paths ignore <base> entirely, so through the /dev/ proxy —
	// and doubly so through the relay's /d/<id>/dev/ — that resolves to the
	// server ROOT and 404s. The whole app then fails to boot. Missed until now
	// because `expo export -p web` (static) uses RELATIVE paths, while live
	// Metro uses absolute ones — the test fixtures and the real thing differ.
	//
	// Stripping the leading slash turns "/node_modules/..." into
	// "node_modules/...", which the base href then resolves under /dev/ (and
	// under /d/<id>/dev/ on the relay). Correct for a dev preview: every asset
	// the served page needs lives under the dev-server root, which IS the
	// proxy root here. Protocol-relative (//host) and full URLs are untouched.
	//
	// The <base> tag's OWN href must not be rewritten (its whole job is to be
	// the base), so protect every base tag across the abs pass and restore it.
	const baseMark = "\x00YVBASE\x00"
	var bases []string
	out = devBaseTagRe.ReplaceAllStringFunc(out, func(m string) string {
		bases = append(bases, m)
		return baseMark
	})
	out = devAbsAssetRe.ReplaceAllString(out, `${1}="${2}"`)
	for _, b := range bases {
		out = strings.Replace(out, baseMark, b, 1)
	}
	return out
}

// devRouterBasePathScript is injected into every proxied HTML index, before any
// app script runs.
//
// ── The bug it removes ──────────────────────────────────────────────────────
//
// The browser lane serves a guest app under a PATH PREFIX (/dev-web/, or
// /d/<deviceId>/dev-web/ over the relay). Assets already resolve — the rewrite
// below makes them relative. But a client-side router reads
// window.location.pathname, sees "/dev-web/", matches no route, and renders its
// own 404. Verified 2026-07-25 against sfmg and yaver.io, both of which mounted
// successfully and then displayed
//
//	Unmatched Route / Page could not be found.
//
// A perfectly healthy dev server producing a screen that says the page does not
// exist — and every layer above reported success, because the app really had
// loaded. HTTP 200, bundle fetched, React mounted, wrong route.
//
// ── Why both halves are required ────────────────────────────────────────────
//
// Proven by experiment, both directions:
//   - rewrite the path alone  → assets are relative to the document, so they
//     resolve at the ROOT and 404. Blank screen. (Measured: #root children 0.)
//   - pin the base alone      → assets fine, router still sees /dev-web/ and
//     still renders Unmatched Route.
//   - both                    → the real app. sfmg rendered
//     "Todo · All · Active · Completed · Add your first todo above."
//
// ── Why the base is computed at RUNTIME ─────────────────────────────────────
//
// A hardcoded "/dev-web/" breaks over the relay, where the document lives at
// /d/<deviceId>/dev-web/ — the same class of bug the comment above this file
// records for "/dev/". Reading location.pathname at load time is transport
// agnostic: localhost, LAN, relay, and any future prefix all work with no
// knowledge of the transport.
//
// Idempotent and defensive: it runs once, does nothing when there is no proxy
// prefix, and a throw inside it must never stop the page from loading.
const devRouterBasePathScript = `<script>(function(){try{
var p=location.pathname;
var m=p.match(/^(.*\/dev(?:-web)?)(\/.*)?$/);
if(!m){return;}
var dir=m[1]+"/";
if(!document.querySelector("base")){
  var b=document.createElement("base");
  b.href=dir;
  (document.head||document.documentElement).insertBefore(b,(document.head||document.documentElement).firstChild);
}
var rest=(m[2]||"/");
if(rest!==p){history.replaceState(null,"",rest+location.search+location.hash);}
}catch(e){}})();</script>`

// injectRouterBasePath places the script immediately after <head> so it runs
// before the entry bundle. Returns the input unchanged when there is no head or
// the script is already present.
func injectRouterBasePath(html string) string {
	if strings.Contains(html, "devRouterBase") || strings.Contains(html, `m.match(/^(.*\/dev`) {
		return html
	}
	loc := devHeadOpenRe.FindStringIndex(html)
	if loc == nil {
		return html
	}
	return html[:loc[1]] + devRouterBasePathScript + html[loc[1]:]
}

// rewriteDevIndexBaseHref is the httputil.ReverseProxy ModifyResponse hook. It
// rewrites the base href ONLY for HTML documents; every other content type
// (JS, wasm, images, JSON) passes through untouched so a rewrite bug can never
// corrupt a bundle.
//
// Best-effort by design: if anything about reading/decoding the body is
// unexpected, the original response is left exactly as-is. A preview that
// renders slightly wrong is recoverable; a proxy that drops asset bytes is not.
func rewriteDevIndexBaseHref(resp *http.Response) error {
	if resp == nil || resp.Body == nil {
		return nil
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if !strings.Contains(ct, "text/html") {
		return nil
	}

	// Read (bounded) the body, decompressing gzip if the dev server used it.
	// 8 MiB is far above any index.html; a document larger than that is not one
	// we should be string-rewriting, so pass it through.
	const maxIndexBytes = 8 << 20
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxIndexBytes+1))
	_ = resp.Body.Close()
	if err != nil || len(raw) > maxIndexBytes {
		// Restore what we read so the response is not truncated, then bail.
		resp.Body = io.NopCloser(bytes.NewReader(raw))
		resp.Header.Del("Content-Length")
		return nil
	}

	gzipped := strings.Contains(strings.ToLower(resp.Header.Get("Content-Encoding")), "gzip")
	body := raw
	if gzipped {
		zr, zerr := gzip.NewReader(bytes.NewReader(raw))
		if zerr != nil {
			resp.Body = io.NopCloser(bytes.NewReader(raw))
			return nil
		}
		dec, derr := io.ReadAll(io.LimitReader(zr, maxIndexBytes+1))
		_ = zr.Close()
		if derr != nil || len(dec) > maxIndexBytes {
			resp.Body = io.NopCloser(bytes.NewReader(raw))
			return nil
		}
		body = dec
	}

	// Assets first (relative paths), THEN the router base-path script. Order
	// matters only for readability — they touch different things — but both are
	// required: assets alone leave the guest router on its 404 route, and the
	// route rewrite alone breaks every relative asset. See injectRouterBasePath.
	rewritten := injectRouterBasePath(rewriteDevIndexBaseHrefHTML(string(body)))
	// Carry the page's auth query onto its sub-resources. Over the public relay
	// every proxied request is authenticated, and a browser cannot add ?token/
	// &__rp to the requests the HTML parser or a dynamic loader issues — so the
	// document loaded and every script/asset 401'd. applyPreviewRelayAuth existed
	// for exactly this and was never wired into the proxy (measured live
	// 2026-07-26: entry.bundle 401 through /d/<id>/dev-web/ while the page
	// rendered its empty #root). No auth query on the request → no-op, so LAN
	// direct traffic is untouched.
	if req := resp.Request; req != nil && req.URL != nil {
		rewritten = applyPreviewRelayAuth(rewritten, req.URL.RawQuery)
	}
	if rewritten == string(body) {
		// Nothing changed — hand back the exact original bytes (still
		// compressed if it was), so we never re-encode needlessly.
		resp.Body = io.NopCloser(bytes.NewReader(raw))
		return nil
	}

	out := []byte(rewritten)
	// We decompressed to rewrite; serve plaintext and drop the stale encoding
	// header rather than re-gzip (simpler, and index.html is tiny).
	if gzipped {
		resp.Header.Del("Content-Encoding")
	}
	resp.Body = io.NopCloser(bytes.NewReader(out))
	resp.ContentLength = int64(len(out))
	resp.Header.Set("Content-Length", strconv.Itoa(len(out)))
	return nil
}
