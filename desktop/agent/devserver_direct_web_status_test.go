package main

// The direct browser lane (`expo start --web` as the MAIN process) reported
// itself dead while it was serving. /dev/start with platform="web" sets
// devMode="web" and serves the web target on the MAIN port — there is no
// sibling, so webPort stayed 0 forever. The /dev/status guard added in
// adabdb1fa ("a dead browser preview kept reporting itself as serving") reads
// devMode=="web" && webPort==0 as "the preview exited", which is the PERMANENT
// state of a healthy direct-lane preview. Observed live on ubuntu-4gb-hel1-1
// 2026-07-26: expo alive on :8082, curl 200 with the app's HTML, and
// /dev/status answering serving:false, "the browser preview exited…" — for the
// whole first compile and forever after. Every surface (phone, web, TV) reads
// that payload, so the RN browser lane was unusable against agent 1.99.371.
//
// The contract these tests pin: WebPort means "the port serving the browser
// preview" — the sibling's when one runs, the main port when the main process
// IS the web server, 0 only when nothing can serve a browser.

import "testing"

func TestDirectWebLaneReportsMainPortAsWebPort(t *testing.T) {
	e := &ExpoDevServer{devMode: "web"}
	e.port = 8082
	e.running = true

	if got := e.WebPort(); got != 8082 {
		t.Fatalf("direct web lane: WebPort() = %d, want 8082 (the main process IS the web server)", got)
	}
	st := e.Status()
	if st.WebPort != 8082 {
		t.Fatalf("direct web lane: Status().WebPort = %d, want 8082 — a 0 here makes /dev/status declare a healthy preview exited", st.WebPort)
	}
	if st.BundleURL != "/dev/" {
		t.Fatalf("direct web lane: Status().BundleURL = %q, want /dev/ (the proxy to the main port, with base-href rewrite)", st.BundleURL)
	}
}

func TestSiblingWebPortStillWinsOverMainPort(t *testing.T) {
	e := &ExpoDevServer{devMode: "dev-client", webPort: 19006}
	e.port = 8081
	e.running = true

	if got := e.WebPort(); got != 19006 {
		t.Fatalf("sibling lane: WebPort() = %d, want 19006", got)
	}
	st := e.Status()
	if st.WebPort != 19006 {
		t.Fatalf("sibling lane: Status().WebPort = %d, want 19006", st.WebPort)
	}
	if st.BundleURL != "/dev-web/" {
		t.Fatalf("sibling lane: Status().BundleURL = %q, want /dev-web/", st.BundleURL)
	}
}

func TestDeadDirectWebLaneReportsZero(t *testing.T) {
	e := &ExpoDevServer{devMode: "web"}
	e.port = 8082
	e.running = false

	if got := e.WebPort(); got != 0 {
		t.Fatalf("dead direct web lane: WebPort() = %d, want 0 (not running means nothing serves)", got)
	}
}

// StartWebPreview in direct-web mode must NOT spawn a second `expo start
// --web`: the main process already serves the web target, and the manager
// auto-calls StartWebPreview for every platform="web" start — on a 4 GB box a
// redundant sibling is a second full web compile fighting the first for RAM.
func TestStartWebPreviewIsNoopInDirectWebMode(t *testing.T) {
	e := &ExpoDevServer{devMode: "web"}
	e.port = 8082
	e.running = true

	port, err := e.StartWebPreview(nil, "/tmp/does-not-matter")
	if err != nil {
		t.Fatalf("StartWebPreview in direct web mode: unexpected error %v", err)
	}
	if port != 8082 {
		t.Fatalf("StartWebPreview in direct web mode: port = %d, want the main port 8082", port)
	}
	e.webMu.Lock()
	spawned := e.webCmd != nil
	e.webMu.Unlock()
	if spawned {
		t.Fatalf("StartWebPreview in direct web mode spawned a sibling process — that is a redundant second compile")
	}
}
