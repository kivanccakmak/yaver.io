package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func writeProjectManifestForTest(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".yaver"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".yaver", "project.yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestProjectMCPSelectionMergesRequiredAndExplicitAndHonorsDisabled(t *testing.T) {
	dir := t.TempDir()
	writeProjectManifestForTest(t, dir, `
name: construction-reports
adapters:
  required: [office-powerpoint]
  optional: [supabase, vercel]
  disabled: [figma]
  allow:
    office-powerpoint: [office_status, office_reload_addin]
`)

	got, err := projectMCPSelection(dir, []string{"vercel", "figma", "supabase"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"office-powerpoint", "supabase", "vercel"}
	if !reflect.DeepEqual(got.Servers, want) {
		t.Fatalf("servers = %#v, want %#v", got.Servers, want)
	}
	if !reflect.DeepEqual(got.Allow["office-powerpoint"], []string{"office_reload_addin", "office_status"}) {
		t.Fatalf("allow = %#v", got.Allow)
	}
}

func TestProjectMCPSelectionSupportsToolsMCPCompatibilityShape(t *testing.T) {
	dir := t.TempDir()
	writeProjectManifestForTest(t, dir, `
name: dashboard
tools:
  mcp:
    required: [supabase]
`)
	got, err := projectMCPSelection(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Servers, []string{"supabase"}) {
		t.Fatalf("servers = %#v", got.Servers)
	}
}

func TestProjectMCPSelectionWithoutManifestPreservesExplicitSelection(t *testing.T) {
	got, err := projectMCPSelection(t.TempDir(), []string{"vercel", "supabase", "vercel"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Servers, []string{"supabase", "vercel"}) {
		t.Fatalf("servers = %#v", got.Servers)
	}
}

func TestProjectMCPSelectionRejectsUnsafeAdapterName(t *testing.T) {
	dir := t.TempDir()
	writeProjectManifestForTest(t, dir, `
adapters:
  required: ["../../run-this"]
`)
	if _, err := projectMCPSelection(dir, nil); err == nil {
		t.Fatal("unsafe adapter name was accepted")
	}
}

func TestStackDetectBuildsProductDeployAndAdapterProfile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{
  "name": "construction-reports",
  "dependencies": {
    "vite": "latest",
    "@supabase/supabase-js": "latest"
  }
}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.xml"), []byte(`<OfficeApp><Hosts><Host Name="Presentation"/></Hosts></OfficeApp>`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "supabase"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "supabase", "config.toml"), []byte("project_id = \"demo\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	profile := stackDetect(dir)
	if len(profile.Products) != 1 || profile.Products[0].ID != "office-addin" {
		t.Fatalf("products = %#v", profile.Products)
	}
	if !containsAnyString(profile.DeployTargets, "web", "backend", "powerpoint") {
		t.Fatalf("deploy targets = %#v", profile.DeployTargets)
	}
	if !containsAnyString(profile.Adapters, "office-powerpoint", "supabase") {
		t.Fatalf("adapters = %#v", profile.Adapters)
	}
}

func TestStackDetectRecognizesReactNativeMobileReleaseTargets(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{
  "name": "field-app",
  "dependencies": { "react-native": "latest", "@supabase/supabase-js": "latest" }
}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app.json"), []byte(`{"expo":{"name":"Field App"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	d := stackDetect(dir)
	if d.Framework != FwReactNative && d.Framework != FwExpo {
		t.Fatalf("framework = %q, want react native or expo", d.Framework)
	}
	if !containsAnyString(d.DeployTargets, "testflight", "google-play", "web") {
		t.Fatalf("deploy targets = %#v", d.DeployTargets)
	}
	if !containsAnyString(d.Adapters, "supabase") {
		t.Fatalf("adapters = %#v", d.Adapters)
	}
}

func TestStackDetectRecognizesExplicitNPMPublication(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{
  "name": "@acme/field-sdk",
  "publishConfig": { "access": "public" }
}`), 0o644); err != nil {
		t.Fatal(err)
	}
	d := stackDetect(dir)
	if !containsAnyString(d.DeployTargets, "npm") {
		t.Fatalf("deploy targets = %#v", d.DeployTargets)
	}
}
