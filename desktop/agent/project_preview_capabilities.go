package main

// project_preview_capabilities.go — ONE place that answers "what can I actually
// do with this project?", derived from detection rather than hardcoded per
// surface.
//
// Why this exists:
//
// The list of preview actions used to be assembled inside the mobile Projects
// screen, in TypeScript, with the rules inline — `isHermesMobileFramework(fw)`
// gates the Hermes buttons, a literal `fw === "swift" || fw === "kotlin"` gates
// the remote-runtime button, and so on. Three problems followed from that, and
// all three are the same problem:
//
//  1. EVERY OTHER SURFACE HAD TO REIMPLEMENT IT. Web, tvOS, glass/AR-VR and any
//     future surface each needed their own copy of the same conditionals, and
//     nothing kept the copies honest. Cross-surface parity is a house rule here
//     precisely because copies drift.
//
//  2. THE RULES WERE HARDCODED PER FRAMEWORK NAME. Adding a stack meant editing
//     a switch in each surface. Detection already knows what the project is;
//     the option list should FOLLOW from detection, not be maintained beside
//     it.
//
//  3. A UI-ONLY RULE IS NOT A RULE. The mobile screen could hide the Hermes
//     button while the endpoint happily served the same build to a caller that
//     didn't hide it — see the recursion guard in devserver_http.go.
//
// So: the agent detects, decides, and returns a list of options with support
// flags and reasons. Surfaces render what they are given. A surface may drop an
// option it cannot present, but it must never invent one.
//
// THE HARD RULE ENCODED HERE: Hermes is React Native / Expo ONLY. A Hermes
// bundle is JavaScript bytecode loaded into a React Native container — there is
// nothing for it to load in a Flutter, Kotlin, Swift or plain-web project. It
// must not merely be greyed out for those stacks; it must not appear.

import (
	"context"
	"path/filepath"
	"strings"
)

// Preview option identifiers. These are contract with every surface — the
// mobile action sheet, the web dashboard, tvOS. Do not rename casually.
const (
	PreviewOptionHermes        = "compile-hermes"
	PreviewOptionOpenNative    = "open-native"
	PreviewOptionRemoteRuntime = "remote-runtime"
	PreviewOptionDevServer     = "dev-server"
	PreviewOptionWirePush      = "wire-push"
)

// ProjectPreviewOption is one thing the user can do with this project.
//
// Unsupported options are RETURNED, not omitted — when an option is one the
// user could reasonably expect, saying why it is unavailable beats it silently
// not existing. Options that make no sense for the stack at all (Hermes on
// Flutter) are omitted entirely; there is no useful "why" for something that
// was never applicable.
type ProjectPreviewOption struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Supported bool   `json:"supported"`
	Primary   bool   `json:"primary,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Framework string `json:"framework,omitempty"`
}

// ProjectPreviewCapabilities is the whole answer for one project.
type ProjectPreviewCapabilities struct {
	WorkDir string `json:"workDir,omitempty"`
	// Framework as DETECTED on disk — never taken from the caller. A surface
	// that guesses wrong would render options the project cannot support.
	Framework string `json:"framework"`
	// SelfDevelopment marks Yaver developing Yaver, which removes Hermes.
	SelfDevelopment bool                   `json:"selfDevelopment"`
	HasPairedDevice bool                   `json:"hasPairedDevice"`
	Options         []ProjectPreviewOption `json:"options"`
	Reason          string                 `json:"reason,omitempty"`
}

// hermesCapableFramework is the single source of truth for "can this stack load
// a Hermes bundle at all". Hermes bytecode is executed by a React Native
// runtime; nothing else can host it.
func hermesCapableFramework(framework string) bool {
	switch strings.ToLower(strings.TrimSpace(framework)) {
	case "expo", "react-native":
		return true
	default:
		return false
	}
}

// nativeMobileFramework is a stack that needs a real device/emulator runtime
// rather than a browser.
func nativeMobileFramework(framework string) bool {
	switch strings.ToLower(strings.TrimSpace(framework)) {
	case "swift", "kotlin":
		return true
	default:
		return false
	}
}

// browserRenderableFramework is a stack whose dev output a browser can render,
// so remote-runtime streaming / direct URL apply.
func browserRenderableFramework(framework string) bool {
	switch strings.ToLower(strings.TrimSpace(framework)) {
	case "flutter", "nextjs", "vite", "react", "web", "astro", "remix":
		return true
	default:
		return false
	}
}

// DetectProjectPreviewCapabilities is the entry point every surface should use.
//
// framework is detected from disk when workDir is readable; the caller's hint
// is only a fallback for the case where the agent cannot see the project (a
// remote/unscanned path).
func DetectProjectPreviewCapabilities(workDir, frameworkHint string, hasPairedDevice bool) ProjectPreviewCapabilities {
	framework := ""
	if strings.TrimSpace(workDir) != "" {
		framework = detectFramework(workDir)
	}
	if framework == "" {
		framework = strings.ToLower(strings.TrimSpace(frameworkHint))
	}

	caps := ProjectPreviewCapabilities{
		WorkDir:         workDir,
		Framework:       framework,
		HasPairedDevice: hasPairedDevice,
		SelfDevelopment: IsYaverSelfDevelopmentDir(workDir) ||
			IsYaverSelfDevelopment(filepath.Base(strings.TrimSuffix(workDir, "/")), ""),
	}

	switch {
	// ── React Native / Expo — the only Hermes-capable stacks ─────────────
	case hermesCapableFramework(framework):
		if caps.SelfDevelopment {
			// Yaver-into-Yaver withholds HERMES — and only Hermes. The web
			// lane is the route the refusal itself names
			// (ShouldRefuseYaverSelfDevelopmentHermes: "refusing those would
			// block the very route this guard steers people toward"), so it
			// MUST be advertised here.
			//
			// It was not, until 2026-08-02. This arm offered exactly one
			// option — Stream over WebRTC — and mobileProjectActions.ts's
			// consuming rule is "a lane the agent doesn't offer is ABSENT,
			// not greyed out". So Browser Reload did not exist as a button
			// for Yaver's own repo: the refusal said "go this way" and the
			// advertiser never drew the door. Attach Mode (Yaver rendering
			// Yaver over the browser lane) was unreachable by construction.
			//
			// The pairing is now asserted by TestSelfDevOffersTheLaneTheRefusalNames:
			// whatever ShouldRefuseYaverSelfDevelopmentHermes leaves legal,
			// this arm must offer.
			caps.Options = append(caps.Options,
				ProjectPreviewOption{
					ID: PreviewOptionDevServer, Label: "Browser Reload",
					Supported: true, Primary: true, Framework: framework,
					Reason: "Yaver developing Yaver — the RN web target renders in a WebView whose escape " +
						"lives in the phone's native chrome, outside anything the previewed app can reach",
				},
				ProjectPreviewOption{
					ID: PreviewOptionRemoteRuntime, Label: "Stream over WebRTC",
					Supported: true, Framework: framework,
					Reason: "streams pixels from a browser on the box; heavier than Browser Reload, same escape guarantee",
				},
			)
			caps.Reason = "Yaver self-development: Hermes is withheld because loading Yaver into Yaver " +
				"puts two shake/exit owners in one React Native process and the preview could not be exited. " +
				"The web target is unaffected and is the primary route."
		} else {
			caps.Options = append(caps.Options,
				ProjectPreviewOption{
					ID: PreviewOptionDevServer, Label: "Browser Reload",
					Supported: true, Primary: true, Framework: framework,
				},
				ProjectPreviewOption{
					ID: PreviewOptionOpenNative, Label: "Open in Yaver",
					Supported: hasPairedDevice, Framework: framework,
					Reason: pairedDeviceReason(hasPairedDevice),
				},
				ProjectPreviewOption{
					ID: PreviewOptionHermes, Label: "Compile Hermes bundle",
					Supported: true, Framework: framework,
				},
				ProjectPreviewOption{
					ID: PreviewOptionRemoteRuntime, Label: "Stream over WebRTC",
					Supported: true, Framework: framework,
					Reason: "runs the RN web target on the box",
				},
			)
			caps.Reason = "React Native / Expo: Browser Reload is the lightest preview path and keeps reload/render inside the browser lane; " +
				"Hermes remains available for real-container checks, and WebRTC covers streamed native surfaces."
		}

	// ── Native mobile: Swift / Kotlin ────────────────────────────────────
	case nativeMobileFramework(framework):
		// NO Hermes entry at all — there is no React Native runtime here to
		// load bytecode into, so offering it (even disabled) is noise.
		caps.Options = append(caps.Options, ProjectPreviewOption{
			ID: PreviewOptionRemoteRuntime, Label: "Remote Runtime",
			Supported: true, Primary: true, Framework: framework,
			Reason: nativeRuntimeReason(framework),
		})
		caps.Options = append(caps.Options, ProjectPreviewOption{
			ID: PreviewOptionWirePush, Label: "Install on connected device",
			Supported: hasPairedDevice, Framework: framework,
			Reason: pairedDeviceReason(hasPairedDevice),
		})
		caps.Reason = "native " + framework + ": needs a real device or an emulator/simulator — " +
			"Hermes does not apply, there is no React Native runtime to load a bundle into."

	// ── Flutter and web stacks ───────────────────────────────────────────
	case browserRenderableFramework(framework):
		caps.Options = append(caps.Options,
			ProjectPreviewOption{
				ID: PreviewOptionDevServer, Label: "Dev server",
				Supported: true, Primary: true, Framework: framework,
			},
			ProjectPreviewOption{
				ID: PreviewOptionRemoteRuntime, Label: "Stream over WebRTC",
				Supported: true, Framework: framework,
				Reason: "for when the viewer cannot reach the dev server directly",
			},
		)
		caps.Reason = framework + " renders in a browser — the dev server is the lightest path; " +
			"Hermes does not apply."

	default:
		caps.Options = append(caps.Options, ProjectPreviewOption{
			ID: PreviewOptionDevServer, Label: "Dev server",
			Supported: true, Primary: true, Framework: framework,
		})
		caps.Reason = "unrecognised stack — offering the dev server only, rather than guessing at a runtime."
	}

	return caps
}

func pairedDeviceReason(paired bool) string {
	if paired {
		return ""
	}
	return "no paired device — connect one to use this"
}

func nativeRuntimeReason(framework string) string {
	switch strings.ToLower(framework) {
	case "swift":
		return "Apple UI needs an iOS simulator (macOS host) or a paired iPhone"
	case "kotlin":
		return "native Android needs an emulator/Redroid on the box, streamed over WebRTC"
	default:
		return "native app — needs a device or emulator runtime"
	}
}

// HermesOfferedFor reports whether any Hermes option would be shown. Surfaces
// and tests use this rather than re-deriving the rule.
func HermesOfferedFor(caps ProjectPreviewCapabilities) bool {
	for _, o := range caps.Options {
		if o.ID == PreviewOptionHermes || o.ID == PreviewOptionOpenNative {
			return true
		}
	}
	return false
}

// previewStrategyForOption maps a user-facing option onto the strategy whose
// real dependencies ProbePreviewCapability knows how to attempt.
func previewStrategyForOption(id string) (PreviewStrategy, bool) {
	switch id {
	case PreviewOptionHermes, PreviewOptionOpenNative:
		return PreviewHermesBundle, true
	case PreviewOptionRemoteRuntime:
		return PreviewChromeWebRTC, true
	default:
		// dev-server (browser lane) and wire-push have no separate probe here:
		// the browser lane is the LIGHTEST path and the one we fall back TO, so
		// probing it as a precondition would be the blocking-preflight mistake
		// (an advisory check standing in front of a capability that works).
		return "", false
	}
}

// RefineProjectPreviewCapabilitiesWithProbes turns the STATIC option list into
// one that reflects what this box can actually do.
//
// Why this exists: DetectProjectPreviewCapabilities answers from framework
// rules alone, so it reported `Supported: true` for Hermes and WebRTC on a box
// with no node toolchain and no launchable browser. That is the
// inventory-vs-operation failure this repo keeps re-learning — a tool on PATH
// can be a stub, and "the stack supports it" is not "this machine can do it".
//
// ProbePreviewCapability already ATTEMPTS the underlying operations (it starts
// the browser rather than checking PATH). It simply had no consumer on this
// path. Now it does.
//
// Two invariants, both deliberate:
//
//  1. The BROWSER LANE IS NEVER DEMOTED. It stays first and primary regardless
//     of probe outcomes — it is the lightest path and the fallback everything
//     else degrades to, so putting a probe in front of it would be a blocking
//     preflight ahead of a capability that already works.
//  2. A lane the box cannot run is marked UNSUPPORTED WITH THE PROBE'S REMEDY,
//     never silently dropped. The surface renders it disabled with a reason —
//     hiding it would make the box lie by omission about a lane the stack does
//     support.
//
// Bounded by ctx. On timeout the option keeps its static verdict: an unknown
// answer must not become a false "unavailable".
func RefineProjectPreviewCapabilitiesWithProbes(
	ctx context.Context,
	caps ProjectPreviewCapabilities,
	workDir string,
) ProjectPreviewCapabilities {
	if len(caps.Options) == 0 {
		return caps
	}
	// Probe each distinct strategy once — several options can share one.
	reports := map[PreviewStrategy]PreviewCapabilityReport{}
	for _, o := range caps.Options {
		strategy, ok := previewStrategyForOption(o.ID)
		if !ok || !o.Supported {
			continue
		}
		if _, done := reports[strategy]; done {
			continue
		}
		if ctx.Err() != nil {
			return caps // out of time: keep the static answer, claim nothing
		}
		reports[strategy] = ProbePreviewCapability(ctx, strategy, workDir)
	}

	refined := make([]ProjectPreviewOption, 0, len(caps.Options))
	for _, o := range caps.Options {
		strategy, ok := previewStrategyForOption(o.ID)
		if ok && o.Supported {
			if rep, have := reports[strategy]; have && !rep.CanRun {
				o.Supported = false
				if rep.Remedy != "" {
					o.Reason = rep.Remedy
				} else if o.Reason == "" {
					o.Reason = "this box cannot run that preview right now"
				}
				// A demoted option must never remain primary — that would
				// point the surface's default at a dead end.
				o.Primary = false
			}
		}
		refined = append(refined, o)
	}
	caps.Options = refined
	return ensureBrowserLaneLeads(caps)
}

// ensureBrowserLaneLeads keeps Browser Reload first and primary whenever it is
// offered and runnable.
//
// The lane order IS the default: surfaces take the first supported option as
// what a plain "render it" means. Browser Reload is the lightest path, the only
// one available for Yaver-on-Yaver, and the one every other lane degrades to —
// so if it is present and supported, it leads. Anything else silently changes
// what the default render does.
func ensureBrowserLaneLeads(caps ProjectPreviewCapabilities) ProjectPreviewCapabilities {
	idx := -1
	for i, o := range caps.Options {
		if o.ID == PreviewOptionDevServer && o.Supported {
			idx = i
			break
		}
	}
	if idx == -1 {
		// No runnable browser lane. Promote the first supported option so the
		// surface still has a default rather than leading with a dead one.
		for i := range caps.Options {
			caps.Options[i].Primary = caps.Options[i].Supported && i == firstSupportedIndex(caps.Options)
		}
		return caps
	}
	for i := range caps.Options {
		caps.Options[i].Primary = false
	}
	lead := caps.Options[idx]
	lead.Primary = true
	rest := append([]ProjectPreviewOption{}, caps.Options[:idx]...)
	rest = append(rest, caps.Options[idx+1:]...)
	caps.Options = append([]ProjectPreviewOption{lead}, rest...)
	return caps
}

func firstSupportedIndex(opts []ProjectPreviewOption) int {
	for i, o := range opts {
		if o.Supported {
			return i
		}
	}
	return -1
}
