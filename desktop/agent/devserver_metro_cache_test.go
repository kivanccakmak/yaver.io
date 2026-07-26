package main

import (
	"bytes"
	"strings"
	"testing"
)

// These tests pin the persistent-Metro-cache seams that fix the measured
// ~87 s cold `expo export -p web` on every "web ui" open (2026-07-26):
// a stable per-project TMPDIR (metro-config roots its FileStore at
// os.tmpdir()/metro-cache) and NO --clear on the export command line.

func TestMetroCacheDirUnder_StableAndPerProject(t *testing.T) {
	base := t.TempDir()
	a1 := metroCacheDirUnder(base, "/home/user/checkout-a/mobile")
	a2 := metroCacheDirUnder(base, "/home/user/checkout-a/mobile")
	b := metroCacheDirUnder(base, "/home/user/checkout-b/mobile")
	if a1 == "" || a1 != a2 {
		t.Fatalf("cache dir must be stable per workdir: %q vs %q", a1, a2)
	}
	// Two checkouts with the SAME basename must not share a transform
	// cache — the hash of the absolute path keeps them apart.
	if a1 == b {
		t.Fatalf("distinct checkouts named 'mobile' must not share a cache dir: %q", a1)
	}
	if !strings.HasPrefix(a1, base) {
		t.Fatalf("cache dir %q escaped base %q", a1, base)
	}
	if !strings.Contains(a1, "mobile-") {
		t.Fatalf("cache dir should embed the project basename for debuggability: %q", a1)
	}
	if metroCacheDirUnder(base, "") != "" || metroCacheDirUnder("", "/x") != "" {
		t.Fatalf("empty base/workdir must yield no cache dir")
	}
}

func TestWithEnvOverride_ReplacesInsteadOfDuplicating(t *testing.T) {
	env := []string{"PATH=/usr/bin", "TMPDIR=/tmp/random-per-run", "HOME=/home/u"}
	out := withEnvOverride(env, "TMPDIR=/persistent/cache")
	count := 0
	for _, kv := range out {
		if strings.HasPrefix(kv, "TMPDIR=") {
			count++
			if kv != "TMPDIR=/persistent/cache" {
				t.Fatalf("TMPDIR not replaced: %q", kv)
			}
		}
	}
	// Duplicate env keys are resolved differently by libc getenv (first
	// wins) vs Node process.env (last wins) — exactly one entry is the
	// only unambiguous shape.
	if count != 1 {
		t.Fatalf("expected exactly one TMPDIR entry, got %d (%v)", count, out)
	}
	// Missing key appends.
	out2 := withEnvOverride([]string{"PATH=/usr/bin"}, "TMPDIR=/persistent/cache")
	if len(out2) != 2 || out2[1] != "TMPDIR=/persistent/cache" {
		t.Fatalf("missing key should append: %v", out2)
	}
}

// TestWebBundleCommandDoesNotClearCache is the guard for the --clear
// removal. Proven by breaking: re-adding --clear to webBundleCommand
// makes this fail. --clear wiped Metro's transform cache on EVERY
// export — with it present, no persistent TMPDIR can ever produce a
// warm build, and every open pays the full cold bundle.
func TestWebBundleCommandDoesNotClearCache(t *testing.T) {
	for _, pm := range []string{"npm", "yarn", "pnpm", "bun"} {
		cmd := webBundleCommand(pm, "/tmp/out")
		joined := strings.Join(cmd.Args, " ")
		if strings.Contains(joined, "--clear") {
			t.Fatalf("%s: webBundleCommand must not pass --clear (cold-cache regression): %v", pm, cmd.Args)
		}
		if !strings.Contains(joined, "export") {
			t.Fatalf("%s: expected an expo export invocation, got %v", pm, cmd.Args)
		}
	}
}

func TestNormalizeDevReloadMode(t *testing.T) {
	cases := map[string]string{
		"":       "fast",
		"fast":   "fast",
		"dev":    "fast", // legacy alias
		"FULL":   "full",
		"full":   "full",
		"weird":  "fast", // unknown never escalates
		" full ": "full",
		"bundle": "fast", // /dev/reload has no bundle lane; reload-app owns it
	}
	for in, want := range cases {
		if got := normalizeDevReloadMode(in); got != want {
			t.Errorf("normalizeDevReloadMode(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestFlutterReloadWithMode pins the fast/full → stdin mapping: fast
// writes "r" (hot reload, state preserved), full writes "R" (hot
// restart). This is the whole Flutter half of the Fast/Full Reload
// buttons — get the byte wrong and both buttons do the same thing.
func TestFlutterReloadWithMode(t *testing.T) {
	buf := &bytes.Buffer{}
	f := &FlutterDevServer{stdinPipe: &stdinWriter{w: buf}}
	if err := f.ReloadWithMode("fast"); err != nil {
		t.Fatalf("fast reload: %v", err)
	}
	if got := buf.String(); got != "r\n" {
		t.Fatalf("fast reload wrote %q, want \"r\\n\"", got)
	}
	buf.Reset()
	if err := f.ReloadWithMode("full"); err != nil {
		t.Fatalf("full reload: %v", err)
	}
	if got := buf.String(); got != "R\n" {
		t.Fatalf("full reload wrote %q, want \"R\\n\"", got)
	}
	buf.Reset()
	// Plain Reload() stays the fast path (back-compat for every caller
	// that predates modes).
	if err := f.Reload(); err != nil {
		t.Fatalf("legacy reload: %v", err)
	}
	if got := buf.String(); got != "r\n" {
		t.Fatalf("legacy Reload wrote %q, want \"r\\n\"", got)
	}
	// No stdin pipe → named error, not a silent success.
	none := &FlutterDevServer{}
	if err := none.ReloadWithMode("fast"); err == nil {
		t.Fatalf("expected error when stdin pipe is unavailable")
	}
}
