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
		return fmt.Sprintf("the %s toolchain is not installed (or not on PATH) for the user the "+
			"agent runs as. Install it on this machine, then start the preview again.", framework)
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
