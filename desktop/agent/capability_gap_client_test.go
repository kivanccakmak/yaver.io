package main

// capability_gap_client_test.go — pins the CLI's half of the capability-gap
// contract.
//
// The defect these guard against is not "the parser is wrong". It is "the CLI
// prints a sentence the user cannot act on while the same HTTP body carries the
// command that fixes it" — which is what `yaver dev start` did on every box
// missing a toolchain, for as long as the gap has existed.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func gapTestJSON(t *testing.T, v interface{}) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

// The exact body shape devStartGapRefusal produces for a missing framework CLI.
func flutterGapBody(t *testing.T) []byte {
	t.Helper()
	return gapTestJSON(t, map[string]interface{}{
		"ok":    false,
		"error": "exec flutter: executable file not found in $PATH",
		"capabilityGap": CapabilityGap{
			Code:       ReasonCapabilityToolchainMissing,
			Capability: "flutter",
			Summary:    "Flutter is not installed on this machine.",
			Detail:     "Yaver can install it here.",
			Fix: &GapFix{
				Label:  "Install Flutter",
				Method: "POST",
				Path:   "/install/flutter",
				Stream: "install:flutter",
				Est:    "~1.2 GB · usually 3–10 min",
				Retry:  true,
			},
		},
	})
}

func TestDecodeCapabilityGapErrorPromotesARefusalThatCarriesARoute(t *testing.T) {
	err := decodeCapabilityGapError(flutterGapBody(t), "fallback")
	if err == nil {
		t.Fatal("a body carrying capabilityGap must produce a typed error — this is the whole reason the CLI was blind")
	}
	gapErr := AsCapabilityGapError(err)
	if gapErr == nil {
		t.Fatalf("AsCapabilityGapError must unwrap its own type, got %T", err)
	}
	if gapErr.Gap.Capability != "flutter" {
		t.Fatalf("capability must survive, got %q", gapErr.Gap.Capability)
	}
	// The flat message MUST be preserved verbatim. Every existing call site
	// prints `%v`; if promoting the error changed that text, this "additive"
	// change would silently rewrite the output of a dozen commands.
	if gapErr.Error() != "exec flutter: executable file not found in $PATH" {
		t.Fatalf("the original error text must be preserved for %%v call sites, got %q", gapErr.Error())
	}
}

func TestDecodeCapabilityGapErrorUnwrapsThroughWrapping(t *testing.T) {
	inner := decodeCapabilityGapError(flutterGapBody(t), "fallback")
	wrapped := fmt.Errorf("start build: %w", inner)
	if AsCapabilityGapError(wrapped) == nil {
		t.Fatal("a command that decorates the error on its way up must not lose the gap")
	}
}

func TestDecodeCapabilityGapErrorIgnoresBodiesWithoutOne(t *testing.T) {
	cases := map[string][]byte{
		"plain error": []byte(`{"ok":false,"error":"port 8081 already in use"}`),
		"empty":       nil,
		"not json":    []byte(`<html>502 Bad Gateway</html>`),
		"gap with no code": gapTestJSON(t, map[string]interface{}{
			"capabilityGap": map[string]interface{}{"summary": "something"},
		}),
		"gap with no summary": gapTestJSON(t, map[string]interface{}{
			"capabilityGap": map[string]interface{}{"code": "capability.toolchain_missing"},
		}),
	}
	for name, raw := range cases {
		if err := decodeCapabilityGapError(raw, "fallback"); err != nil {
			// A half-formed gap must fall through to the flat path, not render
			// a heading with no sentence under it.
			t.Errorf("%s: must fall through to the existing flat-error path, got %v", name, err)
		}
	}
}

func TestDecodeCapabilityGapErrorReadsTheTasksLaneSpelling(t *testing.T) {
	// tasks_capability_gap.go attaches `capabilityGap` + `errorSummary`; the
	// dev-events lane spells it `gap`. Keying on one would have shipped a
	// parser that works on one lane and silently not the other.
	raw := gapTestJSON(t, map[string]interface{}{
		"gap": CapabilityGap{
			Code:       ReasonCapabilityToolchainMissing,
			Capability: "claude",
			Summary:    "Claude Code is not installed on this machine.",
			Fix:        &GapFix{Method: "POST", Path: "/install/claude", Stream: "install:claude", Retry: true},
		},
	})
	gapErr := AsCapabilityGapError(decodeCapabilityGapError(raw, "runner not ready"))
	if gapErr == nil {
		t.Fatal("the `gap` key must parse too")
	}
	if gapErr.Error() != "runner not ready" {
		t.Fatalf("with no `error` key the fallback message is used, got %q", gapErr.Error())
	}
}

func TestCapabilityGapCommandOnlyAdvertisesInstallsThatExist(t *testing.T) {
	real := &CapabilityGap{
		Code:    ReasonCapabilityToolchainMissing,
		Summary: "Flutter is not installed on this machine.",
		Fix:     &GapFix{Method: "POST", Path: "/install/flutter", Stream: "install:flutter"},
	}
	if got := capabilityGapCommand(real); got != "yaver install flutter" {
		t.Fatalf("a tool the installer knows must be offered as a command, got %q", got)
	}

	// A remedy that fails is how a product teaches people to stop trusting its
	// remedies: never print `yaver install <x>` for an x the installer would
	// reject with `unknown integration`.
	bogus := &CapabilityGap{
		Code:    ReasonCapabilityToolchainMissing,
		Summary: "Nonesuch is not installed.",
		Fix:     &GapFix{Method: "POST", Path: "/install/definitely-not-a-real-integration", Stream: "s"},
	}
	if got := capabilityGapCommand(bogus); got != "" {
		t.Fatalf("an unknown tool must NOT be advertised as a runnable command, got %q", got)
	}

	nonInstall := &CapabilityGap{
		Code:    ReasonCapabilityToolchainMissing,
		Summary: "x",
		Fix:     &GapFix{Method: "POST", Path: "/storage/reclaim", Stream: ""},
	}
	if got := capabilityGapCommand(nonInstall); got != "" {
		t.Fatalf("a non-install route is not an install command, got %q", got)
	}
	if got := capabilityGapCommand(&CapabilityGap{Summary: "x"}); got != "" {
		t.Fatalf("a gap with no fix has no command, got %q", got)
	}
}

func TestPrintCapabilityGapNamesTheToolAndTheCommand(t *testing.T) {
	var buf bytes.Buffer
	printCapabilityGap(&buf, "yaver dev start", &CapabilityGap{
		Code:       ReasonCapabilityToolchainMissing,
		Capability: "flutter",
		Summary:    "Flutter is not installed on this machine.",
		Detail:     "Yaver can install it here.",
		Fix: &GapFix{
			Label: "Install Flutter", Method: "POST", Path: "/install/flutter",
			Stream: "install:flutter", Est: "~1.2 GB · usually 3–10 min", Retry: true,
		},
	})
	out := buf.String()
	for _, want := range []string{
		"yaver dev start: Flutter is not installed on this machine.",
		"Yaver can install it here.",
		"yaver install flutter",        // the button, spelled as a CLI can spell it
		"~1.2 GB",                      // how long the user is about to wait
		"re-run this command",          // retry:true means "return them to what they were doing"
		"yaver stream install:flutter", // watching it is part of the fix
	} {
		if !strings.Contains(out, want) {
			t.Errorf("gap output must contain %q\n---\n%s", want, out)
		}
	}
}

func TestPrintCapabilityGapOffersNoButtonWhenThereIsNoRoute(t *testing.T) {
	var buf bytes.Buffer
	printCapabilityGap(&buf, "yaver dev start", &CapabilityGap{
		Code:       ReasonCapabilityToolchainMissing,
		Capability: "xcode",
		Summary:    "Xcode is not installed on this machine.",
		Constraint: "Xcode cannot be installed unattended — get it from the App Store.",
	})
	out := buf.String()
	if !strings.Contains(out, "App Store") {
		t.Fatalf("a constrained gap must say WHY there is no fix\n---\n%s", out)
	}
	// Offering an install that cannot work teaches the user Yaver lies.
	if strings.Contains(out, "yaver install") {
		t.Fatalf("a gap with no fix must not advertise an install\n---\n%s", out)
	}
}

func TestPrintCapabilityGapCarriesTheDiskWarningAndTheWayOut(t *testing.T) {
	var buf bytes.Buffer
	printCapabilityGap(&buf, "yaver dev start", &CapabilityGap{
		Code:       ReasonCapabilityInsufficientDisk,
		Capability: "flutter",
		Summary:    "Not enough free space to install Flutter.",
		Warning:    "The first build needs another 2 GB on top of the SDK.",
		Resource: &CapabilityResource{
			Path: "/opt", FreeHuman: "3.1 GB", NeedHuman: "1.2 GB",
			ReclaimableHuman: "8.4 GB", Level: "tight",
		},
		Reclaim: &GapFix{Label: "Clear build caches", Method: "POST", Path: "/storage/reclaim"},
	})
	out := buf.String()
	for _, want := range []string{
		"Heads-up: The first build needs another 2 GB",
		"3.1 GB free on /opt",
		"8.4 GB reclaimable",
		"Clear build caches",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("resource gap must contain %q\n---\n%s", want, out)
		}
	}
}

func TestPrintCapabilityGapForErrorReportsWhetherItPrinted(t *testing.T) {
	var buf bytes.Buffer
	// A plain error must NOT be swallowed — the caller relies on `false` to
	// know it still owes the user its own `Error: %v` line.
	if printCapabilityGapForError(&buf, "yaver dev start", fmt.Errorf("port in use")) {
		t.Fatal("a plain error must report false so the caller still prints it")
	}
	if buf.Len() != 0 {
		t.Fatalf("a plain error must print nothing here, got %q", buf.String())
	}
	if !printCapabilityGapForError(&buf, "yaver dev start", decodeCapabilityGapError(flutterGapBody(t), "x")) {
		t.Fatal("a gap error must report true so the caller does not print the same thing twice in two shapes")
	}
	if !strings.Contains(buf.String(), "yaver install flutter") {
		t.Fatalf("the printed gap must carry the command\n---\n%s", buf.String())
	}
}
