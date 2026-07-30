package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAgentIdentityRepairOpsVerbAdoptsCanonicalID(t *testing.T) {
	withTempHome(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/devices/heartbeat" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":                   true,
			"pendingRescue":        false,
			"pendingPublish":       false,
			"canonicalDeviceId":    "canonical-device",
			"repairedDeviceIdFrom": "stale-device",
		})
	}))
	defer srv.Close()

	if err := SaveConfig(&Config{
		ConvexSiteURL: srv.URL,
		AuthToken:     "tok",
		DeviceID:      "stale-device",
	}); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	out := agentIdentityRepairHandler(OpsContext{}, json.RawMessage(`{"restart":false}`))
	if !out.OK || out.Code != "identity_repaired" {
		t.Fatalf("repair result = %+v", out)
	}
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.DeviceID != "canonical-device" {
		t.Fatalf("device id = %q", cfg.DeviceID)
	}
}

func TestAgentIdentityRepairOpsVerbSurfacesAmbiguousIdentity(t *testing.T) {
	withTempHome(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"IDENTITY_DRIFT_AMBIGUOUS: multiple rows"}`, http.StatusConflict)
	}))
	defer srv.Close()

	if err := SaveConfig(&Config{
		ConvexSiteURL: srv.URL,
		AuthToken:     "tok",
		DeviceID:      "stale-device",
	}); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	out := agentIdentityRepairHandler(OpsContext{}, nil)
	if out.OK || out.Code != "identity_ambiguous" {
		t.Fatalf("repair result = %+v", out)
	}
	if !strings.Contains(out.Error, "remove the duplicate rows") {
		t.Fatalf("error does not carry route to fix: %q", out.Error)
	}
}
