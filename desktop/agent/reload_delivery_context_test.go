package main

import (
	"context"
	"testing"
)

func TestReloadDeliveryContextWebBundlePreview(t *testing.T) {
	project := t.TempDir()
	srv := &HTTPServer{devServerMgr: NewDevServerManager()}
	srv.devServerMgr.webBundleInfo = WebBundleInfo{
		Target:   "web-js-bundle",
		BuildDir: t.TempDir(),
		WorkDir:  project,
		BuiltAt:  "2026-07-27T00:00:00Z",
	}

	got := reloadDeliveryContext(srv, project, DevServerTarget{}, 0)
	if got["reloadTarget"] != "web-bundle-preview" {
		t.Fatalf("reloadTarget = %v, want web-bundle-preview", got["reloadTarget"])
	}
	if got["developmentMode"] != "web-bundle" {
		t.Fatalf("developmentMode = %v, want web-bundle", got["developmentMode"])
	}
	if got["webBundleTarget"] != "web-js-bundle" {
		t.Fatalf("webBundleTarget = %v, want web-js-bundle", got["webBundleTarget"])
	}
}

func TestReloadDeliveryContextHermesPreviewWorker(t *testing.T) {
	got := reloadDeliveryContext(&HTTPServer{}, "", DevServerTarget{
		DeviceID:    "worker-1",
		DeviceName:  "Browser Worker",
		DeviceClass: "browser",
	}, 1)
	if got["reloadTarget"] != "preview-worker" {
		t.Fatalf("reloadTarget = %v, want preview-worker", got["reloadTarget"])
	}
	if got["developmentMode"] != "preview-worker" {
		t.Fatalf("developmentMode = %v, want preview-worker", got["developmentMode"])
	}
}

func TestDetectReloadDeliveryContextLiveBrowserDevServer(t *testing.T) {
	project := t.TempDir()
	dev := NewDevServerManager()
	dev.active = &devServerSession{
		server: &dogfoodReloadTestServer{workDir: project},
	}
	srv := &HTTPServer{devServerMgr: dev}

	got := reloadDeliveryContext(srv, project, DevServerTarget{}, 0)
	if got["reloadTarget"] != "browser-dev-server" {
		t.Fatalf("reloadTarget = %v, want browser-dev-server", got["reloadTarget"])
	}
	if got["developmentMode"] != "browser-dev-server" {
		t.Fatalf("developmentMode = %v, want browser-dev-server", got["developmentMode"])
	}
}

func TestDetectReloadDeliveryContextHybridNativeLaneIsNotBrowserTarget(t *testing.T) {
	project := t.TempDir()
	dev := NewDevServerManager()
	dev.active = &devServerSession{
		server: &reloadContextHybridServer{workDir: project},
	}
	srv := &HTTPServer{devServerMgr: dev}

	got := reloadDeliveryContext(srv, project, DevServerTarget{}, 0)
	if got["reloadTarget"] != "none" {
		t.Fatalf("reloadTarget = %v, want none for hybrid native lane", got["reloadTarget"])
	}
}

type reloadContextHybridServer struct{ workDir string }

func (s *reloadContextHybridServer) Name() string                               { return "expo" }
func (s *reloadContextHybridServer) Detect(string) bool                         { return true }
func (s *reloadContextHybridServer) Start(context.Context, DevServerOpts) error { return nil }
func (s *reloadContextHybridServer) Stop() error                                { return nil }
func (s *reloadContextHybridServer) Port() int                                  { return 8081 }
func (s *reloadContextHybridServer) BundleURL(string) string                    { return "/dev/" }
func (s *reloadContextHybridServer) SupportsHotReload() bool                    { return true }
func (s *reloadContextHybridServer) Reload() error                              { return nil }
func (s *reloadContextHybridServer) PreStart(string, int, string)               {}
func (s *reloadContextHybridServer) Kind() DevServerKind                        { return DevServerKindHybrid }
func (s *reloadContextHybridServer) Status() DevServerStatus {
	return DevServerStatus{Framework: "expo", Running: true, Serving: true, DevMode: "dev-client", WorkDir: s.workDir}
}

func TestReloadDeliveryContextNoRemoteListener(t *testing.T) {
	got := reloadDeliveryContext(&HTTPServer{}, "", DevServerTarget{DeviceID: "phone-1"}, 0)
	if got["reloadTarget"] != "none" {
		t.Fatalf("reloadTarget = %v, want none", got["reloadTarget"])
	}
	if got["targetDeviceId"] != "phone-1" {
		t.Fatalf("targetDeviceId = %v, want phone-1", got["targetDeviceId"])
	}
}
