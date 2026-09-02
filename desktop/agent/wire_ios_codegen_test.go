package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeWireCodegenFixture(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestMissingReferencedReactNativeCodegen(t *testing.T) {
	iosDir := t.TempDir()
	project := filepath.Join(iosDir, "Pods", "Pods.xcodeproj", "project.pbxproj")
	writeWireCodegenFixture(t, project, `
		A1 /* PresentSpecJSI-generated.cpp */ = {isa = PBXFileReference; path = "PresentSpecJSI-generated.cpp"; sourceTree = "<group>"; };
		A2 /* MissingSpec-generated.mm */ = {isa = PBXFileReference; path = "MissingSpec-generated.mm"; sourceTree = "<group>"; };
		B1 /* codegen */ = {isa = PBXGroup; path = ../build/generated/ios; sourceTree = "<group>"; };
	`)
	writeWireCodegenFixture(t, filepath.Join(iosDir, "build", "generated", "ios", "nested", "PresentSpecJSI-generated.cpp"), "// present\n")

	if got := missingReferencedReactNativeCodegen(iosDir, project); got != "MissingSpec-generated.mm" {
		t.Fatalf("missing source: got %q", got)
	}
	writeWireCodegenFixture(t, filepath.Join(iosDir, "build", "generated", "ios", "MissingSpec", "MissingSpec-generated.mm"), "// present\n")
	if got := missingReferencedReactNativeCodegen(iosDir, project); got != "" {
		t.Fatalf("complete codegen should be ready, got %q", got)
	}
}
