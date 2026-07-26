package main

// devserver_start_remedy.go — turn a dev-server start failure into a sentence
// the user can act on, on the surface they are looking at.
//
// The rule this serves (CLAUDE.md): "Carry the *why* into the error text. The
// remedy string should name the specific fix, not 'check your configuration'."
//
// Real failures observed on 2026-07-25 while a phone showed a spinner, and what
// the user actually had to know:
//
//   Error detected in pubspec.yaml:
//   No file or variants found for asset: .env.
//   Failed to compile application.
//     → pubspec lists .env, the file isn't on THIS box (it's gitignored, so a
//       fresh clone never has it). Create it or drop the entry. Nothing about
//       Yaver, the relay, or the phone was wrong — but the phone was the only
//       place the user was looking, and it said nothing.
//
//   SocketException: Failed to create server socket (OS Error: Address already
//   in use, errno = 48), address = 0.0.0.0, port = 9100
//     → another dev server (often an orphan from a different project) owns the
//       port. lsof names it in one command.
//
// Framework-agnostic on purpose: the same shapes come out of Flutter, Metro,
// Vite and Next with different wording.

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	// Flutter: `No file or variants found for asset: .env.` — the trailing dot is
	// sentence punctuation, not part of the path.
	rxMissingPubspecAsset = regexp.MustCompile(`No file or variants found for asset:\s*([^\s,]+?)\.?\s*$`)
	// Node ecosystems: `Error: Cannot find module 'foo'`
	rxCannotFindModule = regexp.MustCompile(`Cannot find module '([^']+)'`)
)

// devStartRemedy returns one actionable sentence for a failed dev-server start,
// or "" when the tail doesn't match a shape we can name. The caller appends it to
// the error surfaced in /dev/status and the SSE "error" event, so mobile and web
// both show it.
func devStartRemedy(framework, workDir, tail string) string {
	if strings.TrimSpace(tail) == "" {
		return ""
	}
	lower := strings.ToLower(tail)

	if portBindFailure(tail) {
		return "Another process already owns the dev-server port on this machine — " +
			"often an orphaned dev server from a different project. Find it with " +
			"`lsof -nP -iTCP:<port>` and stop it, then start the preview again."
	}

	// Check every line: the asset name is on its own line inside a Flutter error
	// block, so matching the whole tail as one string misses it.
	for _, line := range strings.Split(tail, "\n") {
		if m := rxMissingPubspecAsset.FindStringSubmatch(strings.TrimSpace(line)); len(m) == 2 {
			asset := m[1]
			return fmt.Sprintf(
				"pubspec.yaml lists the asset %q but it does not exist in %s — gitignored files "+
					"(.env and friends) are missing on a fresh clone. Create it on this machine, "+
					"or remove the entry from the pubspec assets list. Careful with a blank "+
					"placeholder: an empty %s still loads, so code that falls back to another "+
					"file (.env.local) would silently get no config.",
				asset, workDir, asset)
		}
		if m := rxCannotFindModule.FindStringSubmatch(line); len(m) == 2 {
			return fmt.Sprintf(
				"%s cannot resolve the module %q in %s — dependencies were never installed on "+
					"this machine, or the lockfile moved. Run the project's install step "+
					"(npm/yarn/pnpm install) and start the preview again.",
				framework, m[1], workDir)
		}
	}

	switch {
	case strings.Contains(lower, "could not find a file named \"pubspec.yaml\""),
		strings.Contains(lower, "no pubspec.yaml file found"):
		return fmt.Sprintf("%s was started in %s, which is not a Flutter project root "+
			"(no pubspec.yaml). Pick the directory that holds pubspec.yaml.", framework, workDir)
	case strings.Contains(lower, "executable file not found"),
		strings.Contains(lower, "command not found"):
		return missingToolchainRemedy(framework)
	case strings.Contains(lower, "flutter pub get") && strings.Contains(lower, "failed"):
		return fmt.Sprintf("`flutter pub get` failed in %s — resolve the dependency error it "+
			"printed above before the preview can compile.", workDir)
	}
	return ""
}

// annotateDevStartError appends the remedy to a raw start error, once.
func annotateDevStartError(framework, workDir string, err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	remedy := devStartRemedy(framework, workDir, msg)
	if remedy == "" || strings.Contains(msg, remedy) {
		return msg
	}
	return msg + "\n\nWhat to do: " + remedy
}

// ─── compile failures on a HEALTHY dev server ────────────────────────────────

// devBuildFailureLine reports whether a dev-server output line means "the app
// itself cannot build".
//
// This is a different failure from "the dev server did not start": the server is
// up, listening, and answering index.html — it simply has no app to serve. Every
// surface therefore looked healthy while the user stared at a black screen. Seen
// 2026-07-25 on a real Flutter project whose lock file pinned
// font_awesome_flutter 10.12.0 against Flutter 3.44 (`IconData` became a final
// class): readiness passed, the proxy returned 200, and nothing ever rendered.
func devBuildFailureLine(line string) bool {
	l := strings.ToLower(strings.TrimSpace(line))
	if l == "" {
		return false
	}
	for _, needle := range []string{
		"failed to compile application",       // Flutter/Dart
		"compilation failed",                  // dart2js / ddc, tsc --build
		"failed to compile",                   // Vite/esbuild summary
		"error: failed to compile",            // Next.js
		"module build failed",                 // webpack/Metro
		"bundling failed",                     // Metro
		"unable to resolve module",            // Metro missing import
		"the following build commands failed", // xcodebuild
	} {
		if strings.Contains(l, needle) {
			return true
		}
	}
	return false
}

// compileErrorLines picks the lines a human needs out of a log tail: the failure
// summary plus the first concrete error above it.
//
// Handing over the whole tail buries the cause in stack noise; handing over only
// the summary ("Failed to compile application.") names no reason at all. Both were
// tried; this is the middle.
func compileErrorLines(tail []string) []string {
	out := []string{}
	for _, line := range tail {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || trimmed == "^" {
			continue
		}
		lower := strings.ToLower(trimmed)
		if strings.Contains(lower, "error:") || strings.Contains(lower, "error ") ||
			devBuildFailureLine(trimmed) || strings.Contains(lower, "cannot find") {
			out = append(out, trimmed)
		}
	}
	if len(out) == 0 {
		// Nothing matched our shapes — the raw tail beats saying nothing.
		for _, line := range tail {
			if t := strings.TrimSpace(line); t != "" {
				out = append(out, t)
			}
		}
	}
	// Keep it to a readable panel: the summary line plus a handful of causes.
	const maxLines = 6
	if len(out) > maxLines {
		out = out[len(out)-maxLines:]
	}
	return out
}

// ─── missing toolchain ───────────────────────────────────────────────────────

// frameworkInstallTarget maps a dev-server framework to the `yaver install`
// plan that provides its toolchain, or "" when Yaver has no installer for it.
//
// Deliberately a lookup against the REAL plan table (metaInstallPlan), not a
// hand-written list: a plan that is added or removed there must not leave this
// advice claiming an installer that no longer exists. Naming a command that
// fails is worse than naming none.
func frameworkInstallTarget(framework string) string {
	switch strings.ToLower(strings.TrimSpace(framework)) {
	case "flutter":
		return "flutter"
	case "expo", "react-native", "rn", "metro", "next", "nextjs", "vite", "node":
		return "node"
	}
	return ""
}

// missingToolchainRemedy turns "executable file not found" into the specific
// action available on THIS machine.
//
// CLAUDE.md, "a missing toolchain is a product requirement, not a user error":
// state it → offer the fix if the fix exists → stream the fix → name the
// constraint if it does not. The string this returns is what the phone and the
// web preview panel render, so it is the whole difference between a user who
// installs Flutter in one command and a user who sees a spinner.
//
// The previous version said "Install it on this machine, then start the preview
// again" — vague in exactly the way the hard rule forbids, and wrong about the
// product's own abilities: `yaver install flutter` has existed and been
// arch-aware the whole time (flutter_install.go), including the git-clone path
// for Linux ARM64 where Flutter publishes no tarball. The user was told to go
// solve it themselves while the agent was holding a working installer.
func missingToolchainRemedy(framework string) string {
	label := strings.TrimSpace(framework)
	if label == "" {
		label = "project"
	}
	target := frameworkInstallTarget(framework)
	if target == "" {
		return fmt.Sprintf("the %s toolchain is not installed (or not on PATH) for the user the "+
			"agent runs as, and Yaver has no installer for it. Install it on this machine, "+
			"then start the preview again.", label)
	}
	// Validate against BOTH tables `yaver install <name>` consults, in the same
	// order it does — an installer this string names must actually resolve.
	_, okMeta := metaInstallPlan(target)
	_, okIntegration := lookupIntegration(target)
	if !okMeta && !okIntegration {
		// The plan table changed under us. Say the honest thing rather than
		// printing a command that would fail.
		return fmt.Sprintf("the %s toolchain is not installed (or not on PATH) for the user the "+
			"agent runs as. Install it on this machine, then start the preview again.", label)
	}
	return fmt.Sprintf("the %s toolchain is not installed (or not on PATH) for the user the "+
		"agent runs as — Yaver can install it here: run `yaver install %s` on this machine "+
		"(or use Install on the preview panel, which streams the download). Then start the "+
		"preview again.", label, target)
}
