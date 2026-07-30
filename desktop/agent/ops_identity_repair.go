package main

import (
	"encoding/json"
	"errors"
	"time"
)

func init() {
	registerOpsVerb(opsVerbSpec{
		Name:        "agent_identity_repair",
		Description: "Repair this agent's local device identity after duplicate/stale device-row cleanup. Runs one authenticated heartbeat; if Convex can prove a single canonical row by owner + hardwareId, the agent saves that device_id and restarts. Owner-only, no polling.",
		Schema: ghostJSONSchema(map[string]interface{}{
			"restart": map[string]interface{}{"type": "boolean", "description": "Restart the agent after saving the canonical id. Defaults true."},
		}),
		Handler:    agentIdentityRepairHandler,
		AllowGuest: false,
	})
}

func agentIdentityRepairHandler(c OpsContext, payload json.RawMessage) OpsResult {
	var in struct {
		Restart *bool `json:"restart"`
	}
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &in); err != nil {
			return OpsResult{OK: false, Code: "bad_payload", Error: "bad payload: " + err.Error()}
		}
	}
	restart := true
	if in.Restart != nil {
		restart = *in.Restart
	}
	cfg, err := LoadConfig()
	if err != nil || cfg == nil {
		return OpsResult{OK: false, Code: "config_unavailable", Error: "could not read local Yaver config"}
	}
	if cfg.ConvexSiteURL == "" || cfg.AuthToken == "" || cfg.DeviceID == "" {
		return OpsResult{OK: false, Code: "not_authenticated", Error: "this agent has no Convex URL, token, or device_id; run `yaver auth` on the machine"}
	}
	port := 0
	if c.Server != nil {
		port = c.Server.port
	}
	hb, err := SendHeartbeat(
		cfg.ConvexSiteURL,
		cfg.AuthToken,
		cfg.DeviceID,
		nil,
		nil,
		getLocalIP(),
		getLocalIPs(),
		publicEndpointsWithAutoIP(cfg, port),
		nil,
		connectionPreferencesForHeartbeat(cfg, getLocalIPs(), publicEndpointsWithAutoIP(cfg, port)),
		nil,
	)
	if err != nil {
		switch {
		case errors.Is(err, ErrAuthExpired):
			return OpsResult{OK: false, Code: "auth_expired", Error: "agent token is expired; use Re-auth this device from web or run `yaver auth` on the machine"}
		case errors.Is(err, ErrDeviceIDAmbiguous):
			return OpsResult{OK: false, Code: "identity_ambiguous", Error: "multiple owned device rows match this hardware; remove the duplicate rows first, then retry identity repair"}
		case errors.Is(err, ErrDeviceIDStale):
			return OpsResult{OK: false, Code: "identity_stale_unmatched", Error: "configured device_id is stale and Convex could not safely map this hardware to one owned row; run `yaver auth` on the machine"}
		default:
			return OpsResult{OK: false, Code: "heartbeat_failed", Error: err.Error()}
		}
	}
	if hb == nil || hb.CanonicalDeviceID == "" || hb.CanonicalDeviceID == cfg.DeviceID {
		return OpsResult{OK: true, Code: "identity_ok", Initial: map[string]interface{}{
			"ok":       true,
			"deviceId": cfg.DeviceID,
			"changed":  false,
		}}
	}
	var restartFn func()
	if restart {
		restartFn = func() {
			if reexecAfterIdentityRepair != nil {
				go func() {
					time.Sleep(250 * time.Millisecond)
					reexecAfterIdentityRepair()
				}()
			}
		}
	}
	changed := adoptCanonicalDeviceIDFromHeartbeat(cfg.DeviceID, hb, restartFn)
	if !changed {
		return OpsResult{OK: false, Code: "identity_not_changed", Error: "Convex returned a canonical id, but local config changed before repair could save it"}
	}
	return OpsResult{OK: true, Code: "identity_repaired", Initial: map[string]interface{}{
		"ok":                   true,
		"deviceId":             hb.CanonicalDeviceID,
		"repairedDeviceIdFrom": hb.RepairedDeviceIDFrom,
		"changed":              true,
		"restartScheduled":     restart,
	}}
}
