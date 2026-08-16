package main

import (
	"os"
	"strings"
	"testing"
)

func TestIOSSimulatorDimsPreferSimctlOverWDA(t *testing.T) {
	data, err := os.ReadFile("remote_runtime_target.go")
	if err != nil {
		t.Fatalf("read remote_runtime_target.go: %v", err)
	}
	src := string(data)
	fn := strings.Index(src, "func (iosSimulatorTarget) Dims(")
	if fn < 0 {
		t.Fatal("iosSimulatorTarget.Dims not found")
	}
	body := src[fn:]
	probe := strings.Index(body, "probeIOSDims(ctx, deviceID)")
	wda := strings.Index(body, "wdaClientFor(wdaBaseURL()).WindowSize(ctx)")
	if probe < 0 || wda < 0 {
		t.Fatalf("expected both simctl and WDA dim probes in Dims, got:\n%s", body[:min(len(body), 600)])
	}
	if probe > wda {
		t.Fatal("simulator dims consult WDA before simctl; a running iPhone WDA can make tvOS/visionOS report iPhone dimensions")
	}
}

func TestIOSSimulatorScreenshotPrefersSimctlOverWDA(t *testing.T) {
	data, err := os.ReadFile("remote_runtime_target.go")
	if err != nil {
		t.Fatalf("read remote_runtime_target.go: %v", err)
	}
	src := string(data)
	fn := strings.Index(src, "func (iosSimulatorTarget) Screenshot(")
	if fn < 0 {
		t.Fatal("iosSimulatorTarget.Screenshot not found")
	}
	body := src[fn:]
	simctl := strings.Index(body, "IOSSimDriver{}).Screenshot(ctx, deviceID, pngPath)")
	wda := strings.Index(body, "wdaClientFor(wdaBaseURL()).Screenshot(ctx)")
	if simctl < 0 || wda < 0 {
		t.Fatalf("expected both simctl and WDA screenshot paths in Screenshot, got:\n%s", body[:min(len(body), 600)])
	}
	if simctl > wda {
		t.Fatal("simulator screenshot consults WDA before simctl; a running iPhone WDA can feed the wrong surface")
	}
}
