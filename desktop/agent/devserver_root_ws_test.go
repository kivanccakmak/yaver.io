package main

import "testing"

func TestFlutterRootDevWebSocketPathIsNarrow(t *testing.T) {
	ok := []string{
		"/$dwdsSseHandler",
		"/$dwdsSseHandler/abc",
	}
	for _, path := range ok {
		if !isFlutterRootDevWebSocketPath(path) {
			t.Fatalf("%s should be proxied to the active Flutter dev server", path)
		}
	}

	deny := []string{
		"/",
		"/Main/Dashboard",
		"/flutter.js",
		"/sockjs-node",
		"/$dwdsSseHandlerEvil",
		"/dev/$dwdsSseHandler",
	}
	for _, path := range deny {
		if isFlutterRootDevWebSocketPath(path) {
			t.Fatalf("%s must not be proxied at agent root", path)
		}
	}
}
