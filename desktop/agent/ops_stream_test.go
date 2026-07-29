package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestStreamSnapshotSupportsFreshPushedSource(t *testing.T) {
	name := "pushed-test-source"
	jpeg := []byte{0xff, 0xd8, 0xff, 0xd9}
	setPushedFrame(name, base64.StdEncoding.EncodeToString(jpeg), "image/jpeg")
	t.Cleanup(func() {
		pushedMu.Lock()
		delete(pushedFrames, name)
		pushedMu.Unlock()
	})

	res := streamSnapshotHandler(OpsContext{}, json.RawMessage(`{"source":"`+name+`"}`))
	if !res.OK {
		t.Fatalf("stream_snapshot for pushed source failed: code=%q error=%q", res.Code, res.Error)
	}
	initial, ok := res.Initial.(map[string]interface{})
	if !ok {
		t.Fatalf("initial = %#v, want map", res.Initial)
	}
	if initial["source"] != name || initial["pushed"] != true {
		t.Fatalf("unexpected pushed snapshot metadata: %#v", initial)
	}
	image, _ := initial["image"].(string)
	if !strings.HasPrefix(image, "data:image/jpeg;base64,") {
		t.Fatalf("image = %q, want data URL", image)
	}
	if got := strings.TrimPrefix(image, "data:image/jpeg;base64,"); got != base64.StdEncoding.EncodeToString(jpeg) {
		t.Fatalf("snapshot base64 = %q, want pushed frame", got)
	}
}
