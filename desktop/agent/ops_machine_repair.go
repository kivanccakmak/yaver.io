package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

func init() {
	registerOpsVerb(opsVerbSpec{
		Name:        "machine_repair",
		Description: "Attempt a deterministic repair for an owned machine. restart_agent asks this connected agent to use the backup SSH/mesh channel to restart the target's Yaver agent, then clients should re-run machine_doctor or machine_roles_doctor. Owner-only, bounded and idempotent.",
		Schema: ghostJSONSchema(map[string]interface{}{
			"deviceId": map[string]interface{}{"type": "string", "description": "Target deviceId to repair."},
			"device":   map[string]interface{}{"type": "string", "description": "Alias, name, or deviceId to repair."},
			"action": map[string]interface{}{
				"type":        "string",
				"description": "restart_agent (default) restarts the target Yaver agent through an online peer's SSH path.",
				"enum":        []string{"restart_agent"},
			},
		}),
		Handler:    machineRepairHandler,
		AllowGuest: false,
	})
}

type machineRepairReport struct {
	OK       bool   `json:"ok"`
	Action   string `json:"action"`
	DeviceID string `json:"deviceId"`
	Name     string `json:"name,omitempty"`
	Outcome  string `json:"outcome"`
	Code     string `json:"code,omitempty"`
	Next     string `json:"next,omitempty"`
}

func machineRepairHandler(c OpsContext, payload json.RawMessage) OpsResult {
	var in struct {
		DeviceID  string `json:"deviceId"`
		DeviceID2 string `json:"device_id"`
		Device    string `json:"device"`
		Action    string `json:"action"`
	}
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &in); err != nil {
			return OpsResult{OK: false, Code: "bad_payload", Error: "bad payload: " + err.Error()}
		}
	}
	hint := strings.TrimSpace(firstNonEmpty(in.DeviceID, in.DeviceID2, in.Device))
	if hint == "" {
		return OpsResult{OK: false, Code: "bad_payload", Error: "deviceId or device is required"}
	}
	action := strings.TrimSpace(in.Action)
	if action == "" {
		action = "restart_agent"
	}
	if action != "restart_agent" {
		return OpsResult{OK: false, Code: "bad_action", Error: fmt.Sprintf("unsupported repair action %q — use restart_agent", in.Action)}
	}
	cfg, target, err := findOwnedDeviceForHint(hint)
	if err != nil {
		return OpsResult{OK: false, Code: "not_found", Error: err.Error()}
	}
	name := strings.TrimSpace(firstNonEmpty(target.Alias, target.Name, target.DeviceID))
	// Self-repair guard: SSH-restarting the agent that is servicing THIS
	// request would kill the request mid-flight and report a spurious
	// failure. Restarting yourself has a supervised path already.
	if cfg != nil && strings.TrimSpace(cfg.DeviceID) != "" && cfg.DeviceID == target.DeviceID {
		return OpsResult{OK: false, Code: "self_target", Error: fmt.Sprintf(
			"%s is this machine — machine_repair restarts a REMOTE peer over the backup SSH channel. To restart this agent use agent_shutdown (the init system respawns it) or `yaver serve` supervision.", name)}
	}
	outcome := attemptPeerRecovery(target.DeviceID, name)
	rep := machineRepairReport{
		Action:   action,
		DeviceID: target.DeviceID,
		Name:     name,
		Outcome:  outcome,
		Next:     "Re-run machine_roles_doctor or machine_doctor; the target should reconnect to the relay after its agent restarts.",
	}
	switch {
	case strings.HasPrefix(outcome, "ok:"):
		rep.OK = true
		rep.Code = "repair_started"
		return OpsResult{OK: true, Initial: rep}
	case strings.HasPrefix(outcome, "skipped: no ssh target"):
		rep.Code = "no_ssh_target"
		return OpsResult{OK: false, Code: rep.Code, Error: "no SSH target is configured for " + name, Initial: rep}
	case strings.Contains(strings.ToLower(outcome), "host key verification failed"):
		rep.Code = "ssh_host_key"
		return OpsResult{OK: false, Code: rep.Code, Error: "backup SSH channel was blocked by host-key verification; Yaver now uses StrictHostKeyChecking=accept-new for first-contact recovery, but this running agent needs that update", Initial: rep}
	case strings.Contains(strings.ToLower(outcome), "permission denied") || strings.Contains(strings.ToLower(outcome), "too many authentication failures"):
		rep.Code = "ssh_auth_failed"
		return OpsResult{OK: false, Code: rep.Code, Error: "backup SSH reached the target but the target did not trust this watchdog's SSH key; pair the Yaver-managed backup key while the target agent is healthy, or install this watchdog's public key on the target", Initial: rep}
	case strings.Contains(strings.ToLower(outcome), "exec request failed") || strings.Contains(strings.ToLower(outcome), "shell request failed"):
		rep.Code = "ssh_session_refused"
		return OpsResult{OK: false, Code: rep.Code, Error: "SSH authenticated but the target refused exec/shell sessions; enable the Yaver forced-command/control channel or Remote Login exec for the target account", Initial: rep}
	case strings.HasPrefix(outcome, "failed:"):
		rep.Code = "ssh_failed"
		return OpsResult{OK: false, Code: rep.Code, Error: outcome, Initial: rep}
	default:
		rep.Code = "not_repaired"
		return OpsResult{OK: false, Code: rep.Code, Error: outcome, Initial: rep}
	}
}
