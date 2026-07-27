package main

// capability_gap.go — ONE producer for "this machine cannot do that, and here
// is the tap that fixes it".
//
// THE INCIDENT (2026-07-26, e-mobile on a Hetzner arm64 box):
// the agent said, correctly, `exec flutter: executable file not found in
// $PATH`. The phone said *"Waiting for the dev server to report its
// address…"* — a spinner over a fact the agent had already stated. `POST
// /install/flutter` worked the whole time (install_http.go), including
// flutter_install.go's git-clone path for linux/arm64 where Flutter ships no
// tarball. The remedy string the agent produced even read *"or use Install on
// the preview panel, which streams the download"* — and there was no Install
// button on any preview panel on any surface.
//
// Three structural causes, all of which this file exists to remove:
//
//  1. The one structured refusal in the product (the 412 at
//     devserver_http.go) was gated behind readProjectPackageManifest, i.e.
//     behind package.json. Flutter has pubspec.yaml. Go, Rust, Python, Swift
//     and Kotlin have none of the above. For every non-Node project on earth
//     the structured refusal was unreachable by construction.
//  2. mgr.Start returns BEFORE the process is spawned (devserver.go, "Launch
//     start in background"), so /dev/start answered 200 OK on a start that was
//     already doomed. Every synchronous refusal lane was bypassed.
//  3. The remedy the async path did produce was flattened into prose appended
//     to a string. The agent had the tool name, the endpoint, the stream name
//     and the arch resolution in typed form, and threw all four away to build
//     a sentence.
//
// THE SHAPE. A remedy is a ROUTE, not a sentence: `method + path + stream` so
// a UI can render a button without knowing what the failure is. The agent has
// seven different JSON key names for "the remedy" (Remedy, SuggestedAction,
// HelpHint, Hint, Fix, InstallHint, NextAction) and not one of them carries
// that triple. GapFix is the triple.
//
// THE RULES THIS SERVES (CLAUDE.md, "a missing toolchain is a product
// requirement, not a user error"): state it → offer the fix if the fix exists
// → stream the fix → name the constraint if it does not. And: never advertise
// a remedy the product refuses — every Fix below is validated against the same
// tables `yaver install <name>` consults, in the same order, so a Fix this
// file emits can never 404.
//
// ADDING A GAP is meant to be one row here plus one recipe in the install
// table. Layers B (signal), C (UI) and D (route) then come for free on every
// surface, because they all key off Code and render Fix generically.

import (
	"fmt"
	"regexp"
	"strings"
)

// GapFix is the ROUTE — the thing the seven existing remedy fields all lack.
//
// Stream is the log-stream NAME ("install:flutter"), served at
// GET /streams/<stream>. It is DERIVED from Path by the same helper the 412
// hint uses (installStreamNameForEndpoint), never typed by hand: the previous
// generation of this advice named "/streams/install", a path no install ever
// opens, and a user who followed it watched a 404 and concluded the install
// was hung while it streamed perfectly one path over.
type GapFix struct {
	Label  string `json:"label"`         // "Install Flutter"
	Method string `json:"method"`        // "POST"
	Path   string `json:"path"`          // "/install/flutter"
	Stream string `json:"stream"`        // "install:flutter" → GET /streams/<stream>
	Est    string `json:"est,omitempty"` // "~1.2 GB · usually 3–10 min"
	Retry  bool   `json:"retry"`         // re-issue the original request on success
}

// CapabilityGap is a capability the operation needs and this machine does not
// have. Deliberately shaped after CapabilityTargetReadiness
// (capabilities_snapshot.go) — the existing type with the right idea — PLUS
// the missing route.
//
// Exactly one of Fix / Constraint is set. A gap with neither is a dead end
// with a sentence, which is the defect this type exists to make impossible.
type CapabilityGap struct {
	Code       string  `json:"code"`                 // reason_codes.go value — the wire contract
	Capability string  `json:"capability"`           // "flutter", "bun", "xcode-simulator"
	Summary    string  `json:"summary"`              // one sentence, user-facing (layer C)
	Detail     string  `json:"detail,omitempty"`     // what tapping Fix will do
	Fix        *GapFix `json:"fix,omitempty"`        // nil ⇒ no fixer; Constraint MUST be set
	Constraint string  `json:"constraint,omitempty"` // why no fix exists on THIS machine
}

// CapabilityGapContext is everything the detector may look at. Callers fill
// what they know: the 412 preflight knows MissingTools, the async start
// failure knows only Err.
type CapabilityGapContext struct {
	Framework    string
	WorkDir      string
	MissingTools []string
	Err          string
}

var (
	// `exec: "flutter": executable file not found in $PATH` (Go's os/exec)
	rxExecQuotedNotFound = regexp.MustCompile(`exec:?\s+"([^"]+)":\s*executable file not found`)
	// `exec flutter: executable file not found in $PATH` (our own wrapping)
	rxExecBareNotFound = regexp.MustCompile(`exec:?\s+([A-Za-z0-9._+-]+):\s*executable file not found`)
	// `flutter: command not found` (a shell that ran the spawn)
	rxCommandNotFound = regexp.MustCompile(`([A-Za-z0-9._+-]+):\s*command not found`)
)

// devStartToolchainBinary maps a dev-server framework to the executable its
// dev server must spawn, for frameworks whose readiness is NOT covered by the
// package.json-driven Node preflight.
//
// This table is the whole reason the Flutter case can be refused
// synchronously: detectProjectPreparation can only ever emit
// node/npm/npx/yarn/pnpm/bun/bunx, and it never runs at all without a
// package.json. Adding a row here is how a new non-Node toolchain gets a
// structured refusal, an Install button and a streamed fix on every surface.
//
// Only frameworks whose spawn name is KNOWN belong here. Guessing a binary
// that does not match what Start() execs would refuse a start that would have
// worked — wrong in the other direction, and just as much a defect.
func devStartToolchainBinary(framework string) string {
	switch strings.ToLower(strings.TrimSpace(framework)) {
	case "flutter":
		// devserver.go FlutterDevServer.Start → resolveSpawnPath("flutter").
		return "flutter"
	}
	return ""
}

// capabilityDisplayName is how a tool is named to a human. Falls back to the
// raw tool name, which is right for lowercase CLI names (bun, pnpm, adb).
func capabilityDisplayName(tool string) string {
	switch strings.ToLower(strings.TrimSpace(tool)) {
	case "flutter":
		return "Flutter"
	case "node":
		return "Node.js"
	case "mobile":
		return "the mobile toolchain"
	case "android-sdk":
		return "the Android SDK"
	case "java":
		return "Java"
	case "docker":
		return "Docker"
	}
	return strings.TrimSpace(tool)
}

// installEstimateForTool is the honest size/time a user is committing to.
// CLAUDE.md: "a 2 GB SDK behind a silent spinner is the same defect as a
// silent serve — the user cannot tell fetching from hung." Empty when we have
// no defensible number; a made-up estimate is worse than none.
func installEstimateForTool(tool string) string {
	switch strings.ToLower(strings.TrimSpace(tool)) {
	case "flutter":
		return "~1.2 GB SDK · usually 3–10 min"
	case "android-sdk":
		return "~2 GB · usually 5–15 min"
	case "mobile", "node":
		return "~60 MB · usually under a minute"
	}
	return ""
}

// installToolFromEndpoint recovers the tool name from an /install/<tool> path.
func installToolFromEndpoint(endpoint string) string {
	return strings.Trim(strings.TrimPrefix(strings.TrimSpace(endpoint), "/install/"), "/")
}

// missingToolFromError pulls the executable name out of a spawn failure.
// Returns "" when the text is not a missing-executable failure — never a
// guess, because a wrong tool name produces a Fix that installs the wrong
// thing and still leaves the user stuck.
func missingToolFromError(errText string) string {
	text := strings.TrimSpace(errText)
	if text == "" {
		return ""
	}
	for _, rx := range []*regexp.Regexp{rxExecQuotedNotFound, rxExecBareNotFound, rxCommandNotFound} {
		if m := rx.FindStringSubmatch(text); len(m) == 2 {
			tool := strings.TrimSpace(m[1])
			// os/exec sometimes hands back an absolute path; the install
			// tables are keyed by base name.
			if i := strings.LastIndexAny(tool, `/\`); i >= 0 {
				tool = tool[i+1:]
			}
			if tool != "" && tool != "exec" {
				return tool
			}
		}
	}
	return ""
}

// looksLikeMissingExecutable reports whether the text is a spawn failure of
// the "the binary is not there" family, even when the binary name could not
// be extracted.
func looksLikeMissingExecutable(errText string) bool {
	lower := strings.ToLower(errText)
	return strings.Contains(lower, "executable file not found") ||
		strings.Contains(lower, "command not found")
}

// DetectCapabilityGap is THE producer. Every carrier (the /dev/start 412, the
// /dev/events SSE error frame, /dev/status) gets its gap from here, so a new
// capability is taught to one function and appears on all of them.
//
// Returns nil when the failure is not a capability gap — a compile error, a
// port clash and a missing pubspec asset are all real failures with their own
// (different) remedies, and claiming a toolchain gap for them would send the
// user to install something they already have.
func DetectCapabilityGap(ctx CapabilityGapContext) *CapabilityGap {
	tools := make([]string, 0, len(ctx.MissingTools))
	for _, t := range ctx.MissingTools {
		if t = strings.TrimSpace(t); t != "" {
			tools = append(tools, t)
		}
	}
	if len(tools) == 0 {
		if t := missingToolFromError(ctx.Err); t != "" {
			tools = []string{t}
		}
	}
	if len(tools) == 0 && looksLikeMissingExecutable(ctx.Err) {
		// The text says a binary was missing but did not name it. The
		// framework's own table does — that is a resolution, not a guess.
		if t := devStartToolchainBinary(ctx.Framework); t != "" {
			tools = []string{t}
		}
	}
	if len(tools) == 0 {
		return nil
	}
	return capabilityGapForMissingTools(tools)
}

// capabilityGapForMissingTools builds the gap for a known-missing tool set.
//
// Resolution order matches `yaver install <name>` exactly (installableViaAgent
// → integrations → meta plans), which is what makes "never advertise a remedy
// the product refuses" a property rather than a hope.
func capabilityGapForMissingTools(tools []string) *CapabilityGap {
	primary := tools[0]
	gap := &CapabilityGap{
		Code:       ReasonCapabilityToolchainMissing,
		Capability: primary,
		Summary:    capabilityGapSummary(tools),
	}

	endpoint := installEndpointForTool(tools)
	if !canInstallMissingTool(tools) || endpoint == "" {
		// No fix on THIS machine — say which one specifically, and say what
		// the user can do instead. A gap with no Fix and no Constraint is a
		// dead end with a sentence.
		gap.Constraint = fmt.Sprintf(
			"Yaver has no install recipe for %s on this machine, so there is nothing to tap here. "+
				"Install it on the box yourself (GET /install/list shows everything the agent can "+
				"provision), then start the preview again.",
			strings.Join(tools, ", "))
		gap.Detail = gap.Constraint
		return gap
	}

	streamName := installStreamNameForEndpoint(endpoint)
	if streamName == "" {
		// The endpoint resolved but its stream name did not — refuse to
		// advertise a button whose progress the user could not watch.
		gap.Constraint = fmt.Sprintf(
			"Yaver resolved an installer for %s but could not name its progress stream, so the "+
				"install would run invisibly. Run `yaver install %s` on the box instead.",
			strings.Join(tools, ", "), primary)
		gap.Detail = gap.Constraint
		return gap
	}

	endpointTool := installToolFromEndpoint(endpoint)
	gap.Fix = &GapFix{
		Label:  "Install " + capabilityDisplayName(primary),
		Method: "POST",
		Path:   endpoint,
		Stream: streamName,
		Est:    installEstimateForTool(endpointTool),
		Retry:  true,
	}
	gap.Detail = fmt.Sprintf(
		"Yaver can install it here, no sudo needed. The download streams into this panel, and "+
			"the preview starts by itself when it finishes. Same thing from a terminal: "+
			"`yaver install %s`.", endpointTool)
	return gap
}

// capabilityGapSummary is the sentence the user reads. Deliberately about the
// MACHINE, not about Yaver: "Flutter isn't installed on this machine" is a
// fact the user can act on; "exec flutter: executable file not found in $PATH"
// is a fact only a developer can.
func capabilityGapSummary(tools []string) string {
	if len(tools) == 1 {
		return fmt.Sprintf("%s isn't installed on this machine.", capabilityDisplayName(tools[0]))
	}
	names := make([]string, 0, len(tools))
	for _, t := range tools {
		names = append(names, capabilityDisplayName(t))
	}
	return fmt.Sprintf("%s aren't installed on this machine.", strings.Join(names, ", "))
}
