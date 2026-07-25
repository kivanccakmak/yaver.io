package main

// devserver_framework_detect_test.go — detection must recognise a project by what
// it IS, not by an optional config file.
//
// The incident (2026-07-25, yaver-todo-web): an ordinary Next.js app —
// `"next": "^15"` in dependencies, `"dev": "next dev"` — shipped without a
// next.config file, which `create-next-app` does not create by default. Detection
// required one, so the project fell through to a generic "react" class that has NO
// dev server implementation. Both of its lanes then dead-ended:
//
//   browser lane : /dev/ → HTTP 404 (nothing was ever started)
//   webrtc lane  : "react projects use webview, not WebRTC remote runtime"
//
// Two honest-looking answers for a project Yaver can serve perfectly well. The
// pattern is the recurring one: a PROXY for the fact (a config file) instead of
// the fact (the manifest that declares the framework).

import (
	"os"
	"path/filepath"
	"testing"
)

func writeDetectFixture(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		full := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

func TestNextDetectedWithoutAConfigFile(t *testing.T) {
	next := &NextDevServer{}

	// The exact shape that failed: no next.config, next in deps, next dev script.
	dir := writeDetectFixture(t, map[string]string{
		"package.json": `{"name":"todo-web","scripts":{"dev":"next dev","build":"next build"},
			"dependencies":{"next":"^15.0.0","react":"^19.0.0"}}`,
	})
	if !next.Detect(dir) {
		t.Error("a Next.js app without next.config was not detected — it degrades to a generic " +
			"\"react\" class with no dev server, so both its lanes dead-end")
	}

	// devDependency placement counts too.
	if !next.Detect(writeDetectFixture(t, map[string]string{
		"package.json": `{"devDependencies":{"next":"14.2.0"}}`,
	})) {
		t.Error("next as a devDependency was not detected")
	}

	// Script-only (monorepo package that inherits the dep) counts.
	if !next.Detect(writeDetectFixture(t, map[string]string{
		"package.json": `{"scripts":{"start":"cross-env NODE_ENV=production next start"}}`,
	})) {
		t.Error("a `next start` script was not detected")
	}

	// The config file path still works.
	if !next.Detect(writeDetectFixture(t, map[string]string{
		"next.config.mjs": "export default {}",
		"package.json":    `{}`,
	})) {
		t.Error("next.config.mjs stopped being detected")
	}
}

func TestNextNotDetectedForNonNextProjects(t *testing.T) {
	next := &NextDevServer{}
	for label, files := range map[string]map[string]string{
		"vite react":  {"package.json": `{"dependencies":{"react":"^19","vite":"^5"},"scripts":{"dev":"vite"}}`},
		"expo":        {"package.json": `{"dependencies":{"expo":"~52","react-native":"0.76"}}`},
		"no manifest": {"README.md": "hi"},
		"broken json": {"package.json": `{not json`},
		// A dependency whose NAME merely contains "next" must not match.
		"next-lookalike": {"package.json": `{"dependencies":{"next-auth":"^5","react":"^19"}}`},
		// A script that mentions next as an argument, not as the command.
		"mentions next": {"package.json": `{"scripts":{"lint":"eslint --config next.eslintrc ."}}`},
	} {
		if next.Detect(writeDetectFixture(t, files)) {
			t.Errorf("%s was misdetected as Next.js — a wrong dev server is worse than none", label)
		}
	}
}
