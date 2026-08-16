package main

import "testing"

func probeIDs(probes []developmentToolProbe) map[string]bool {
	out := make(map[string]bool, len(probes))
	for _, probe := range probes {
		out[probe.id] = true
	}
	return out
}

func TestDevelopmentDoctorPlatformMatrix(t *testing.T) {
	common := []string{"git", "node", "npm", "react-native", "go", "flutter", "java", "android", "docker", "vercel", "cloudflare", "supabase", "firebase", "convex", "github", "gitlab"}
	for _, goos := range []string{"darwin", "linux", "windows"} {
		ids := probeIDs(developmentToolProbesFor(goos))
		for _, id := range common {
			if !ids[id] {
				t.Errorf("%s Doctor is missing common check %q", goos, id)
			}
		}
	}
	darwin := probeIDs(developmentToolProbesFor("darwin"))
	if !darwin["xcode"] || !darwin["codesign"] {
		t.Fatal("macOS Doctor must probe Xcode and code signing")
	}
	windows := probeIDs(developmentToolProbesFor("windows"))
	for _, id := range []string{"powershell", "winget", "wsl"} {
		if !windows[id] {
			t.Errorf("Windows Doctor is missing %q", id)
		}
	}
	linux := probeIDs(developmentToolProbesFor("linux"))
	if !linux["shell"] || !linux["systemd"] {
		t.Fatal("Linux Doctor must probe its shell and user-service lane")
	}
}

func TestDevelopmentDoctorNeverAdvertisesUnixInstallerOnWindows(t *testing.T) {
	for _, probe := range developmentToolProbesFor("windows") {
		fix := doctorFixForMissingToolFor("windows", probe)
		if fix != nil && fix.Kind == "install" {
			t.Errorf("Windows check %q advertised Unix HTTP installer %+v", probe.id, fix)
		}
	}
	fix := doctorFixForMissingToolFor("linux", developmentToolProbe{id: "go", install: "go"})
	if fix == nil || fix.Kind != "install" || fix.Path != "/install/go" || fix.Stream != "install:go" {
		t.Fatalf("Linux deterministic fix route = %+v", fix)
	}
}

func TestDevelopmentDoctorRejectsUnsupportedDesktopOS(t *testing.T) {
	for _, goos := range []string{"darwin", "linux", "windows"} {
		if got := platformDoctorChecksFor(goos, "amd64")[0].Status; got != "pass" {
			t.Errorf("%s status = %q, want pass", goos, got)
		}
	}
	if got := platformDoctorChecksFor("plan9", "amd64")[0].Status; got != "fail" {
		t.Fatalf("unsupported OS status = %q, want fail", got)
	}
}
