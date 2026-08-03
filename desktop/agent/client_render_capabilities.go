package main

// client_render_capabilities.go — WHAT THE CLIENT CAN RENDER, not just what the
// box can serve.
//
// ── The gap this closes (2026-08-03) ───────────────────────────────────────
//
// `/project/preview-capabilities` answered exactly one half of the question:
// what this MACHINE can run. Nothing described the surface asking. So a tvOS app
// that cannot decode WebRTC and a visionOS app that can looked identical to the
// agent, and every surface was offered lanes it might be unable to render.
//
// Measured the same day: tvOS and visionOS ship ZERO WebRTC client code (no
// RTCPeer anywhere under tvos/ or visionos/), while the agent happily advertises
// `native-webrtc`. A TV picking that lane fails at the last possible moment —
// after a task has run — with nothing naming the real cause.
//
// This is the "inventory says yes, the operation says no" rule applied to
// transports: the box's inventory of lanes is not an answer until it is
// intersected with what the client can actually decode.
//
// ── Why the CLIENT declares, rather than the agent guessing ────────────────
//
// Because the agent cannot know. A surface's build can gain or lose a decoder
// between releases, and a User-Agent sniff is the same class of proxy that has
// misled this codebase repeatedly. The client states its modes; the agent
// intersects and — critically — NAMES why each unavailable lane is unavailable,
// so the surface can render a cause instead of a spinner.

import (
	"sort"
	"strings"
)

// RenderMode is a way a preview can reach a user's eyes.
type RenderMode string

const (
	// RenderFrames — the box captures headless and serves stills
	// (/vibing/preview/frames, /droid/frame). The lowest common denominator:
	// anything that can draw an image can render this, including tvOS.
	RenderFrames RenderMode = "frames"
	// RenderIframe — an embedded browser view (web dashboard, RN-web, visionOS
	// WKWebView). NOT available on tvOS: Apple ships no WebKit UI control there.
	RenderIframe RenderMode = "iframe"
	// RenderWebRTC — a live media track from the box (native-webrtc).
	RenderWebRTC RenderMode = "webrtc"
	// RenderHermes — load a Hermes bytecode bundle into the RN container.
	// Phone-only, and refused for Yaver-on-Yaver (self-development recursion).
	RenderHermes RenderMode = "hermes"
)

// ClientRenderCapabilities is what a surface declares it can decode.
type ClientRenderCapabilities struct {
	// Surface is the caller's identity ("web", "mobile", "tvos", "visionos",
	// "watchos", "wear", "car", "glass"). Used only for the explanation text —
	// the decision is made from Modes, never from the name, because a name is a
	// proxy and Modes is the operation.
	Surface string       `json:"surface"`
	Modes   []RenderMode `json:"modes"`
}

// LaneVerdict is one lane, and whether BOTH sides can do it.
type LaneVerdict struct {
	Mode      RenderMode `json:"mode"`
	Usable    bool       `json:"usable"`
	BoxCan    bool       `json:"boxCan"`
	ClientCan bool       `json:"clientCan"`
	// Reason is filled ONLY when Usable is false, and always names which side
	// is missing — "your TV cannot decode this" and "this box cannot serve it"
	// need different actions from the user, and a merged message hides that.
	Reason string `json:"reason,omitempty"`
	Remedy string `json:"remedy,omitempty"`
}

// NegotiateRenderLanes intersects what the box can serve with what the client
// declared, and explains every exclusion.
//
// boxLanes is what this machine can actually do right now (ideally probe-backed,
// so "Chrome cannot launch" removes `frames` here rather than at render time).
func NegotiateRenderLanes(boxLanes map[RenderMode]bool, client ClientRenderCapabilities) []LaneVerdict {
	clientCan := map[RenderMode]bool{}
	for _, m := range client.Modes {
		clientCan[RenderMode(strings.ToLower(strings.TrimSpace(string(m))))] = true
	}
	surface := strings.ToLower(strings.TrimSpace(client.Surface))
	if surface == "" {
		surface = "this client"
	}

	out := make([]LaneVerdict, 0, 4)
	for _, mode := range []RenderMode{RenderFrames, RenderIframe, RenderWebRTC, RenderHermes} {
		v := LaneVerdict{Mode: mode, BoxCan: boxLanes[mode], ClientCan: clientCan[mode]}
		v.Usable = v.BoxCan && v.ClientCan
		switch {
		case v.Usable:
		case !v.ClientCan && !v.BoxCan:
			v.Reason = "neither " + surface + " nor this box supports " + string(mode)
		case !v.ClientCan:
			v.Reason = surface + " cannot render " + string(mode)
			v.Remedy = clientLaneRemedy(surface, mode)
		default:
			v.Reason = "this box cannot serve " + string(mode) + " right now"
			v.Remedy = "Check the box's preview capabilities (probe=true) — the failing dependency is named there."
		}
		out = append(out, v)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Usable && !out[j].Usable })
	return out
}

// clientLaneRemedy says what a user can DO about a lane their surface lacks —
// and, where the answer is "nothing, by design", says that plainly instead of
// implying a fix exists.
func clientLaneRemedy(surface string, mode RenderMode) string {
	switch {
	case mode == RenderIframe && surface == "tvos":
		return "tvOS has no WebKit control at all — use the frames lane, which this app already renders."
	case mode == RenderWebRTC && (surface == "tvos" || surface == "visionos"):
		return "This app ships no WebRTC client yet — use the frames lane. Adding WebRTC is a client change, not a setting."
	case mode == RenderHermes:
		return "Hermes loads into the phone's RN container only; other surfaces use frames or a web lane."
	default:
		return "Pick a lane this surface lists in its capabilities, or update the app."
	}
}

// FirstUsableLane returns the best lane both sides support, or "" with the
// reason nothing works — so a caller never has to guess at an empty list.
func FirstUsableLane(verdicts []LaneVerdict) (RenderMode, string) {
	for _, v := range verdicts {
		if v.Usable {
			return v.Mode, ""
		}
	}
	var why []string
	for _, v := range verdicts {
		if v.Reason != "" {
			why = append(why, string(v.Mode)+": "+v.Reason)
		}
	}
	return "", "no render lane is supported by both sides — " + strings.Join(why, "; ")
}

// ── JOINT SESSIONS: several surfaces watching one box at once ──────────────
//
// A user does not attach one surface at a time. They put the preview on the TV
// and keep the watch on their wrist; they drive from the phone while the
// headset shows the app. So "which lane?" is not a single answer — it is one
// answer per attached surface, plus the question of whether any lane serves
// them ALL.
//
// Getting this wrong is not hypothetical: a watch has no preview surface at
// all, so a session that insisted on one shared pixel lane would either exclude
// the watch or drag the TV down to nothing. The right model is per-surface
// lanes, with a SHARED lane reported separately when one happens to exist.

// SurfaceLanes is one attached surface's answer.
type SurfaceLanes struct {
	Surface string     `json:"surface"`
	Best    RenderMode `json:"best,omitempty"`
	// WhyNone is set when this surface has no usable lane. That is not an
	// error: a watch legitimately has none and should render a non-pixel
	// verdict (task state) rather than a broken preview.
	WhyNone  string        `json:"whyNone,omitempty"`
	Verdicts []LaneVerdict `json:"verdicts"`
}

// JointRenderPlan is the answer for a whole session.
type JointRenderPlan struct {
	Surfaces []SurfaceLanes `json:"surfaces"`
	// Shared is a lane EVERY pixel-capable surface can render, when one exists.
	Shared RenderMode `json:"shared,omitempty"`
	// WhyNoShared explains an absence instead of leaving an empty field to be
	// misread as "not computed".
	WhyNoShared string `json:"whyNoShared,omitempty"`
	// NonPixel names the surfaces that must fall back to a status-only verdict,
	// so a caller never reads their silence as failure.
	NonPixel []string `json:"nonPixelSurfaces,omitempty"`
}

// NegotiateJointRender answers for every attached surface at once.
func NegotiateJointRender(boxLanes map[RenderMode]bool, clients []ClientRenderCapabilities) JointRenderPlan {
	plan := JointRenderPlan{}
	shared := map[RenderMode]int{}
	// Surfaces that CAN render something but got nothing here. They must block a
	// "shared" claim; only capability-less surfaces are excused.
	excludedButCapable := 0

	for _, c := range clients {
		verdicts := NegotiateRenderLanes(boxLanes, c)
		best, why := FirstUsableLane(verdicts)
		name := strings.ToLower(strings.TrimSpace(c.Surface))
		if name == "" {
			name = "unknown"
		}
		plan.Surfaces = append(plan.Surfaces, SurfaceLanes{
			Surface: name, Best: best, WhyNone: why, Verdicts: verdicts,
		})
		if best == "" {
			// NON-PIXEL means "this surface has no preview capability AT ALL"
			// (a watch), NOT "this surface could not take the lanes on offer"
			// (a TV against a WebRTC-only box). Conflating them let a lane the
			// TV cannot decode be reported as SHARED — caught by
			// TestMixedSessionFallsBackToPerSurfaceLanes, which is exactly the
			// false green this whole negotiation exists to prevent.
			if len(c.Modes) == 0 {
				plan.NonPixel = append(plan.NonPixel, name)
			} else {
				excludedButCapable++
			}
			continue
		}
		for _, v := range verdicts {
			if v.Usable {
				shared[v.Mode]++
			}
		}
	}

	// A lane counts as shared only if EVERY pixel-capable surface can take it.
	// Surfaces with no lane at all are excluded from the tally rather than
	// blocking it — otherwise one watch in the session would mean "no shared
	// lane" forever, which is exactly the joint-usage case this exists for.
	pixelSurfaces := len(clients) - len(plan.NonPixel)
	if pixelSurfaces > 0 && excludedButCapable == 0 {
		for _, mode := range []RenderMode{RenderFrames, RenderIframe, RenderWebRTC, RenderHermes} {
			if shared[mode] == pixelSurfaces {
				plan.Shared = mode
				break
			}
		}
	}
	if plan.Shared == "" {
		if pixelSurfaces == 0 {
			plan.WhyNoShared = "no attached surface can render a preview — report task state instead"
		} else if excludedButCapable > 0 {
			plan.WhyNoShared = "at least one attached surface can render, but not any lane this box offers; serve each its own"
		} else {
			plan.WhyNoShared = "the attached surfaces support no lane in common; serve each its own"
		}
	}
	return plan
}
