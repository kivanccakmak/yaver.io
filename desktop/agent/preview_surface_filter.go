package main

import "strings"

// preview_surface_filter.go — an option the PROJECT supports may still be
// impossible on the SURFACE asking.
//
// ─── The gap ───────────────────────────────────────────────────────────────
//
// DetectProjectPreviewCapabilities answers per PROJECT: it detects the
// framework from disk and returns what that stack can do. That was the right
// fix for the original bug (every surface reimplementing framework
// conditionals in its own UI, and drifting). It models one axis.
//
// There is a second axis it does not model. For an Expo project the
// project-level answer includes `compile-hermes` and `open-native` — correct
// for the phone, and impossible on visionOS, whose app is SwiftUI with no
// React Native runtime to load a Hermes bundle into. Likewise `wire-push`
// assumes a USB cable to a device; there is no cable path to a headset, a TV or
// a watch.
//
// So visionOS could be handed a button that cannot do anything on visionOS —
// exactly the class the capability layer was created to remove, on an axis it
// did not cover.
//
// ─── Why this lives in the agent, not the surface ──────────────────────────
//
// Because "a UI-only rule is not a rule" (project_preview_capabilities.go's own
// words). If visionOS filtered client-side, the endpoint would still serve
// Hermes to any caller that did not — and the next surface would have to
// reimplement the filter, which is the drift this whole file family exists to
// stop.
//
// ─── The rule, and its direction ───────────────────────────────────────────
//
// A surface filter may only ever REMOVE options, never add or enable one. The
// project layer decides what is possible for the stack; this decides what is
// possible on the screen. Anything a filter does not explicitly know about
// passes through — an unrecognised surface must not silently lose capabilities,
// because a new surface that gets a shorter list looks like a product with less
// in it rather than a table with a missing row.

// PreviewSurface identifies the client asking. Values match the shared surface
// table in web/lib/surfaceViewports.ts so a reader can hold one vocabulary.
type PreviewSurface string

const (
	PreviewSurfaceMobile PreviewSurface = "mobile"
	PreviewSurfaceTablet PreviewSurface = "tablet"
	PreviewSurfaceWeb    PreviewSurface = "web"
	PreviewSurfaceTV     PreviewSurface = "tv"
	PreviewSurfaceVision PreviewSurface = "vision"
	PreviewSurfaceWatch  PreviewSurface = "watch"
)

// surfaceCannotHost lists option IDs a surface can never perform, with the
// reason a user would need to hear if they asked why.
//
// Deliberately keyed on what the SURFACE can host, not on what looks tidy:
//
//   - Hermes (`compile-hermes`, `open-native`) needs a React Native container.
//     Only the RN surfaces have one. tvOS, visionOS, watchOS and the web
//     dashboard are not RN apps — there is nothing to load bytecode into.
//   - `wire-push` builds and installs over a USB cable. There is no cable
//     install path to a headset, a TV or a watch.
//
// Absent from the map = nothing removed.
var surfaceCannotHost = map[PreviewSurface]map[string]string{
	PreviewSurfaceVision: {
		PreviewOptionHermes:     "visionOS runs a SwiftUI app, not a React Native container — there is nothing here to load a Hermes bundle into. Stream the preview instead.",
		PreviewOptionOpenNative: "visionOS runs a SwiftUI app, not a React Native container — there is nothing here to load a Hermes bundle into. Stream the preview instead.",
		PreviewOptionWirePush:   "there is no USB install path to a headset. Stream the preview from the box instead.",
	},
	PreviewSurfaceTV: {
		PreviewOptionHermes:     "tvOS runs a SwiftUI app, not a React Native container — a Hermes bundle has nothing to load into. Stream the preview instead.",
		PreviewOptionOpenNative: "tvOS runs a SwiftUI app, not a React Native container — a Hermes bundle has nothing to load into. Stream the preview instead.",
		PreviewOptionWirePush:   "there is no USB install path to a TV. Stream the preview from the box instead.",
	},
	PreviewSurfaceWatch: {
		PreviewOptionHermes:     "watchOS runs a SwiftUI app, not a React Native container — a Hermes bundle has nothing to load into.",
		PreviewOptionOpenNative: "watchOS runs a SwiftUI app, not a React Native container — a Hermes bundle has nothing to load into.",
		PreviewOptionWirePush:   "there is no USB install path to a watch.",
	},
	PreviewSurfaceWeb: {
		PreviewOptionHermes:     "the web dashboard is a browser, not a React Native container — it cannot host a Hermes bundle. Use the browser preview.",
		PreviewOptionOpenNative: "the web dashboard is a browser, not a React Native container — it cannot host a Hermes bundle. Use the browser preview.",
		PreviewOptionWirePush:   "a browser has no USB install path to a device.",
	},
}

// ParsePreviewSurface normalises a caller-supplied surface name.
//
// Returns "" for anything unknown, and callers treat "" as "filter nothing" —
// see the direction rule above. An unrecognised surface losing options would be
// a silent capability regression for whatever ships next.
func ParsePreviewSurface(s string) PreviewSurface {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "mobile", "phone", "ios", "android":
		return PreviewSurfaceMobile
	case "tablet", "ipad":
		return PreviewSurfaceTablet
	case "web", "dashboard", "browser":
		return PreviewSurfaceWeb
	case "tv", "tvos", "appletv":
		return PreviewSurfaceTV
	case "vision", "visionos", "xros", "glass", "arvr":
		return PreviewSurfaceVision
	case "watch", "watchos", "wear", "wearos":
		return PreviewSurfaceWatch
	default:
		return ""
	}
}

// FilterPreviewCapabilitiesForSurface removes options the surface cannot host.
//
// Options are DROPPED rather than returned unsupported-with-a-reason. That
// matches the existing rule in project_preview_capabilities.go: options that
// make no sense at all are omitted entirely, because there is no useful "why"
// for something that was never applicable — and a disabled button still
// advertises a capability the app does not have.
//
// The reasons above are not dead text: they are what a surface should say if a
// user asks why an option they saw on their phone is missing here, and they are
// carried on the capabilities Reason when everything for a stack is removed.
func FilterPreviewCapabilitiesForSurface(caps ProjectPreviewCapabilities, surface PreviewSurface) ProjectPreviewCapabilities {
	drop := surfaceCannotHost[surface]
	if len(drop) == 0 || len(caps.Options) == 0 {
		return caps
	}

	kept := make([]ProjectPreviewOption, 0, len(caps.Options))
	var removed []string
	for _, o := range caps.Options {
		if why, cannot := drop[o.ID]; cannot {
			removed = append(removed, why)
			continue
		}
		kept = append(kept, o)
	}
	caps.Options = kept

	// If the surface can host NOTHING, say so rather than returning an empty
	// list. An empty options array renders as a blank sheet, which reads as a
	// broken screen instead of an honest answer.
	if len(kept) == 0 && len(removed) > 0 {
		caps.Reason = strings.TrimSpace(caps.Reason + " " + removed[0])
	}
	return caps
}
