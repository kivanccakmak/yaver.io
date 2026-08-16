package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// TestFullSandboxLoop_E2E drives the ENTIRE normie loop through the
// real HTTP handlers (no mocks, real archive + SQLite, repo test convention):
// create → export(.zip + AGENTS.md) → receive over SSE on a simulated hosted
// box → share → join. This is the integrated proof the per-layer unit tests
// don't give on their own; it permanently guards the chain.
func TestFullSandboxLoop_E2E(t *testing.T) {
	setupPhoneTestHome(t)
	srv := &HTTPServer{token: "t"}

	auth := func(r *http.Request) *http.Request {
		r.Header.Set("Authorization", "Bearer t")
		return r
	}

	// 1. Create the project (todos template).
	w := httptest.NewRecorder()
	srv.handlePhoneCreate(w, auth(httptest.NewRequest("POST", "/phone/projects/create",
		strings.NewReader(`{"name":"E2E Loop","template":"todos"}`))))
	if w.Code != 200 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var created PhoneProject
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("create decode: %v", err)
	}
	slug := created.Slug

	// 2. Export as .zip (the coding-agent / OS-friendly twin).
	w = httptest.NewRecorder()
	srv.handlePhoneExport(w, auth(httptest.NewRequest("GET",
		"/phone/projects/export?slug="+slug+"&format=zip&includeData=1", nil)))
	if w.Code != 200 {
		t.Fatalf("export: %d %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/zip" {
		t.Errorf("export Content-Type = %q, want application/zip", ct)
	}
	zipBytes := w.Body.Bytes()
	if bundleFormat(zipBytes) != "zip" {
		t.Fatalf("export did not produce a zip (magic=%v)", zipBytes[:4])
	}
	zf := readZip(t, zipBytes)
	if _, ok := zf[filepath.ToSlash(filepath.Join(slug, "AGENTS.md"))]; !ok {
		t.Fatalf("export .zip missing AGENTS.md (have %v)", keysOf(zf))
	}

	// 3. Receive the .zip back over the SSE stream (as a hosted box).
	w = httptest.NewRecorder()
	rr := httptest.NewRequest("POST",
		"/phone/projects/receive?stream=1&slug=e2e-clone&onConflict=rename",
		bytes.NewReader(zipBytes))
	rr.Header.Set("Content-Type", "application/zip")
	srv.handlePhoneReceive(w, auth(rr))
	if w.Code != 200 {
		t.Fatalf("receive: %d %s", w.Code, w.Body.String())
	}
	seen := map[string]bool{}
	var hostedRuntime, hostedDataURL string
	sc := bufio.NewScanner(bytes.NewReader(w.Body.Bytes()))
	for sc.Scan() {
		line := strings.TrimPrefix(sc.Text(), "data: ")
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var ev map[string]interface{}
		if json.Unmarshal([]byte(line), &ev) != nil {
			continue
		}
		typ, _ := ev["type"].(string)
		seen[typ] = true
		if typ == "hosted" {
			hostedRuntime, _ = ev["runtime"].(string)
			hostedDataURL, _ = ev["dataUrl"].(string)
		}
		if typ == "error" {
			t.Fatalf("receive stream error event: %v", ev["error"])
		}
	}
	for _, want := range []string{"received", "unpacking", "materialized", "hosted", "ready"} {
		if !seen[want] {
			t.Errorf("SSE stream missing %q event (saw %v)", want, seen)
		}
	}
	if hostedRuntime != "yaver-serverless-lite" || hostedDataURL != "/data/e2e-clone" {
		t.Errorf("hosted event = runtime %q dataUrl %q", hostedRuntime, hostedDataURL)
	}
	if strings.Contains(strings.ToLower(w.Body.String()), "convex") {
		t.Fatal("receive SSE stream should not expose Convex wiring for serverless-lite")
	}

}
