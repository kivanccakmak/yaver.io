package testkit

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func managedAndroidSDKRoot() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".yaver", "runtimes", "android-sdk")
}

func testkitAndroidSDKRoots() []string {
	home, _ := os.UserHomeDir()
	var roots []string
	seen := map[string]bool{}
	add := func(root string) {
		root = strings.TrimSpace(root)
		if root == "" || seen[root] {
			return
		}
		seen[root] = true
		roots = append(roots, root)
	}
	add(os.Getenv("ANDROID_SDK_ROOT"))
	add(os.Getenv("ANDROID_HOME"))
	if home != "" {
		add(filepath.Join(home, "Library", "Android", "sdk"))
		add(filepath.Join(home, "Android", "Sdk"))
		add(filepath.Join(home, ".yaver", "runtimes", "android-sdk"))
	}
	return roots
}

func testkitAndroidToolRelativePath(name string) string {
	switch strings.TrimSpace(name) {
	case "adb":
		return filepath.Join("platform-tools", "adb")
	case "emulator":
		return filepath.Join("emulator", "emulator")
	case "sdkmanager", "avdmanager":
		return filepath.Join("cmdline-tools", "latest", "bin", name)
	default:
		return ""
	}
}

func resolveTestkitCommandPath(name string) string {
	if path, err := exec.LookPath(name); err == nil && strings.TrimSpace(path) != "" {
		return path
	}
	rel := testkitAndroidToolRelativePath(name)
	if rel == "" {
		return name
	}
	for _, root := range testkitAndroidSDKRoots() {
		candidate := filepath.Join(root, rel)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return name
}
