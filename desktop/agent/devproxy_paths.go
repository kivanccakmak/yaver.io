package main

import "strings"

// isDevProxyPath reports whether a tunneled request path belongs to the dev
// preview proxy — /dev/ (dev endpoints + direct serve) or /dev-web/ (the web
// sibling proxy: Expo Web / Flutter web bundles, CanvasKit, assets).
//
// The WS relay fallback applies two dev-only affordances — the raised
// response-size cap (dev bundles are 20-200MB) and the frame-blocking-header
// strip (the dashboard iframes these). /dev-web/ used to miss both because
// the sites tested `strings.HasPrefix(path, "/dev/")` by hand; the QUIC path
// streams so nothing noticed until the WS fallback carried a 17MB entry
// bundle. Keep relay/devpaths.go (the tunnel client's copy) in sync.
func isDevProxyPath(path string) bool {
	return strings.HasPrefix(path, "/dev/") || strings.HasPrefix(path, "/dev-web/")
}
