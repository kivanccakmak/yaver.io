package main

import "testing"

// The lane table each surface actually declares today. Measured, not assumed:
// tvOS has no WebKit control and no WebRTC client; visionOS shares the tvOS
// client so it has no WebRTC either, but DOES have WKWebView; watch/Wear have
// no preview surface at all.
var (
	tvOS     = ClientRenderCapabilities{Surface: "tvos", Modes: []RenderMode{RenderFrames}}
	visionOS = ClientRenderCapabilities{Surface: "visionos", Modes: []RenderMode{RenderFrames, RenderIframe}}
	phone    = ClientRenderCapabilities{Surface: "mobile", Modes: []RenderMode{RenderFrames, RenderIframe, RenderHermes, RenderWebRTC}}
	watch    = ClientRenderCapabilities{Surface: "watchos", Modes: nil}
	web      = ClientRenderCapabilities{Surface: "web", Modes: []RenderMode{RenderFrames, RenderIframe, RenderWebRTC}}
)

func boxAll() map[RenderMode]bool {
	return map[RenderMode]bool{RenderFrames: true, RenderIframe: true, RenderWebRTC: true, RenderHermes: true}
}

func TestTVIsNeverOfferedALaneItCannotDecode(t *testing.T) {
	v := NegotiateRenderLanes(boxAll(), tvOS)
	best, why := FirstUsableLane(v)
	if best != RenderFrames {
		t.Fatalf("tvOS should land on frames, got %q (%s)", best, why)
	}
	for _, lane := range v {
		if lane.Mode == RenderWebRTC || lane.Mode == RenderIframe {
			if lane.Usable {
				t.Fatalf("tvOS was offered %s, which it cannot render", lane.Mode)
			}
			if lane.Reason == "" || lane.Remedy == "" {
				// A refusal with no cause is the spinner problem in JSON form.
				t.Fatalf("%s refusal must name a cause AND a remedy: %+v", lane.Mode, lane)
			}
		}
	}
}

func TestBoxSideFailureIsBlamedOnTheBoxNotTheClient(t *testing.T) {
	// Chrome cannot launch → the box cannot serve frames. The TV is fine.
	box := map[RenderMode]bool{RenderFrames: false, RenderIframe: true, RenderWebRTC: true}
	v := NegotiateRenderLanes(box, tvOS)
	for _, lane := range v {
		if lane.Mode != RenderFrames {
			continue
		}
		if lane.ClientCan != true || lane.BoxCan != false {
			t.Fatalf("frames verdict misattributed: %+v", lane)
		}
		if want := "this box cannot serve"; lane.Reason[:len(want)] != want {
			t.Fatalf("blame landed on the client for a box-side failure: %q", lane.Reason)
		}
	}
	if _, why := FirstUsableLane(v); why == "" {
		t.Fatal("a TV with no usable lane must explain itself, not return empty")
	}
}

// THE JOINT CASE the user actually lives in: preview on the TV, watch on the
// wrist. The watch has no preview surface — that must not drag the TV down to
// nothing, and it must be NAMED rather than silently dropped.
func TestTVPlusWatchKeepsTheTVsLaneAndNamesTheWatch(t *testing.T) {
	plan := NegotiateJointRender(boxAll(), []ClientRenderCapabilities{tvOS, watch})
	if plan.Shared != RenderFrames {
		t.Fatalf("TV+watch should still share frames (the watch is excluded, not blocking): %+v", plan)
	}
	if len(plan.NonPixel) != 1 || plan.NonPixel[0] != "watchos" {
		t.Fatalf("the watch must be named as non-pixel, got %v", plan.NonPixel)
	}
	for _, s := range plan.Surfaces {
		if s.Surface == "watchos" && s.WhyNone == "" {
			t.Fatal("a surface with no lane must say why — silence reads as failure")
		}
		if s.Surface == "tvos" && s.Best != RenderFrames {
			t.Fatalf("the TV lost its lane because a watch joined: %+v", s)
		}
	}
}

func TestMixedSessionFallsBackToPerSurfaceLanes(t *testing.T) {
	// A box that can only do WebRTC: the phone and web can take it, the TV cannot.
	box := map[RenderMode]bool{RenderWebRTC: true}
	plan := NegotiateJointRender(box, []ClientRenderCapabilities{tvOS, phone, web})
	if plan.Shared != "" {
		t.Fatalf("there is no lane all three can take; Shared must be empty, got %q", plan.Shared)
	}
	if plan.WhyNoShared == "" {
		t.Fatal("an empty Shared must be explained, or it reads as 'not computed'")
	}
	var tv, ph SurfaceLanes
	for _, s := range plan.Surfaces {
		switch s.Surface {
		case "tvos":
			tv = s
		case "mobile":
			ph = s
		}
	}
	if ph.Best != RenderWebRTC {
		t.Fatalf("the phone can take webrtc and should be given it: %+v", ph)
	}
	if tv.Best != "" || tv.WhyNone == "" {
		t.Fatalf("the TV has no lane here and must say so: %+v", tv)
	}
}

func TestVisionOSGetsTheWebLaneTheTVCannot(t *testing.T) {
	plan := NegotiateJointRender(boxAll(), []ClientRenderCapabilities{visionOS, tvOS})
	if plan.Shared != RenderFrames {
		t.Fatalf("headset+TV share frames, got %q", plan.Shared)
	}
	for _, s := range plan.Surfaces {
		if s.Surface != "visionos" {
			continue
		}
		var sawIframe bool
		for _, v := range s.Verdicts {
			if v.Mode == RenderIframe && v.Usable {
				sawIframe = true
			}
		}
		if !sawIframe {
			t.Fatal("visionOS has WKWebView and must be offered the iframe lane")
		}
	}
}
