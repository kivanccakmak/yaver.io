package main

import "testing"

// The 10MB tunnel response cap exempted only /dev/ — /dev-web/ (the Expo Web
// sibling proxy, where 17MB entry bundles and CanvasKit blobs live) missed
// every exemption: the size cap, the frame-header strip, and the long-request
// timeout. The QUIC path streams so it worked; the WS/HTTP fallback truncated.
// One predicate now decides "is this a dev-proxy path" for all three.
func TestIsDevProxyPath(t *testing.T) {
	yes := []string{"/dev/", "/dev/status", "/dev-web/", "/dev-web/entry.bundle", "/dev-web/canvaskit/canvaskit.wasm"}
	no := []string{"/", "/info", "/devices", "/dev", "/dev-webx", "/d/abc/dev/"}
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

// /dev-web/ responses can be tens of MB over slow links — they get the long
// client timeout like the /dev/ build endpoints, not the 60s default that
// turns a slow bundle fetch into an HTML 504 the client can't parse.
func TestDevWebIsLongRequest(t *testing.T) {
	if !isLongDevRequest("/dev-web/entry.bundle") {
		t.Fatal("/dev-web/ fetch must qualify for the long timeout")
	}
	if !isLongDevRequest("/dev/build-native") {
		t.Fatal("existing long endpoint regressed")
	}
	if isLongDevRequest("/dev/status") {
		t.Fatal("/dev/status is quick — must keep the short timeout")
	}
}
