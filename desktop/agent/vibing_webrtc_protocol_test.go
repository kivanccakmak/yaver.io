package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestVibingWebRTCControlProtocol_IsVersionedIdempotentAndReliable(t *testing.T) {
	mgr := NewRemoteRuntimeManager()
	calls := 0
	mgr.SetVibingWebRTCControlHandler(func(_ context.Context, req vibingWebRTCControlRequest) (any, *vibingWebRTCControlError) {
		calls++
		if req.Type != vibingControlDOMSelect || req.Project != "todo" || req.X != 42 || req.Y != 17 {
			t.Fatalf("unexpected request: %+v", req)
		}
		return map[string]any{"summary": "button.save"}, nil
	})
	live := &remoteRuntimeLiveState{}
	raw := []byte(`{"v":1,"id":"select-1","type":"vibing.dom.select","project":"todo","workDir":"/workspace/todo","x":42,"y":17}`)

	ack, cacheable := mgr.applyVibingWebRTCControl("session-1", live, raw)
	if !cacheable || !ack.OK || ack.ID != "select-1" {
		t.Fatalf("first ack = %+v cacheable=%v", ack, cacheable)
	}
	payload, _ := json.Marshal(ack)
	live.cacheVibingControlAck(ack.ID, sha256.Sum256(raw), string(payload))

	replayed, cacheable := mgr.applyVibingWebRTCControl("session-1", live, raw)
	if cacheable || !replayed.OK || calls != 1 {
		t.Fatalf("duplicate re-executed: ack=%+v cacheable=%v calls=%d", replayed, cacheable, calls)
	}
}

func TestVibingWebRTCControlProtocol_RejectsVersionTypeAndIDReuse(t *testing.T) {
	mgr := NewRemoteRuntimeManager()
	mgr.SetVibingWebRTCControlHandler(func(context.Context, vibingWebRTCControlRequest) (any, *vibingWebRTCControlError) {
		return map[string]any{"ok": true}, nil
	})
	live := &remoteRuntimeLiveState{}

	badVersion := []byte(`{"v":2,"id":"v2","type":"vibing.dom.mode","project":"todo","enabled":true}`)
	ack, _ := mgr.applyVibingWebRTCControl("session-1", live, badVersion)
	if ack.OK || ack.Error == nil || ack.Error.Code != "vibing.control.unsupported_version" {
		t.Fatalf("bad version ack = %+v", ack)
	}

	oversizedCoordinate := []byte(`{"v":1,"id":"huge","type":"vibing.dom.select","project":"todo","x":65536,"y":1}`)
	ack, _ = mgr.applyVibingWebRTCControl("session-1", live, oversizedCoordinate)
	if ack.OK || ack.Error == nil || ack.Error.Code != "vibing.control.invalid_argument" {
		t.Fatalf("oversized coordinate ack = %+v", ack)
	}

	first := []byte(`{"v":1,"id":"same","type":"vibing.dom.cursor","project":"todo","x":1,"y":2}`)
	firstAck, _ := mgr.applyVibingWebRTCControl("session-1", live, first)
	encoded, _ := json.Marshal(firstAck)
	live.cacheVibingControlAck("same", sha256.Sum256(first), string(encoded))
	conflict := []byte(`{"v":1,"id":"same","type":"vibing.dom.cursor","project":"todo","x":9,"y":9}`)
	conflictAck, cacheable := mgr.applyVibingWebRTCControl("session-1", live, conflict)
	if conflictAck.OK || conflictAck.Error == nil || conflictAck.Error.Code != "vibing.control.id_conflict" || cacheable {
		t.Fatalf("id conflict ack = %+v cacheable=%v", conflictAck, cacheable)
	}
}

func TestVibingWebRTCControlProtocol_TravelsBidirectionallyOnEventsDataChannel(t *testing.T) {
	mgr, sessionID := newPrimedManager(t, "ios-simulator")
	calls := 0
	mgr.SetVibingWebRTCControlHandler(func(_ context.Context, req vibingWebRTCControlRequest) (any, *vibingWebRTCControlError) {
		calls++
		return map[string]any{"x": req.X, "y": req.Y}, nil
	})

	clientPC, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer clientPC.Close()
	if _, err := clientPC.CreateDataChannel("primer", nil); err != nil {
		t.Fatal(err)
	}
	eventsOpen := make(chan *webrtc.DataChannel, 1)
	messages := make(chan string, 8)
	clientPC.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "events" {
			return
		}
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			if msg.IsString {
				messages <- string(msg.Data)
			}
		})
		dc.OnOpen(func() { eventsOpen <- dc })
	})

	offer, err := clientPC.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather := webrtc.GatheringCompletePromise(clientPC)
	if err := clientPC.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gather
	_, answer, err := mgr.ApplyWebRTCOffer(sessionID, *clientPC.LocalDescription())
	if err != nil {
		t.Fatal(err)
	}
	if err := clientPC.SetRemoteDescription(answer); err != nil {
		t.Fatal(err)
	}

	var events *webrtc.DataChannel
	select {
	case events = <-eventsOpen:
	case <-time.After(8 * time.Second):
		t.Fatal("events DataChannel did not open")
	}

	waitMessage := func(want string) string {
		t.Helper()
		deadline := time.After(8 * time.Second)
		for {
			select {
			case message := <-messages:
				if strings.Contains(message, want) {
					return message
				}
			case <-deadline:
				t.Fatalf("timed out waiting for %s", want)
			}
		}
	}
	hello := waitMessage(`"type":"vibing.protocol"`)
	if !strings.Contains(hello, `"vibing.dom.select"`) || !strings.Contains(hello, `"POST /vibing/preview/select"`) {
		t.Fatalf("hello lacks DOM selection capability/fallback: %s", hello)
	}

	request := `{"v":1,"id":"wire-select-1","type":"vibing.dom.select","project":"todo","workDir":"/workspace/todo","x":42,"y":17}`
	if err := events.SendText(request); err != nil {
		t.Fatal(err)
	}
	first := waitMessage(`"id":"wire-select-1"`)
	if !strings.Contains(first, `"ok":true`) {
		t.Fatalf("first ack failed: %s", first)
	}
	if err := events.SendText(request); err != nil {
		t.Fatal(err)
	}
	second := waitMessage(`"id":"wire-select-1"`)
	if !strings.Contains(second, `"ok":true`) || calls != 1 {
		t.Fatalf("idempotent replay failed: ack=%s calls=%d", second, calls)
	}
}
