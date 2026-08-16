package main

// device_identity_conflict_wire_test.go — the conflict must reach a WIRE.
//
// ReasonDeviceIdentityConflict existed for a box whose (deviceId, hardwareId,
// publicKey) triple is claimed by other hardware. Convex refuses such a box
// BEFORE it can set needsAuth, so it has no way to announce itself through the
// control plane — and the code only ever reached a log.Printf. The 2026-08-04
// audit first counted it as "emitted with no consumer"; measuring properly showed
// something worse: it was on NO WIRE AT ALL, so no client could have consumed it
// even in principle, and writing one first would have been wasted work.
//
// /info is the honest channel precisely because Convex is the thing refusing the
// box: a phone on the LAN, the dashboard over the relay and `yaver status` can all
// still read it.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIdentityConflictReachesInfo(t *testing.T) {
	// The state is process-wide; leave it as we found it for other tests.
	t.Cleanup(func() {
		identityConflictMu.Lock()
		identityConflictValue = deviceIdentityConflictState{}
		identityConflictMu.Unlock()
	})

	tm := NewTaskManager(t.TempDir(), nil, defaultRunner)
	hs := NewHTTPServer(0, "test-token", "test-user", "test-device", "", "test-host", tm)
	mux := http.NewServeMux()
	mux.HandleFunc("/info", hs.auth(hs.handleInfo))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	get := func() map[string]interface{} {
		t.Helper()
		req, _ := http.NewRequest("GET", srv.URL+"/info", nil)
		req.Header.Set("Authorization", "Bearer test-token")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET /info: %v", err)
		}
		defer res.Body.Close()
		var body map[string]interface{}
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
			t.Fatalf("decode /info: %v", err)
		}
		return body
	}

	// ABSENT when healthy. A field that is always present teaches every surface
	// to ignore it, which is how a signal becomes noise.
	if v, present := get()["identityConflict"]; present && v != nil {
		t.Errorf("identityConflict must be absent/null with no conflict, got %v", v)
	}

	markDeviceIdentityConflict("hardware-mismatch", "2ed7da41-bd6c", "run `yaver auth` on this box after clearing the copied config")

	raw, present := get()["identityConflict"]
	if !present || raw == nil {
		t.Fatal("after a conflict /info must carry it — otherwise the box can only appear unreachable and the user is sent to check a healthy network")
	}
	conflict, ok := raw.(map[string]interface{})
	if !ok {
		t.Fatalf("identityConflict is %T, want an object", raw)
	}
	if conflict["code"] != ReasonDeviceIdentityConflict {
		t.Errorf("code = %v, want %q so surfaces classify instead of regexing prose", conflict["code"], ReasonDeviceIdentityConflict)
	}
	// The KIND must be a name, not a rune. `string(kind)` on the int enum yields
	// "\x01"; go vet caught that being introduced, and this pins it.
	kind, _ := conflict["kind"].(string)
	if kind != "hardware-mismatch" {
		t.Errorf("kind = %q, want a readable name — an int enum converted with string() publishes a control character", kind)
	}
	// A remedy that does not name the specific fix costs whole sessions.
	remedy, _ := conflict["remedy"].(string)
	if strings.TrimSpace(remedy) == "" {
		t.Error("remedy must be carried: the box cannot self-heal this, so the sentence IS the route")
	}
}

func TestIdentityConflictKindNamesAreNotRunes(t *testing.T) {
	for _, k := range []deviceIdentityConflictKind{identityConflictHardware, identityConflictPublicKey} {
		got := k.String()
		if len(got) < 2 {
			t.Errorf("kind %d stringifies to %q — that is the string(int) rune bug", int(k), got)
		}
	}
	if identityConflictNone.String() != "" {
		t.Error("the none kind must stringify to empty so it is never published as a conflict")
	}
}
