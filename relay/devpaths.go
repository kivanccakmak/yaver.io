package main

import "strings"

// isDevProxyPath reports whether a tunneled request path belongs to the dev
// preview proxy — /dev/ (agent dev endpoints + direct serve) or /dev-web/
// (the web sibling proxy: Expo Web / Flutter web bundles, CanvasKit, assets).
//
// One predicate on purpose: the WS/HTTP fallback tunnels apply three
// dev-only affordances — the raised response-size cap (dev bundles are
// 20-200MB), the frame-blocking-header strip (the dashboard iframes these),
// and the long client timeout. /dev-web/ used to miss all three because each
// site tested `strings.HasPrefix(path, "/dev/")` by hand; the QUIC path
// streams so nothing noticed until the fallback carried a 17MB entry bundle.
// Keep the desktop agent's copy (desktop/agent) in sync.
func isDevProxyPath(path string) bool {
	return strings.HasPrefix(path, "/dev/") || strings.HasPrefix(path, "/dev-web/")
}
