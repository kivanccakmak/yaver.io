package main

// Power control as an ops verb.
//
// The reboot capability already existed on three surfaces — the phone's Infra
// tab, the web dashboard's Infra view, and the `infra_power` MCP tool — but all
// three go straight to a machine's own /infra/power route, so the CLI (and any
// MCP client driving the ops grand-tool) had no way to reboot a machine at all.
//
// Registering it as an ops verb closes that with one entry: ops already forwards
// any verb to `--machine=<id>`, so this simultaneously gives us
// `yaver reboot --machine=box`, `yaver ops infra_power --machine=box`, and the
// verb through the `ops` MCP tool — on top of the existing phone/web buttons.

import (
	"encoding/json"
	"fmt"
	"strings"
)

func init() {
	registerOpsVerb(opsVerbSpec{
		Name: "infra_power",
		Description: "Power-control a machine: report what power actions it can actually perform, " +
			"reboot the host, restart the Yaver agent, or stop the agent. " +
			"ALWAYS call action=report first — it is a read-only dry run that says, for THIS machine, " +
			"which actions are possible, what each one would really do (a container 'reboot' is not a host " +
			"reboot), the exact command that would run, and how long recovery should take. " +
			"Every other action requires confirm=true and kills running tasks, builds and runners.",
		Schema: map[string]interface{}{
			"type":     "object",
			"required": []string{"action"},
			"properties": map[string]interface{}{
				"action": map[string]interface{}{
					"type": "string",
					"enum": []string{"report", "host_reboot", "agent_restart", "agent_shutdown"},
					"description": "report = read-only capability/dry-run, needs no confirm. " +
						"host_reboot = power-cycle the machine. " +
						"agent_restart = restart just the Yaver agent, machine stays up (the safe escape hatch when host_reboot is unavailable). " +
						"agent_shutdown = stop the agent and leave it down.",
				},
				"confirm": map[string]interface{}{
					"type":        "boolean",
					"description": "Must be true for every action except report. Destructive to in-flight work on the target.",
				},
			},
			"additionalProperties": false,
		},
		Handler:    opsInfraPowerHandler,
		Streaming:  false,
		AllowGuest: false, // never let a guest reboot the owner's machine
	})
}

func opsInfraPowerHandler(octx OpsContext, payload json.RawMessage) OpsResult {
	var req struct {
		Action  string `json:"action"`
		Confirm bool   `json:"confirm"`
	}
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &req); err != nil {
			return OpsResult{OK: false, Code: "bad_payload", Error: "invalid payload: " + err.Error()}
		}
	}
	action := strings.TrimSpace(req.Action)

	// The dry run comes before the confirm gate on purpose: asking what a
	// machine COULD do must never require agreeing to do it. This is the call
	// that lets a caller (or an AI agent) find out that "reboot" on this box
	// means nothing, without discovering it by executing.
	if action == "report" || action == "" {
		return OpsResult{OK: true, Initial: powerReportPayload()}
	}

	if !req.Confirm {
		return OpsResult{OK: false, Code: "confirm_required",
			Error: "confirm=true is required — this stops every task, build and runner on the machine"}
	}

	switch action {
	case "agent_restart":
		facts := powerFactsNow()
		if a, ok := PowerActionByID(facts, ActionAgentRestart); ok && !a.Available {
			return OpsResult{OK: false, Code: "restart_unavailable", Error: a.Reason + " " + a.Remedy}
		}
		// Answer BEFORE the supervisor kills us, or the caller sees only a
		// dropped connection and cannot tell a restart from a crash.
		scheduleAgentRestart()
		return OpsResult{OK: true, Initial: map[string]interface{}{
			"action": "agent_restart",
			"scope":  string(ScopeAgent),
			"note":   "The agent is restarting. The machine stays up; it should answer again within about 15s.",
		}}
	case "agent_shutdown":
		if octx.Server == nil || octx.Server.onShutdown == nil {
			return OpsResult{OK: false, Code: "unsupported",
				Error: "this agent has no shutdown hook wired"}
		}
		// Answer BEFORE dying, or the caller only ever sees a dropped connection.
		go octx.Server.onShutdown()
		return OpsResult{OK: true, Initial: map[string]interface{}{"action": "agent_shutdown"}}
	case "host_reboot":
		facts := powerFactsNow()
		eta := rebootETALinuxSeconds
		if a, ok := PowerActionByID(facts, ActionHostReboot); ok {
			// Refuse with the report's own words. The caller gets the same
			// sentence the UI would have shown, including the alternative — so
			// even a CLI user who skipped `report` is told what they CAN do.
			if !a.Available {
				return OpsResult{OK: false, Code: "reboot_unavailable", Error: a.Reason + " " + a.Remedy}
			}
			eta = a.ETASeconds
		}
		command, err := infraHostReboot()
		if err != nil {
			return OpsResult{OK: false, Code: "reboot_failed", Error: err.Error()}
		}
		return OpsResult{OK: true, Initial: map[string]interface{}{
			"action":     "host_reboot",
			"scope":      string(ScopeMachine),
			"command":    command,
			"etaSeconds": eta,
			"note": fmt.Sprintf(
				"Rebooting. The machine will drop off the network and should answer again in about %s.",
				humanizeRebootSeconds(eta)),
		}}
	default:
		return OpsResult{OK: false, Code: "bad_action",
			Error: fmt.Sprintf("unsupported power action %q — use report, host_reboot, agent_restart or agent_shutdown", req.Action)}
	}
}

// powerReportPayload is the dry-run answer, shared by the ops verb, the HTTP
// route and the MCP tool so the three cannot drift into three different truths.
func powerReportPayload() map[string]interface{} {
	facts := powerFactsNow()
	return map[string]interface{}{
		"action":  "report",
		"facts":   facts,
		"actions": PowerActionsFor(facts),
	}
}
