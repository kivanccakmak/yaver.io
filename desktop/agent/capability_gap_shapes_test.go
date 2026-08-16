package main

import (
	"strings"
	"testing"
)

// capability_gap_shapes_test.go — the DETECTOR's vocabulary.
//
// capability_gap.go started life knowing exactly three sentences, all of them
// produced by os/exec or a shell. That is not the set of sentences this
// codebase actually emits when a binary is missing. Two more shapes were
// measured 2026-07-27, both of them on paths where the user is holding a
// spinner:
//
//   - `claude not found in PATH or common locations` — CheckRunnerBinary
//     (tasks.go). This is the FIRST thing POST /tasks checks and the most
//     common way a Tasks-lane run dies on a fresh box. `claude`, `codex` and
//     `opencode` all have real install recipes (install_cmd.go integrations
//     table), so the route existed and the sentence could not reach it.
//   - `carton not found on PATH — SwiftWasm previews need …` — the SwiftWasm
//     dev server's own LookPath guard (devserver_swiftwasm.go). Hand-written
//     prose, no os/exec involved, so none of the three original regexes match.
//
// A detector that only understands the error strings ONE package produces is
// an inventory of that package, not of the failure. Every row below is a real
// producer in this tree, quoted verbatim.
func TestMissingToolFromErrorCoversEveryShapeThisTreeEmits(t *testing.T) {
	cases := []struct {
		name string
		err  string
		want string
	}{
		// os/exec, quoted — the original.
		{"exec quoted", `exec: "flutter": executable file not found in $PATH`, "flutter"},
		// our own wrapping — the original.
		{"exec bare", `exec flutter: executable file not found in $PATH`, "flutter"},
		// a shell ran the spawn — the original.
		{"shell", `flutter: command not found`, "flutter"},

		// CheckRunnerBinary, tasks.go — the Tasks lane's first gate.
		{"runner binary", `runner not ready: claude not found in PATH or common locations`, "claude"},
		{"runner binary codex", `codex not found in PATH or common locations`, "codex"},

		// devserver_swiftwasm.go Start — hand-written LookPath guard.
		{"not found on PATH", `carton not found on PATH — SwiftWasm previews need the SwiftWasm toolchain`, "carton"},
		{"not found on PATH swift", `swift not found on PATH — the SwiftWasm toolchain is missing from this workspace image`, "swift"},

		// runner_pty.go / DiscoverBinary shapes.
		{"not found in PATH", `tmux not found in PATH`, "tmux"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := missingToolFromError(tc.err); got != tc.want {
				t.Errorf("missingToolFromError(%q) = %q, want %q — an unrecognised shape is a spinner over a named fact", tc.err, got, tc.want)
			}
		})
	}
}

// The inverse obligation, and the more dangerous one: naming a tool that is
// not missing sends the user to install something they already have, and the
// install "succeeds" while the real failure repeats. Every string below is a
// real failure with a DIFFERENT remedy.
func TestMissingToolFromErrorRefusesToGuess(t *testing.T) {
	for _, err := range []string{
		"",
		`listen tcp :8081: bind: address already in use`,
		`Error: Unable to resolve module ./App from /src/index.js`,
		`pubspec.yaml: no file or variants found for asset: .env`,
		`npm ERR! code EINTEGRITY`,
		`exit status 1`,
		// "not found" about a FILE, not a binary — the most likely false
		// positive for the two new regexes.
		`open /root/app/package.json: no such file or directory`,
		`Module not found: Can't resolve 'react-dom'`,
	} {
		if got := missingToolFromError(err); got != "" {
			t.Errorf("missingToolFromError(%q) = %q — a wrong tool name is worse than none", err, got)
		}
	}
}

// The SwiftWasm lane end to end. carton has no install recipe anywhere in the
// product, so the honest answer is a NAMED gap with a CONSTRAINT — never a
// button that 404s, and never a spinner.
func TestSwiftWasmMissingCartonIsANamedGapWithAConstraint(t *testing.T) {
	gap := DetectCapabilityGap(CapabilityGapContext{
		Framework: "swiftwasm",
		WorkDir:   "/home/dev/tokamak-app",
		Err:       `carton not found on PATH — SwiftWasm previews need the SwiftWasm toolchain and carton baked into the workspace image`,
	})
	if gap == nil {
		t.Fatal("a SwiftWasm start on a box without carton must name itself; nil is the spinner")
	}
	if gap.Capability != "carton" {
		t.Errorf("Capability = %q, want carton", gap.Capability)
	}
	if gap.Fix != nil {
		t.Fatalf("carton has no recipe in integrations or metaInstallPlan — advertising %s %s is the 'yaver lies' defect", gap.Fix.Method, gap.Fix.Path)
	}
	if gap.Constraint == "" {
		t.Fatal("no Fix means Constraint is mandatory — a gap with neither is a dead end with a sentence")
	}
	if !strings.Contains(gap.Constraint, "carton") {
		t.Errorf("Constraint must name the specific tool, got %q", gap.Constraint)
	}
}

// devStartToolchainBinary is the table that lets /dev/start refuse SYNCHRONOUSLY,
// which is the only lane where the 200-OK-then-async-fail problem cannot bite.
// A framework whose spawn binary is known and absent from this table gets a
// 200 OK on a doomed start.
func TestDevStartToolchainBinaryCoversEveryNonNodeFramework(t *testing.T) {
	// framework -> the binary its Start() actually execs, verified against
	// devserver.go / devserver_swiftwasm.go. Node-family frameworks spawn
	// `npx` and are covered by the package.json preflight instead.
	for framework, want := range map[string]string{
		"flutter":   "flutter", // devserver.go FlutterDevServer.Start → resolveSpawnPath("flutter")
		"swiftwasm": "carton",  // devserver_swiftwasm.go Start → startProcess(ctx, "carton", …)
	} {
		if got := devStartToolchainBinary(framework); got != want {
			t.Errorf("devStartToolchainBinary(%q) = %q, want %q — without a row here the start answers 200 OK and fails later", framework, got, want)
		}
	}
	// Node-family frameworks must NOT be in the table: their real spawn is
	// `npx`, and refusing on a framework-named binary would refuse a start
	// that would have worked.
	for _, framework := range []string{"expo", "react-native", "vite", "nextjs", ""} {
		if got := devStartToolchainBinary(framework); got != "" {
			t.Errorf("devStartToolchainBinary(%q) = %q — this framework spawns npx; guessing a binary refuses a start that would have worked", framework, got)
		}
	}
}
