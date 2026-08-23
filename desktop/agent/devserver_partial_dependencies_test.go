package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// A node_modules directory is not proof that the dependencies the bundler
// needs exist. This is the exact sfmg failure: Expo survived in a partial tree,
// while react-native, react-native-web and typescript did not, so the old probe
// skipped installation and launched a process guaranteed to exit.
func TestDetectProjectPreparationRejectsPartialNodeModules(t *testing.T) {
	workDir := t.TempDir()
	mustWrite(t, filepath.Join(workDir, "package.json"), `{
  "dependencies": {"expo":"54.0.33", "react-native":"0.81.5", "react-native-web":"0.21.0"},
  "devDependencies": {"typescript":"~5.9.2"}
}`)
	mustWrite(t, filepath.Join(workDir, "node_modules", "expo", "package.json"), `{"name":"expo"}`)

	manifest, err := readProjectPackageManifest(workDir)
	if err != nil {
		t.Fatal(err)
	}
	prep := detectProjectPreparation(workDir, manifest)
	want := []string{"react-native", "react-native-web", "typescript"}
	if !reflect.DeepEqual(prep.MissingDependencies, want) {
		t.Fatalf("MissingDependencies = %v, want %v", prep.MissingDependencies, want)
	}
	if prep.DependenciesInstalled || !prep.NeedsDependencyInstall {
		t.Fatalf("partial node_modules reported installed: %+v", prep)
	}
}

func TestDetectProjectPreparationAcceptsHoistedDirectDependencies(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "package.json"), `{"workspaces":["mobile"]}`)
	leaf := filepath.Join(root, "mobile")
	mustWrite(t, filepath.Join(leaf, "package.json"), `{"dependencies":{"@scope/shared":"*"}}`)
	if err := os.MkdirAll(filepath.Join(leaf, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(root, "node_modules", "@scope", "shared", "package.json"), `{"name":"@scope/shared"}`)

	manifest, err := readProjectPackageManifest(leaf)
	if err != nil {
		t.Fatal(err)
	}
	prep := detectProjectPreparation(leaf, manifest)
	if prep.NeedsDependencyInstall || len(prep.MissingDependencies) != 0 {
		t.Fatalf("hoisted dependency reported missing: %+v", prep)
	}
}

func TestDirectNodeDependencyInstalledRejectsPathEscape(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "outside", "package.json"), `{}`)
	if directNodeDependencyInstalled([]string{root}, "../outside") {
		t.Fatal("package-name path escape must not probe outside node_modules")
	}
}
