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

// rewriteDevIndexBaseHrefHTML rewrites a root <base href> to devProxyBaseHref.
// Pure and content-only so it can be unit-tested without a live proxy.
// Returns the input unchanged when there is nothing root-based to rewrite.
func rewriteDevIndexBaseHrefHTML(html string) string {
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

	rewritten := rewriteDevIndexBaseHrefHTML(string(body))
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
