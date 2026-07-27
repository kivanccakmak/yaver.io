package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// devserver_gap_event_test.go — the gap has to arrive on a channel a client
// already reads.
//
// Rule 11 of the failure-plumbing contract, learned the hard way from
// recoverKind and capture_error: both are correct, well-designed producers
// that nothing consumes. `/dev/build-native`'s refusal body was heading the
// same way — the object is right, but every client's transport lifts
// `capabilityGap` only off the /dev/start 412 (mobile/src/lib/quic.ts,
// web/lib/agent-client.ts), so a gap in a build-native body renders on zero
// surfaces.
//
// /dev/events is the channel all four preview renderers ALREADY subscribe to,
// and all four already call capabilityGapFromDevEvent on every frame. Emitting
// there lands the route on every surface with no client change.

// The frame must serialise into exactly what capabilityGapFromDevEvent reads:
// `{type:"error", gap:{…}}`.
func TestCapabilityGapEventSerialisesAsTheClientsParseIt(t *testing.T) {
	mgr := &DevServerManager{}
	var got DevServerEvent
	// Subscribe through the manager's own fan-out so this exercises the real
	// emit path rather than a hand-built struct. Fresh, so no history replay
	// can supply the frame this test is asserting was published.
	ch := mgr.SubscribeFresh()
	defer mgr.Unsubscribe(ch)

	gap := DetectCapabilityGap(CapabilityGapContext{MissingTools: []string{"bun"}})
	if gap == nil || gap.Fix == nil {
		t.Fatal("fixture: bun must resolve to a real fix")
	}
	mgr.EmitCapabilityGap("react-native", "missing required tools on this machine: bun", gap)

	select {
	case ev := <-ch:
		got = ev
	default:
		t.Fatal("EmitCapabilityGap published nothing — the build lane's gap reaches no surface")
	}

	if got.Type != "error" {
		t.Errorf("Type = %q, want error — capabilityGapFromDevEvent is only consulted on error frames", got.Type)
	}
	if got.Gap == nil {
		t.Fatal("frame has no Gap")
	}
	blob, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var wire map[string]any
	if err := json.Unmarshal(blob, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// The exact key capabilityGapFromDevEvent reads.
	g, _ := wire["gap"].(map[string]any)
	if g == nil {
		t.Fatal(`the SSE frame has no "gap" key — capabilityGapFromDevEvent returns null and the card never renders`)
	}
	fix, _ := g["fix"].(map[string]any)
	if fix == nil || fix["path"] != "/install/bun" || fix["stream"] != "install:bun" {
		t.Errorf("wire fix = %v, want POST /install/bun streaming install:bun", g["fix"])
	}
	// The human sentence must survive too — the card renders summary, not the
	// raw message.
	if s, _ := g["summary"].(string); !strings.Contains(s, "isn't installed on this machine") {
		t.Errorf("summary = %q", s)
	}
}

// A nil gap must not manufacture an error frame. Compile failures, port
// clashes and missing assets all reach this code path with gap == nil, and an
// empty error frame would clear a preview that is merely slow.
func TestEmitCapabilityGapIsSilentWithoutAGap(t *testing.T) {
	mgr := &DevServerManager{}
	ch := mgr.SubscribeFresh()
	defer mgr.Unsubscribe(ch)
	mgr.EmitCapabilityGap("flutter", "the app failed to compile", nil)
	select {
	case ev := <-ch:
		t.Fatalf("emitted %+v for a nil gap — an error frame with no route is the spinner with extra steps", ev)
	default:
	}
}

// THE WIRING GUARD. Both build-native refusals must publish to /dev/events, or
// the producer is back to being a body nobody parses.
func TestBuildNativeRefusalsPublishToDevEvents(t *testing.T) {
	src, err := os.ReadFile("devserver_http.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if n := strings.Count(string(src), "s.devServerMgr.EmitCapabilityGap("); n < 2 {
		t.Errorf("EmitCapabilityGap called %d times in devserver_http.go, want 2 (missing tools + deps-cannot-auto-install) — a refusal went back to a body no client decorates", n)
	}
}
