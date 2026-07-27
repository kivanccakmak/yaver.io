package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProxy_DeviceNotConnectedCarriesStableCode(t *testing.T) {
	srv := NewRelayServer(0, 0, "pw", "", "")
	req := httptest.NewRequest(http.MethodGet, "/d/device-offline/remote-runtime/capabilities", nil)
	req.Header.Set("X-Relay-Password", "pw")
	rr := httptest.NewRecorder()

	srv.handleProxy(rr, req)

	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 body=%s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["ok"] != false {
		t.Fatalf("ok = %v, want false", body["ok"])
	}
	if body["error"] != "device not connected to relay" {
		t.Fatalf("error = %v", body["error"])
	}
	if body["code"] != "relay.device_not_connected" {
		t.Fatalf("code = %v", body["code"])
	}
	if body["reasonCode"] != "connectivity.relay.device_not_connected" {
		t.Fatalf("reasonCode = %v", body["reasonCode"])
	}
}
