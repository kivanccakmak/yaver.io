package main

import "testing"

// Capability negotiation, not version guessing: every status verdict carries
// the promise that this binary injects yaver-rendered into preview HTML. Older
// agents omit the field, which lets RN-web expose (but not falsely certify) a
// cross-origin frame instead of waiting forever on an impossible message.
func TestPreviewHealthAdvertisesInFramePaintSignal(t *testing.T) {
	for _, status := range []DevServerStatus{
		{Running: true},
		{Building: true},
		{Error: "expo exited before becoming ready"},
		{CapabilityGap: &CapabilityGap{Code: "test", Capability: "node", Summary: "missing"}},
	} {
		health := previewHealthFromAgentSignals(status, nil)
		if health == nil || health.PaintSignal != "in_frame_v1" {
			t.Fatalf("status %+v advertised paint signal %+v, want in_frame_v1", status, health)
		}
	}
}
