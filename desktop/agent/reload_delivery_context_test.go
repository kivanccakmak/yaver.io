package main

import "testing"

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

func TestReloadDeliveryContextNoRemoteListener(t *testing.T) {
	got := reloadDeliveryContext(&HTTPServer{}, "", DevServerTarget{DeviceID: "phone-1"}, 0)
	if got["reloadTarget"] != "none" {
		t.Fatalf("reloadTarget = %v, want none", got["reloadTarget"])
	}
	if got["targetDeviceId"] != "phone-1" {
		t.Fatalf("targetDeviceId = %v, want phone-1", got["targetDeviceId"])
	}
}
