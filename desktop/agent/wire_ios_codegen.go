package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// missingReferencedReactNativeCodegen verifies the inputs Xcode will actually
// compile. CocoaPods' project and lockfiles survive `ios/build` cleanup, while
// React Native's generated Objective-C++ sources do not. In that state the
// dependency inventory looks healthy and xcodebuild fails much later with 65.
//
// The Pods project records codegen sources by basename beneath
// ../build/generated/ios. Compare those references with the generated tree so
// this stays module-agnostic (RNWhisper was merely the incident that exposed
// the false green).
func missingReferencedReactNativeCodegen(iosDir, podsProjectPath string) string {
	project, err := os.ReadFile(podsProjectPath)
	if err != nil || !strings.Contains(string(project), "../build/generated/ios") {
		return ""
	}

	referenced := map[string]bool{}
	for _, line := range strings.Split(string(project), "\n") {
		if !strings.Contains(line, "PBXFileReference") {
			continue
		}
		marker := "path = "
		start := strings.Index(line, marker)
		if start < 0 {
			continue
		}
		value := line[start+len(marker):]
		if end := strings.IndexByte(value, ';'); end >= 0 {
			value = value[:end]
		}
		name := filepath.Base(strings.Trim(strings.TrimSpace(value), `"`))
		lower := strings.ToLower(name)
		if !strings.Contains(lower, "generated") {
			continue
		}
		switch strings.ToLower(filepath.Ext(name)) {
		case ".c", ".cc", ".cpp", ".h", ".m", ".mm":
			referenced[name] = true
		}
	}
	if len(referenced) == 0 {
		return ""
	}

	generatedRoot := filepath.Join(iosDir, "build", "generated", "ios")
	found := map[string]bool{}
	started := time.Now()
	timedOut := false
	_ = filepath.Walk(generatedRoot, func(path string, info os.FileInfo, walkErr error) error {
		if time.Since(started) > 2*time.Second {
			timedOut = true
			return filepath.SkipAll
		}
		if walkErr == nil && info != nil && !info.IsDir() {
			found[info.Name()] = true
		}
		return nil
	})
	if timedOut {
		// Codegen classification must never hold the build in an unbounded tree.
		// Degrade to the existing CocoaPods checks when the scan cannot finish.
		return ""
	}
	missing := make([]string, 0)
	for name := range referenced {
		if !found[name] {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	if len(missing) == 0 {
		return ""
	}
	return missing[0]
}
