package main

// runner_auth_headless_remedy_test.go — every Codex sign-in remedy must work on a
// machine with no browser.
//
// WHY A SOURCE-SCANNING TEST. The boxes that actually hit a Codex sign-in prompt are
// the remote ones: a Hetzner VPS, a Pi, an SSH-only server, a managed cloud instance.
// Bare `codex login` opens a browser and waits on a localhost callback, so on those
// machines it is not "harder" — it is IMPOSSIBLE. Telling a user on a phone to run a
// command that cannot complete on the machine it names is a route-to-fix that routes
// into a wall, and it is worse than saying nothing because it looks like help.
//
// The 2026-08-02 audit found three such strings. Fixing the three was easy; keeping
// them fixed is the hard part, because each lives in a different file written by a
// different change, and none of them is covered by a behavioural test — they are
// PRINTED, so nothing but a human reading the output would notice a regression.
// Hence a test that reads the sources, in the spirit of beaconParity.test.ts.
//
// Prove it by breaking it: change any remedy back to bare `codex login` and this
// fails, naming the file and line.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// bareCodexLogin matches `codex login` NOT followed by a subcommand or flag that
// makes it headless-safe. `codex login status` is a read-only probe, not a remedy,
// so it is allowed; `codex login --device-auth` is the correct remedy.
var bareCodexLogin = regexp.MustCompile(`codex login(?:\x60|"|\s*\\n|\s*$|\s*[^-\w])`)

func TestNoHeadlessHostileCodexRemedyInSource(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}

	type finding struct {
		file string
		line int
		text string
	}
	var findings []finding

	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		blob, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			continue
		}
		for i, line := range strings.Split(string(blob), "\n") {
			trimmed := strings.TrimSpace(line)

			// Comments explain the rule and quote the bad form on purpose.
			if strings.HasPrefix(trimmed, "//") {
				continue
			}
			// The CLASSIFIER matches what Codex itself prints. Those are inputs we
			// must recognise, not remedies we emit — leave them alone.
			if strings.Contains(line, "strings.Contains(m,") {
				continue
			}
			// `codex login status` is a probe, not a sign-in instruction.
			if strings.Contains(line, "codex login status") {
				continue
			}
			if headlessRemedyAllowed(name, trimmed) {
				continue
			}
			if !strings.Contains(line, "codex login") {
				continue
			}
			if strings.Contains(line, "--device-auth") {
				continue
			}
			if bareCodexLogin.MatchString(line) {
				findings = append(findings, finding{file: name, line: i + 1, text: trimmed})
			}
		}
	}

	for _, f := range findings {
		t.Errorf("%s:%d emits a bare `codex login`, which cannot complete on a headless/remote box — use `codex login --device-auth`:\n    %s", f.file, f.line, f.text)
	}
}

// headlessRemedyAllowed is the EXPLICIT, justified exception list. It is deliberately
// small and deliberately annoying to extend: adding an entry means writing down why a
// user on a browserless machine is being shown a browser flow.
func headlessRemedyAllowed(file, line string) bool {
	switch {
	// Fixtures for the classifier: these are strings Codex PRINTS, which Yaver
	// must recognise as an auth failure. Inputs, not remedies.
	case file == "runner_test_http.go":
		return true

	// The device-auth watchdog. It fires when `codex login --device-auth` produced
	// no URL or code in 45 s, whose likeliest cause is that device-auth is
	// DISABLED for the workspace by an admin (openai/codex#9253). At that point
	// the device-code flow is not available, so naming the interactive flow is the
	// honest remaining option — and the same sentence also offers the genuinely
	// headless alternative (importing credentials from a signed-in machine).
	case file == "runner_auth_browser_http.go" && strings.Contains(line, "device-auth is disabled for this workspace"):
		return true
	}
	return false
}

// EVERY way a blocked runner becomes usable again must resume the parked work.
//
// There are three, and they are in three different files: the keep-alive renewal, a
// completed browser/device-auth sign-in, and a credential import. I shipped the first
// one only, and caught the other two while verifying the HEADLESS route — which is
// precisely where it mattered most, because `codex login --device-auth` establishes a
// NEW credential rather than renewing one, so the refresh path never fires there.
//
// The user-visible failure of that omission: they are told "your message will send
// once you're signed in", they go and sign in on the box, and nothing happens. A
// recovery that does not resume the work is not a recovery.
func TestEveryAuthRecoveryPathReplaysParkedTurns(t *testing.T) {
	sites := map[string]string{
		"runner_auth_refresh.go":      "the keep-alive renewal",
		"runner_auth_browser_http.go": "a completed sign-in AND a credential import",
	}
	for file, what := range sites {
		blob, err := os.ReadFile(filepath.Clean(file))
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		if !strings.Contains(string(blob), "replayParkedTurnsAfterAuthRecovery(") {
			t.Errorf("%s (%s) never calls replayParkedTurnsAfterAuthRecovery — a user who recovers via this path is left with a prompt that silently never sends", file, what)
		}
	}

	// The browser file carries TWO distinct recovery paths; one call would leave
	// the other silently broken, which is exactly how this bug got in.
	blob, err := os.ReadFile(filepath.Clean("runner_auth_browser_http.go"))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if n := strings.Count(string(blob), "replayParkedTurnsAfterAuthRecovery("); n < 2 {
		t.Errorf("runner_auth_browser_http.go has %d replay call(s), want 2 (sign-in completion + credential import)", n)
	}
}

// The programmatic remedy must agree with the source scan above.
func TestCodexReauthCommandIsHeadlessCapable(t *testing.T) {
	got := runnerReauthCommand("codex")
	if !strings.Contains(got, "--device-auth") {
		t.Fatalf("runnerReauthCommand(codex) = %q — the remedy handed to phones, cars and TVs must work on a box with no browser", got)
	}
}

// A refusal the user can only fix by signing in must NAME the headless-capable way
// to do it. This is the one string a stranded user reads.
func TestLineageLostRemedyNamesDeviceAuth(t *testing.T) {
	err := &codexLineageLostError{}
	if !strings.Contains(err.Error(), "--device-auth") {
		t.Fatalf("lineage-lost remedy must name the headless sign-in, got: %s", err.Error())
	}
}
