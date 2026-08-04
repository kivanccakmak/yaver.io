package main

// reason_code_wiring_test.go — the reason-code audit, as a ratchet.
//
// WHY THIS IS A TEST AND NOT A DOCUMENT.
// `docs/audits/reason-code-wiring-audit-2026-08-03.md` was written by hand on
// 2026-08-03 and was WRONG IN BOTH DIRECTIONS on 29 of 31 codes: it reported 8
// codes as NEVER-EMITTED and 14 as DEAD, when in fact only ONE code has no
// emitter at all. `capability.toolchain_missing` — the audit's headline finding,
// carried into the handoff as the "cheapest user-visible win in the repo" —
// has had an emitter since 2026-07-27 (`capability_gap.go`, commit 7b9e42c66,
// six days BEFORE the audit). A session acting on that document would have
// spent a pass re-emitting a code that was already emitted, and would have
// found the real hole — twenty codes the agent sends that NO surface reads —
// only by accident.
//
// The audit's own closing line asked for this: "This audit is a script's worth
// of work and belongs in CI, so the next code added is wired or is visibly
// not." A hand-run script produced a confidently wrong table. A test cannot.
//
// THE MEASUREMENT
//   emitter  — the Go symbol or its string literal appears in desktop/agent or
//              backend, outside tests and outside reason_codes.go itself.
//   consumer — the string literal appears in a shipped surface (mobile, web,
//              tvos, visionos, watch, wear), outside tests.
//
// Both halves are deliberately textual. A code is a WIRE CONTRACT: the producer
// and the consumer never share a type, so text is the only thing they can
// actually agree on, and text is therefore the only honest thing to measure.
//
// THE RATCHET. Every code that is not fully wired today is listed in
// unwiredReasonCodes with the reason. The test fails when:
//   • a code is unwired and NOT listed        → new drift, wire it or list it
//   • a code IS listed and has become wired   → stale entry, delete the line
// The second half is what stops this file rotting into the document it
// replaced: you cannot fix a code and leave the audit claiming it is broken.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// unwiredReasonCodes is the ratchet: every code that does not yet close the
// producer→consumer loop, and why. Deleting a line is how a fix is recorded.
//
// MEASURED 2026-08-03 (by this test, not by hand). One code has no emitter;
// twenty are emitted into silence. That inversion is the actual state of layer
// B, and it means the standing advice "emit the never-emitted codes" was
// pointed at a hole that does not exist.
var unwiredReasonCodes = map[string]string{
	// auth.sdk.scope_denied WAS the one dead code (neither end). Wired
	// 2026-08-04 into all FOUR SDK scope-denial sites in httpserver.go — the
	// check is duplicated across the auth wrappers, so naming it in one place
	// would have left three surfaces still guessing. It stays here only until a
	// surface reads it; see the NO-CONSUMER block below.
	"auth.sdk.scope_denied": "now EMITTED (sdkScopeDenied, 4 sites); no surface reads it yet.",

	// The five browser_window.chrome_* codes were removed from this list on
	// 2026-08-04: each now rides a CapabilityGap (browserWindowGap) with a remedy
	// that differs per code, so the generic renderers consume them. They had been
	// interpolated into an error STRING, which is why no surface could read them.
	//
	// task.manager_unavailable and the three capability-snapshot codes moved out
	// of this list on 2026-08-04 as they were consumed.
	//
	// ONE LIMITATION THIS GUARD CANNOT SEE, stated so nobody mistakes its count
	// for more than it measures: it proves a surface tree REFERENCES the code, not
	// that a rendered screen calls the code that references it. The three
	// capability-snapshot codes are classified by web+mobile capabilityReadiness.ts
	// — and no component fetches /capabilities/snapshot yet, so the classifier has
	// no call site. That is genuine progress (the next panel cannot render a Retry
	// over "Xcode does not exist on Linux") but it is NOT a rendered pixel, and a
	// count of 21 WIRED should be read with that in mind.
	"task.manager_unavailable": "emitted by feedback_http.go's promptless/no-task-manager refusal; no surface classifies it yet — the 503 sentence carries the meaning today.",

	// ── NO-CONSUMER: the agent sends these; no surface reads one of them. ──
	// This is the real layer-B gap. A code sent into silence is
	// indistinguishable from prose — every one of these arrives on a surface
	// that then falls back to regexing the sentence beside it.
	// task.prompt_missing is emitted by createTask's promptless guard. No
	// surface reads it yet — a caller sending the wrong key is a developer-facing
	// mistake today, and the 400 body already carries the sentence.
	"task.prompt_missing": "emitted by createTask (promptless refusal); no surface reads it yet.",

	"connectivity.relay.auth_expired": "emitted by planRemoteBoxRepair → ops remote_repair; no surface reads it.",
	"connectivity.relay.pin_stale":    "emitted by planRemoteBoxRepair; no surface reads it. Reads as a possible MITM — must never render as an auth problem.",
	"runner.claude.auth_required":     "emitted by the runner-auth lane; no surface reads it.",
	"runner.opencode.unusable":        "emitted by the runner-auth lane; no surface reads it.",
	"reload.dev_server_unavailable":   "emitted by the reload lane; no surface reads it.",
	"reload.native_rebuild_required":  "emitted by the reload lane; no surface reads it.",
	"reload.preview_worker.offline":   "emitted by the reload lane; no surface reads it.",
	"build.hermes.failed":             "emitted by the build lane; no surface reads it.",
	"build.native.failed":             "emitted by the build lane; no surface reads it.",
	"device.identity_conflict":        "LOG-ONLY: its only uses are inside a log.Printf in auth_bootstrap.go, so it is on no wire and no surface could read it even in principle. Put it on a payload BEFORE writing any client. A box in this state can otherwise only render as 'unreachable'.",
	"agent.binary_unrunnable":         "emitted by planRemoteBoxRepair; no surface reads it.",
	"agent.not_serving":               "emitted by planRemoteBoxRepair; no surface reads it.",
}

// reasonCodeRidesTheGapEnvelope reports whether this file attaches the code to a
// CapabilityGap. Deliberately narrow: it wants the code set as the Code field of
// a gap literal, which is the one shape the generic renderers key off.
func reasonCodeRidesTheGapEnvelope(body, symbol string) bool {
	return strings.Contains(body, "Code:       "+symbol) ||
		strings.Contains(body, "Code: "+symbol) ||
		strings.Contains(body, "Code:  "+symbol) ||
		strings.Contains(body, "gap.Code = "+symbol)
}

var rxReasonCodeDecl = regexp.MustCompile(`^\s*(Reason[A-Za-z0-9]+)\s*=\s*"([^"]+)"`)

type reasonCodeWiring struct {
	symbol   string
	literal  string
	emitters []string
	// logOnly are files where the code appears ONLY inside a log call — visible
	// to whoever reads the journal on that box, and to nobody else.
	logOnly []string
	// envelope are files where the code is attached to a CapabilityGap, i.e. it
	// reaches every surface through the generic gap renderers without any
	// surface naming it.
	envelope  []string
	consumers []string
}

// reasonCodeIsLogOnly reports whether every line mentioning the code in this
// file is a logging call. Deliberately line-based and dumb: a smarter parse
// would be another thing to be wrong about, and the failure mode of this check
// (calling a real emitter log-only) is loud — the code then shows up as
// LOG-ONLY and someone re-reads the file.
func reasonCodeIsLogOnly(body, symbol, quoted string) bool {
	lines := strings.Split(body, "\n")
	mentions := 0
	for i, line := range lines {
		if !strings.Contains(line, symbol) && !strings.Contains(line, quoted) {
			continue
		}
		if strings.HasPrefix(strings.TrimSpace(line), "//") {
			continue
		}
		mentions++
		// LOOK BACKWARDS. A log call is routinely wrapped, and the code lands on
		// a CONTINUATION line that contains no "log.Printf" at all:
		//
		//	log.Printf("[auth-expired-convex] %s (%s) — Convex said: %s",
		//		deviceIdentityConflictRemedy(kind, cfg.DeviceID), ReasonDeviceIdentityConflict, body)
		//
		// The first version of this helper only inspected the mention's own line
		// and therefore classified that as a real emitter — the third wrong
		// measurement in this file's short history, and the same shape as the
		// other two: counting where a string APPEARS instead of what happens to
		// it. Three lines of lookback is enough for gofmt-wrapped calls.
		inLog := false
		for j := i; j >= 0 && j >= i-3; j-- {
			l := lines[j]
			if strings.Contains(l, "log.Printf") || strings.Contains(l, "log.Print") ||
				strings.Contains(l, "fmt.Fprintf") || strings.Contains(l, "logf(") {
				inLog = true
				break
			}
			// A statement boundary means the log call, if any, already closed.
			if j < i && (strings.HasSuffix(strings.TrimSpace(l), "{") || strings.HasSuffix(strings.TrimSpace(l), "}")) {
				break
			}
		}
		if !inLog {
			return false
		}
	}
	return mentions > 0
}

// emitterRoots are the places a producer may live. Convex is included because
// the backend is a producer too — several codes describe control-plane
// refusals, not agent-local ones.
var emitterRoots = []string{
	filepath.Join("desktop", "agent"),
	filepath.Join("backend", "convex"),
}

// consumerRoots are the SHIPPED surfaces. mobile/src + mobile/app cover the
// React-Native family (phone, tablet, car, glass — they share this code);
// tvos/visionos/watch/wear are the native surfaces that must be ported
// explicitly and therefore drift on their own.
var consumerRoots = []string{
	filepath.Join("mobile", "src"),
	filepath.Join("mobile", "app"),
	filepath.Join("web", "lib"),
	filepath.Join("web", "components"),
	filepath.Join("web", "app"),
	"tvos",
	"visionos",
	"watch",
	"wear",
}

func isTestSource(path string) bool {
	base := filepath.Base(path)
	return strings.HasSuffix(base, "_test.go") ||
		strings.Contains(base, ".test.") ||
		strings.Contains(base, ".spec.") ||
		strings.Contains(base, "Tests.swift") ||
		strings.Contains(base, "Checks.swift")
}

func sourceExts(path string) bool {
	switch filepath.Ext(path) {
	case ".go", ".ts", ".tsx", ".swift", ".kt", ".js", ".jsx":
		return true
	}
	return false
}

// collectSources reads every source file under root once. Scanning per-code
// would re-read the tree 31 times; the whole point of a test over a script is
// that it stays cheap enough to run every time.
func collectSources(t *testing.T, root string, skipReasonCodesFile bool) map[string]string {
	t.Helper()
	out := map[string]string{}
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			switch d.Name() {
			case "node_modules", ".git", "build", "dist", ".next", "Pods", "DerivedData", ".expo":
				return filepath.SkipDir
			}
			return nil
		}
		if !sourceExts(path) || isTestSource(path) {
			return nil
		}
		if skipReasonCodesFile && filepath.Base(path) == "reason_codes.go" {
			return nil
		}
		b, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		out[path] = string(b)
		return nil
	})
	return out
}

func measureReasonCodeWiring(t *testing.T) []reasonCodeWiring {
	t.Helper()
	root := repoRoot(t)

	decl, err := os.ReadFile(filepath.Join(root, "desktop", "agent", "reason_codes.go"))
	if err != nil {
		t.Fatalf("reason_codes.go unreadable: %v", err)
	}

	codes := []reasonCodeWiring{}
	for _, line := range strings.Split(string(decl), "\n") {
		if m := rxReasonCodeDecl.FindStringSubmatch(line); m != nil {
			codes = append(codes, reasonCodeWiring{symbol: m[1], literal: m[2]})
		}
	}
	if len(codes) == 0 {
		t.Fatal("parsed 0 reason codes out of reason_codes.go — the declaration shape changed and this guard went blind")
	}

	emitterSrc := map[string]string{}
	for _, r := range emitterRoots {
		for p, body := range collectSources(t, filepath.Join(root, r), true) {
			emitterSrc[p] = body
		}
	}
	consumerSrc := map[string]string{}
	for _, r := range consumerRoots {
		for p, body := range collectSources(t, filepath.Join(root, r), false) {
			consumerSrc[p] = body
		}
	}

	for i := range codes {
		c := &codes[i]
		quoted := `"` + c.literal + `"`
		for p, body := range emitterSrc {
			// The symbol is how Go code emits it; the literal is how Convex and
			// hand-written maps do. Either counts — a consumer cannot tell them
			// apart on the wire.
			if !strings.Contains(body, c.symbol) && !strings.Contains(body, quoted) {
				continue
			}
			// LOG-ONLY IS NOT EMITTED.
			//
			// The first version of this guard counted any non-test mention as an
			// emitter, which is how it reported device.identity_conflict as
			// "emitted with no consumer". In fact its ONLY uses are inside
			// log.Printf — the code never reaches a wire at all, so no surface
			// could consume it even in principle. That is a different, worse
			// state than "sent and ignored", and collapsing the two reproduces
			// the exact mistake this file was written to correct: a measurement
			// that counts the appearance of a string instead of the behaviour.
			if reasonCodeIsLogOnly(body, c.symbol, quoted) {
				c.logOnly = append(c.logOnly, p)
				continue
			}
			// A CODE ON THE CapabilityGap ENVELOPE IS ALREADY CONSUMED.
			//
			// This guard's first model counted a consumer only when a surface file
			// mentioned the LITERAL. That is backwards for the architecture we
			// actually want: the renderers are deliberately code-AGNOSTIC — they
			// take the gap, show summary/detail/constraint and render fix/aiFix as
			// buttons, without knowing which failure it is. So a correctly-designed
			// gap has no literal on any surface, and the guard reported it as
			// "emitted into silence" while three surfaces rendered it.
			//
			// Caught by build.compile_failed on 2026-08-04. Left alone, this guard
			// would have pushed every future gap toward hardcoding its code into
			// each client — the exact per-surface drift CapabilityGap exists to
			// prevent. Measuring the appearance of a string instead of the
			// behaviour, for the third time in this file's history.
			if reasonCodeRidesTheGapEnvelope(body, c.symbol) {
				c.envelope = append(c.envelope, p)
			}
			c.emitters = append(c.emitters, p)
		}
		for p, body := range consumerSrc {
			if strings.Contains(body, quoted) {
				c.consumers = append(c.consumers, p)
			}
		}
	}
	return codes
}

// TestReasonCodeWiring_Ratchet is the guard. It reports the measured state of
// every code and fails on drift in either direction.
func TestReasonCodeWiring_Ratchet(t *testing.T) {
	codes := measureReasonCodeWiring(t)

	wired, emittedOnly, consumedOnly, dead, logOnly := 0, 0, 0, 0, 0
	for _, c := range codes {
		hasE, hasC := len(c.emitters) > 0, len(c.consumers) > 0
		if !hasE && len(c.logOnly) > 0 {
			logOnly++
		}
		_, listed := unwiredReasonCodes[c.literal]

		switch {
		case hasE && hasC:
			wired++
			if listed {
				t.Errorf("%s is WIRED now (%d emitters, %d consumers) but is still listed in unwiredReasonCodes — delete the line. An allowlist that outlives its defect is how the audit this test replaced became wrong.",
					c.literal, len(c.emitters), len(c.consumers))
			}
		case hasE && !hasC && len(c.envelope) > 0:
			// Consumed generically. Counted separately so the summary never
			// implies a per-surface switch that deliberately does not exist.
			wired++
		case hasE && !hasC:
			emittedOnly++
			if !listed {
				t.Errorf("%s is EMITTED INTO SILENCE — emitted by %v, read by no surface. Land the consumer in the same change, or add it to unwiredReasonCodes with the reason.",
					c.literal, c.emitters)
			}
		case !hasE && hasC:
			consumedOnly++
			if !listed {
				t.Errorf("%s is a DEAD UI BRANCH — %d surface(s) switch on it and nothing emits it: %v. Land the emitter, or add it to unwiredReasonCodes.",
					c.literal, len(c.consumers), c.consumers)
			}
		default:
			dead++
			if !listed {
				if len(c.logOnly) > 0 {
					t.Errorf("%s reaches only a LOG LINE (%v) — it is on no wire, so no surface can consume it even in principle. Put it on a payload (jsonErrorWithGap, a CapabilityGap, the heartbeat) or add it to unwiredReasonCodes with the reason.",
						c.literal, c.logOnly)
					break
				}
				t.Errorf("%s has neither producer nor consumer. Wire both ends or delete the constant — a code that compiles clean and silent is the defect this file exists to make loud.",
					c.literal)
			}
		}
	}

	// Fail a listed code that no longer exists: a stale key means the ratchet is
	// silently protecting nothing.
	present := map[string]bool{}
	for _, c := range codes {
		present[c.literal] = true
	}
	for lit := range unwiredReasonCodes {
		if !present[lit] {
			t.Errorf("unwiredReasonCodes lists %q, which is no longer declared in reason_codes.go — delete the entry.", lit)
		}
	}

	t.Logf("reason codes: %d total · %d WIRED · %d emitted-with-no-consumer · %d consumed-but-never-emitted · %d dead (of which %d reach only a log line)",
		len(codes), wired, emittedOnly, consumedOnly, dead, logOnly)
}

// TestGenericGapRenderersExist is the assumption behind counting an
// envelope-carried code as consumed.
//
// The ratchet treats "attached to a CapabilityGap" as reaching every surface.
// That is only true while the surfaces actually HAVE a generic gap renderer, so
// this asserts each one — otherwise the concession silently turns into a way to
// mark anything consumed by wrapping it in a struct.
func TestGenericGapRenderersExist(t *testing.T) {
	root := repoRoot(t)
	for _, r := range []struct {
		path  string
		needs []string
	}{
		{filepath.Join("mobile", "src", "lib", "capabilityGap.ts"), []string{"parseCapabilityGap", "gapFixLabel", "gapAIFixLabel"}},
		{filepath.Join("web", "lib", "capabilityGap.ts"), []string{"parseCapabilityGap", "gapFixLabel", "gapAIFixLabel"}},
		{filepath.Join("tvos", "YaverTV", "FailureSignals.swift"), []string{"parseCapabilityGap", "gapFixLabel", "gapAIFixLabel"}},
	} {
		body, err := os.ReadFile(filepath.Join(root, r.path))
		if err != nil {
			t.Errorf("%s is missing — a surface with no generic gap renderer cannot consume an envelope-carried code, so the ratchet's concession is void", r.path)
			continue
		}
		for _, need := range r.needs {
			// The OPEN PAREN matters. Without it this check could not fail:
			// renaming gapAIFixLabel to gapAIFixLabelRENAMED still CONTAINS
			// "gapAIFixLabel", so the break-test passed and the guard was a guess
			// (proven 2026-08-04 by trying exactly that). `name(` is present in
			// the declaration on all three surfaces — `export function name(` in
			// TS, `static func name(` in Swift — and absent after any rename.
			if !strings.Contains(string(body), need+"(") {
				t.Errorf("%s has no %s — the ratchet counts envelope-carried codes as consumed BECAUSE this renderer exists", r.path, need)
			}
		}
	}
}

// TestReasonCodeWiring_ToolchainMissingIsEmitted pins the specific claim the
// hand audit got wrong, because "the cheapest user-visible win in the repo" was
// filed against a code that already had a producer. If capability_gap.go ever
// stops setting it, that IS a real regression — and it must not be discovered
// by a document written six days later.
func TestReasonCodeWiring_ToolchainMissingIsEmitted(t *testing.T) {
	for _, c := range measureReasonCodeWiring(t) {
		if c.literal != ReasonCapabilityToolchainMissing {
			continue
		}
		if len(c.emitters) == 0 {
			t.Fatalf("%s has no emitter — capability_gap.go must set it on every missing-toolchain gap", c.literal)
		}
		if len(c.consumers) == 0 {
			t.Fatalf("%s has no consumer — six surfaces were built to render it", c.literal)
		}
		t.Logf("%s: %d emitters, %d consumers", c.literal, len(c.emitters), len(c.consumers))
		return
	}
	t.Fatalf("%s is not declared in reason_codes.go", ReasonCapabilityToolchainMissing)
}
