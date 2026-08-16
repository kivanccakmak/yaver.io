package main

// devserver_metro_cache.go — persistent Metro/Expo transform-cache location
// for every Metro-family subprocess the agent spawns (expo export, expo/metro
// dev servers, react-native bundle).
//
// Root cause, measured live 2026-07-26 (yaver/mobile Expo project, Linux box):
// every "web ui" open ran a FULL `expo export -p web` (~87 s, 2190 modules)
// and Metro printed "Bundler cache is empty, rebuilding" EVERY run. Two
// independent leaks made the cache unfalsifiable:
//
//  1. Metro's default cache store root is path.join(os.tmpdir(), "metro-cache")
//     (metro-config/src/defaults/index.js — verified against metro 0.83.5,
//     which has NO METRO_CACHE_ROOT env override). Node's os.tmpdir() reads
//     TMPDIR, so a spawn that inherits a per-run TMPDIR — or a box whose /tmp
//     is periodically cleaned (the opencode /tmp .so leak cleanup) — starts
//     cold every time.
//
//  2. webBundleCommand passed `--clear` to expo export, wiping whatever cache
//     DID survive. See build_web.go (flag removed; guarded by
//     TestWebBundleCommandDoesNotClearCache).
//
// Fix: pin TMPDIR for Metro-family subprocesses to a per-project directory
// under ~/.yaver/cache/metro/<project>/, created 0700. A warm second export
// drops from ~87 s to well under 30 s (transform cache + copied assets both
// persist). The directory is a cache: safe to delete at any time, Metro
// rebuilds it.

import (
	"crypto/sha1"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// metroCacheRoot is the base directory for all per-project Metro caches.
func metroCacheRoot() string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return ""
	}
	return filepath.Join(home, ".yaver", "cache", "metro")
}

var metroCacheNameSanitizer = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// metroCacheDirUnder derives the per-project cache dir beneath base. Pure —
// no filesystem access — so tests can pin the mapping. The name embeds both
// the project basename (debuggability: `ls ~/.yaver/cache/metro` should read
// like a project list) and a hash of the absolute path (two checkouts named
// "mobile" must not share a transform cache).
func metroCacheDirUnder(base, workDir string) string {
	if strings.TrimSpace(base) == "" || strings.TrimSpace(workDir) == "" {
		return ""
	}
	abs, err := filepath.Abs(workDir)
	if err != nil {
		abs = workDir
	}
	sum := sha1.Sum([]byte(abs))
	name := metroCacheNameSanitizer.ReplaceAllString(filepath.Base(abs), "_")
	if name == "" || name == "." {
		name = "project"
	}
	return filepath.Join(base, name+"-"+hex.EncodeToString(sum[:])[:10])
}

// metroCacheDir returns the persistent per-project cache dir, creating it
// 0700 (cache may hold source-derived artifacts; owner-only like the rest
// of ~/.yaver). Empty string means "no persistent cache available" — the
// caller must degrade to the ambient TMPDIR, never fail the build over a
// cache.
func metroCacheDir(workDir string) string {
	dir := metroCacheDirUnder(metroCacheRoot(), workDir)
	if dir == "" {
		return ""
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	return dir
}

// applyMetroCacheEnv returns env with TMPDIR pointed at the persistent
// per-project cache dir. Replaces any existing TMPDIR entry instead of
// appending a duplicate — duplicate keys in an exec env are resolved
// differently by libc getenv (first wins) vs. Node's process.env (last
// wins), which is exactly the kind of ambiguity that made the original
// cache location unfalsifiable. No-op (returns env unchanged) when the
// cache dir cannot be created.
func applyMetroCacheEnv(env []string, workDir string) []string {
	dir := metroCacheDir(workDir)
	if dir == "" {
		return env
	}
	return withEnvOverride(env, "TMPDIR="+dir)
}

// withEnvOverride returns env with each KEY=VALUE override applied: an
// existing KEY entry is replaced in place; a missing KEY is appended.
func withEnvOverride(env []string, overrides ...string) []string {
	out := make([]string, 0, len(env)+len(overrides))
	replaced := make(map[string]bool, len(overrides))
	keyOf := func(kv string) string {
		if i := strings.IndexByte(kv, '='); i > 0 {
			return kv[:i]
		}
		return kv
	}
	for _, kv := range env {
		k := keyOf(kv)
		swapped := false
		for _, ov := range overrides {
			if keyOf(ov) == k {
				if !replaced[k] {
					out = append(out, ov)
					replaced[k] = true
				}
				swapped = true
				break
			}
		}
		if !swapped {
			out = append(out, kv)
		}
	}
	for _, ov := range overrides {
		if !replaced[keyOf(ov)] {
			out = append(out, ov)
		}
	}
	return out
}
