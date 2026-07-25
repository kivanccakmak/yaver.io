package main

// devserver_bundleurl_test.go — /dev/status must always name the URL the client
// should load.
//
// The incident (2026-07-25): a Mac mini serving a Flutter web preview answered
//
//   {"framework":"flutter","running":true,"serving":true,"port":9100,
//    "bundleUrl":"","directUrl":"http://192.168.111.25:9100", ...}
//
// The phone gates its preview WebView on bundleUrl (an empty uri issues no
// request, so nothing can fail or retry), so it sat on "Waiting for the dev
// server to report its address…" indefinitely while the dev server was healthy.
//
// Root cause was omission, not logic: every framework implements BundleURL()
// correctly, but only ExpoDevServer.Status() copied it into the status payload.
// Flutter, Vite, Next, React Native and SwiftWasm each returned it empty. The
// fix derives it in DevServerManager.Status() from the interface method, and
// this test walks the REGISTRY so a framework added later is covered without
// anyone remembering to extend a list.
//
// Break it by removing the `s.BundleURL = m.active.server.BundleURL("")` line in
// devserver.go and re-running: 5 of the 6 registered frameworks fail.

import (
	"strings"
	"testing"
)

func TestStatusAlwaysReportsBundleURLForEveryFramework(t *testing.T) {
	devServerRegistryMu.Lock()
	registered := make([]DevServer, len(devServerRegistry))
	copy(registered, devServerRegistry)
	devServerRegistryMu.Unlock()

	if len(registered) < 5 {
		t.Fatalf("dev server registry looks empty (%d entries) — test would pass vacuously", len(registered))
	}

	for _, ds := range registered {
		name := ds.Name()
		t.Run(name, func(t *testing.T) {
			// Fresh instance per framework: registry entries are shared
			// singletons and PreStart mutates them.
			ds.PreStart(name, 9100, t.TempDir())

			mgr := &DevServerManager{}
			mgr.active = &devServerSession{server: ds}

			status := mgr.Status()
			if status == nil {
				t.Fatalf("%s: Status() returned nil with an active session", name)
			}
			if strings.TrimSpace(status.BundleURL) == "" {
				t.Errorf("%s: /dev/status reported an EMPTY bundleUrl — the phone would wait forever "+
					"for the dev server to report its address (BundleURL() itself returns %q)",
					name, ds.BundleURL(""))
			}
			if status.Framework == "" {
				t.Errorf("%s: /dev/status reported an empty framework name", name)
			}
		})
	}
}

// A status payload that claims to be serving must carry an address. This is the
// invariant the phone actually depends on, stated independently of which field
// happens to fill it.
func TestServingStatusNeverLacksAnAddress(t *testing.T) {
	ds := &FlutterDevServer{}
	ds.PreStart("flutter", 9100, t.TempDir())

	mgr := &DevServerManager{}
	mgr.active = &devServerSession{server: ds}

	status := mgr.Status()
	if status == nil {
		t.Fatal("Status() returned nil with an active session")
	}
	if status.BundleURL == "" {
		t.Fatal("serving status with no bundleUrl: the client has nothing to load and no reason why")
	}
	if !strings.HasPrefix(status.BundleURL, "/") {
		t.Errorf("bundleUrl %q must be a relative path the client appends to the agent origin", status.BundleURL)
	}
}

// A launching session must report itself as launching, not as nothing.
//
// The phone (and the web dashboard) treat "not running AND not building" as "no
// dev server here": mobile's isActiveDevServerStatus is literally
// `running === true || building === true`. So during the 30s–3min a cold web
// compile takes, /dev/status answering `running:false` with no building flag
// meant the preview screen showed "Waiting for the dev server to report its
// address…" with no elapsed time AND never opened the /dev/events log stream —
// the longest wait in the product was the one with the least information, while
// the agent streamed the full log tail every 5s.
//
// Break it by removing the `s.Building = true` block in DevServerManager.Status().
func TestLaunchingSessionReportsItselfAsBuilding(t *testing.T) {
	ds := &FlutterDevServer{}
	ds.PreStart("flutter", 9100, t.TempDir()) // session created, nothing bound yet

	mgr := &DevServerManager{}
	mgr.active = &devServerSession{server: ds}

	status := mgr.Status()
	if status == nil {
		t.Fatal("Status() returned nil with an active session")
	}
	if status.Running {
		t.Fatal("test precondition broken: PreStart should not mark the server running")
	}
	if !status.Building {
		t.Error("a launching dev server reported neither running nor building — " +
			"every client reads that as 'no dev server here', so the user gets a " +
			"contentless spinner and no log stream for the whole compile")
	}
	if status.ServingLabel == "" {
		t.Error("launching status carries no label for the UI to show")
	}
}

// A FAILED session must NOT be dressed up as still launching — that would turn a
// named failure into an eternal "Starting…".
func TestFailedSessionIsNotReportedAsBuilding(t *testing.T) {
	ds := &FlutterDevServer{}
	ds.PreStart("flutter", 9100, t.TempDir())

	mgr := &DevServerManager{}
	mgr.active = &devServerSession{server: ds, failed: true}

	status := mgr.Status()
	if status == nil {
		t.Fatal("Status() returned nil with an active session")
	}
	if status.Building {
		t.Error("a failed session was reported as building — the UI would show " +
			"'Starting…' forever instead of the failure and its cause")
	}
}
