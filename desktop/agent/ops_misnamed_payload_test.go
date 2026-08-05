package main

// ops_misnamed_payload_test.go — a request whose arguments are under the wrong
// key must be told THAT, not told its arguments are missing.
//
// THE INCIDENT (2026-08-05, measured against the real box). The watchOS arc sent
//
//	{"verb":"desktop_voice","args":{"transcript":"what is the status of this project"}}
//
// and the agent answered ok:false / bad_payload / "`transcript` is required".
// Every word of that is true about the decoded payload and false about the
// request: a transcript had been supplied, under `args` instead of `payload`.
// encoding/json drops unknown keys silently, so the one fact that would have
// ended the confusion — "I saw `args` and ignored it" — was known to the agent
// and thrown away.
//
// This is the SIGNAL layer of the four-layer rule. The detection already
// happened; what was missing was carrying it to the caller. The cost of not
// carrying it is measured in round trips by whoever writes the next client, and
// this repo has now paid it once.
//
// The guard is deliberately narrow, and both halves are pinned below: it speaks
// only when `payload` is ABSENT and unknown keys are PRESENT, because that is
// the only combination that is unambiguously the wrapper mistake.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOpsNamesTheKeysItIgnored(t *testing.T) {
	req := OpsRequest{Verb: "desktop_voice"}
	raw := []byte(`{"verb":"desktop_voice","args":{"transcript":"open safari"}}`)

	bad := opsRejectMisnamedPayload(req, raw)
	if bad == nil {
		t.Fatal("a request with no `payload` but an `args` key was accepted — the verb will report the field the caller DID send as missing, which is the bug this guard exists for")
	}
	if bad.OK {
		t.Error("ok must be false on a refusal")
	}
	if bad.Code != "bad_payload" {
		t.Errorf("code = %q, want bad_payload so surfaces classify instead of matching prose", bad.Code)
	}
	// The remedy must NAME the offending key. "check your request" would leave
	// the caller exactly where they started.
	if !strings.Contains(bad.Error, "args") {
		t.Errorf("error does not name the ignored key `args`, so it does not route to the fix: %q", bad.Error)
	}
	if !strings.Contains(bad.Error, "payload") {
		t.Errorf("error does not name the expected key `payload`: %q", bad.Error)
	}
	// And it must be machine-readable, not only human-readable — a surface
	// rendering a fix button needs the key list, not a sentence to regex.
	init, ok := bad.Initial.(map[string]interface{})
	if !ok {
		t.Fatalf("Initial is not a map, so no client can branch on it: %T", bad.Initial)
	}
	keys, ok := init["ignoredKeys"].([]string)
	if !ok || len(keys) != 1 || keys[0] != "args" {
		t.Errorf("ignoredKeys = %v, want [args]", init["ignoredKeys"])
	}
}

// TestOpsAcceptsAValidPayloadWithStrayKeys — the guard must not become a new
// way to fail. A NEWER client may send fields this build predates; as long as
// `payload` is there, the request is well-formed and must pass through.
func TestOpsAcceptsAValidPayloadWithStrayKeys(t *testing.T) {
	req := OpsRequest{Verb: "desktop_voice", Payload: json.RawMessage(`{"transcript":"hi"}`)}
	raw := []byte(`{"verb":"desktop_voice","payload":{"transcript":"hi"},"traceId":"abc"}`)
	if bad := opsRejectMisnamedPayload(req, raw); bad != nil {
		t.Fatalf("rejected a request that HAS a payload — a forward-compatible client would break: %v", bad.Error)
	}
}

// TestOpsAcceptsNoArgumentCalls — many verbs take nothing at all. Neither a
// payload nor unknown keys is a legitimate call, not a wrapper mistake.
func TestOpsAcceptsNoArgumentCalls(t *testing.T) {
	req := OpsRequest{Verb: "status"}
	raw := []byte(`{"verb":"status"}`)
	if bad := opsRejectMisnamedPayload(req, raw); bad != nil {
		t.Fatalf("rejected a no-argument call: %v", bad.Error)
	}
	// `machine` is a known key and must not count as stray.
	if bad := opsRejectMisnamedPayload(req, []byte(`{"verb":"status","machine":"primary"}`)); bad != nil {
		t.Fatalf("`machine` was treated as unknown: %v", bad.Error)
	}
}

// TestOpsMisnamedPayloadIsWiredIntoTheHandler — the classifier existing is not
// the same as the route using it. A pure function nothing calls is precisely the
// "signal with no consumer" this codebase keeps finding, so drive real HTTP.
func TestOpsMisnamedPayloadIsWiredIntoTheHandler(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // never touch the developer's real ~/.yaver

	hs := NewHTTPServer(0, "test-token", "test-user", "test-device", "", "test-host", nil)
	rec := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/ops",
		strings.NewReader(`{"verb":"desktop_voice","args":{"transcript":"open safari"}}`))
	r.Header.Set("Content-Type", "application/json")
	hs.handleOps(rec, r)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; /ops reports typed errors as 200 with ok:false", rec.Code)
	}
	var body map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["ok"] != false {
		t.Fatalf("ok = %v, want false", body["ok"])
	}
	if !strings.Contains(body["error"].(string), "args") {
		t.Errorf("the handler did not name the ignored key — the classifier is not wired in: %v", body["error"])
	}
}
