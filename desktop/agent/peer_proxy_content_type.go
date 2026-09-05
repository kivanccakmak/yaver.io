package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
)

// peerProxyContentType recovers the target response's media type until the
// remote transport carries headers alongside status and body. It is kept pure
// so this browser-serving contract can be tested without a relay fixture.
func peerProxyContentType(requestPath string, body []byte) string {
	trimmed := bytes.TrimSpace(body)
	if json.Valid(trimmed) {
		return "application/json"
	}
	if bytes.HasPrefix(bytes.ToLower(trimmed), []byte("<!doctype html")) ||
		bytes.HasPrefix(bytes.ToLower(trimmed), []byte("<html")) {
		return "text/html; charset=utf-8"
	}
	rawPath, _, _ := strings.Cut(requestPath, "?")
	switch strings.ToLower(filepath.Ext(rawPath)) {
	case ".js", ".mjs", ".cjs", ".bundle":
		return "application/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json", ".map":
		return "application/json"
	case ".svg":
		return "image/svg+xml"
	}
	return http.DetectContentType(body)
}
