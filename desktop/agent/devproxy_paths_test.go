package main

import "testing"

// Pins the /dev-web/ exemption in the WS relay fallback: the 10MB response
// cap truncated 17MB entry bundles and the frame-strip skipped /dev-web/,
// while the QUIC path (streaming) worked — a transport-dependent blank
// preview.
func TestIsDevProxyPathCoversDevWeb(t *testing.T) {
	yes := []string{"/dev/", "/dev/status", "/dev-web/", "/dev-web/entry.bundle"}
	no := []string{"/", "/info", "/dev", "/dev-webx"}
	for _, p := range yes {
		if !isDevProxyPath(p) {
			t.Errorf("isDevProxyPath(%q) = false, want true", p)
		}
	}
	for _, p := range no {
		if isDevProxyPath(p) {
			t.Errorf("isDevProxyPath(%q) = true, want false", p)
		}
	}
}
