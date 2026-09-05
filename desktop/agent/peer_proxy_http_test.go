package main

import "testing"

func TestPeerProxyContentTypePreservesBrowserDogfoodAssets(t *testing.T) {
	tests := []struct {
		name string
		path string
		body string
		want string
	}{
		{name: "expo document", path: "/dev/", body: "<!DOCTYPE html><html><head><title>Yaver</title></head></html>", want: "text/html; charset=utf-8"},
		{name: "metro bundle", path: "/dev/node_modules/expo-router/entry.bundle?platform=web", body: "globalThis.__expo = true;", want: "application/javascript; charset=utf-8"},
		{name: "stylesheet", path: "/dev/assets/app.css", body: "body { color: black; }", want: "text/css; charset=utf-8"},
		{name: "agent json", path: "/agent/runners", body: `{"ok":true}`, want: "application/json"},
		{name: "json error beats asset extension", path: "/dev/app.bundle", body: `{"error":"compile failed"}`, want: "application/json"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := peerProxyContentType(tt.path, []byte(tt.body)); got != tt.want {
				t.Fatalf("peerProxyContentType(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}
