package main

import (
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNodeArchiveForWindowsUsesOfficialZipNames(t *testing.T) {
	tests := []struct {
		arch string
		want string
	}{
		{arch: "amd64", want: "node-v22.12.0-win-x64.zip"},
		{arch: "arm64", want: "node-v22.12.0-win-arm64.zip"},
	}
	for _, tc := range tests {
		name, urlPath, ok := nodeArchiveForPlatform("v22.12.0", "windows", tc.arch)
		if !ok {
			t.Fatalf("windows/%s was refused", tc.arch)
		}
		if name != tc.want || urlPath != "v22.12.0/"+tc.want {
			t.Errorf("windows/%s = (%q, %q), want (%q, %q)", tc.arch, name, urlPath, tc.want, "v22.12.0/"+tc.want)
		}
	}
}

func TestExtractNodeWindowsZipCreatesManagedBinLayout(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "node.zip")
	writeTestZip(t, archive, map[string]string{
		"node-v22.12.0-win-x64/node.exe":              "node",
		"node-v22.12.0-win-x64/npm.cmd":               "npm",
		"node-v22.12.0-win-x64/npx.cmd":               "npx",
		"node-v22.12.0-win-x64/node_modules/npm/a.js": "module",
	})
	stage := filepath.Join(t.TempDir(), "node.new")
	if err := extractNodeArchive(context.Background(), archive, "node-v22.12.0-win-x64.zip", stage); err != nil {
		t.Fatal(err)
	}
	for rel, want := range map[string]string{
		"bin/node.exe":              "node",
		"bin/npm.cmd":               "npm",
		"bin/npx.cmd":               "npx",
		"bin/node_modules/npm/a.js": "module",
	} {
		data, err := os.ReadFile(filepath.Join(stage, filepath.FromSlash(rel)))
		if err != nil {
			t.Errorf("%s missing: %v", rel, err)
			continue
		}
		if string(data) != want {
			t.Errorf("%s = %q, want %q", rel, data, want)
		}
	}
}

func TestExtractNodeWindowsZipRejectsPathTraversal(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "node.zip")
	writeTestZip(t, archive, map[string]string{
		"node-v22.12.0-win-x64/../../outside.txt": "nope",
	})
	err := extractNodeArchive(context.Background(), archive, "node-v22.12.0-win-x64.zip", filepath.Join(t.TempDir(), "stage"))
	if err == nil || !strings.Contains(err.Error(), "unsafe zip entry") {
		t.Fatalf("path traversal error = %v, want a named refusal", err)
	}
}

func TestRuntimeBinaryNamesIncludesWindowsNodeShims(t *testing.T) {
	got := runtimeBinaryNames("npx", "windows")
	want := []string{"npx.exe", "npx.cmd", "npx.bat", "npx"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("runtimeBinaryNames = %v, want %v", got, want)
	}
	if got := runtimeBinaryNames("node", "darwin"); len(got) != 1 || got[0] != "node" {
		t.Fatalf("darwin runtime names changed: %v", got)
	}
}

func writeTestZip(t *testing.T, filename string, entries map[string]string) {
	t.Helper()
	f, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, body := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}
