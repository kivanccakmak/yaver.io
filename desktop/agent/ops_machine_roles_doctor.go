package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// machine_roles_doctor validates the runner/render split as an operation, not
// as inventory. A settings row that says "render on the Mac mini" is not useful
// when the mini is missing from the relay; this verb gives web/mobile/CLI one
// bounded backend verdict before they open a preview and wait silently.

func init() {
	registerOpsVerb(opsVerbSpec{
		Name:        "machine_roles_doctor",
		Description: "Validate the saved runner/render machine-role split by probing the runner and render devices with bounded transport checks. Returns a stable ready/code verdict so clients can refuse loudly before dispatching tasks or previews to the wrong box.",
		Schema: ghostJSONSchema(map[string]interface{}{
			"projectName": map[string]interface{}{"type": "string", "description": "Optional project-scoped role row. Empty uses the account-wide favorite."},
			"timeoutMs": map[string]interface{}{
				"type":        "integer",
				"description": "Per-leg transport probe budget. Default 4000. Runner and render probes run independently.",
			},
		}),
		Handler:    machineRolesDoctorHandler,
		AllowGuest: false,
	})
}

type machineRolesDoctorReport struct {
	Ready       bool                     `json:"ready"`
	Code        string                   `json:"code"`
	Summary     string                   `json:"summary"`
	ProjectName string                   `json:"projectName,omitempty"`
	Row         *machineRolesDoctorRow   `json:"row,omitempty"`
	Roles       []machineRoleProbeReport `json:"roles"`
}

type machineRolesDoctorRow struct {
	ProjectName             string `json:"projectName,omitempty"`
	RunnerDeviceID          string `json:"runnerDeviceId"`
	SecondaryRunnerDeviceID string `json:"secondaryRunnerDeviceId,omitempty"`
	RenderDeviceID          string `json:"renderDeviceId,omitempty"`
	SecondaryRenderDeviceID string `json:"secondaryRenderDeviceId,omitempty"`
	Workspace               string `json:"workspace,omitempty"`
	AutoPush                string `json:"autoPush,omitempty"`
}

type machineRoleProbeReport struct {
	Role      string            `json:"role"`
	DeviceID  string            `json:"deviceId"`
	Name      string            `json:"name,omitempty"`
	Reachable bool              `json:"reachable"`
	Via       string            `json:"via,omitempty"`
	Code      string            `json:"code"`
	Summary   string            `json:"summary"`
	Fix       *machineRoleFix   `json:"fix,omitempty"`
	Legs      []legVerdict      `json:"legs"`
	Heartbeat *heartbeatVerdict `json:"heartbeat,omitempty"`
}

type machineRoleFix struct {
	Label   string                 `json:"label"`
	Method  string                 `json:"method"`
	Path    string                 `json:"path"`
	OpsVerb string                 `json:"opsVerb"`
	Payload map[string]interface{} `json:"payload"`
}

func machineRolesDoctorHandler(c OpsContext, payload json.RawMessage) OpsResult {
	var in struct {
		ProjectName string `json:"projectName"`
		TimeoutMs   int    `json:"timeoutMs"`
		TimeoutMs2  int    `json:"timeout_ms"`
	}
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &in); err != nil {
			return OpsResult{Error: "bad payload: " + err.Error(), Code: "bad_payload"}
		}
	}
	perLeg := time.Duration(in.TimeoutMs) * time.Millisecond
	if perLeg <= 0 && in.TimeoutMs2 > 0 {
		perLeg = time.Duration(in.TimeoutMs2) * time.Millisecond
	}
	if perLeg <= 0 {
		perLeg = 4 * time.Second
	}

	cfg, err := LoadConfig()
	if err != nil || cfg == nil || strings.TrimSpace(cfg.AuthToken) == "" {
		return OpsResult{OK: false, Code: "auth_required", Error: "not signed in - run `yaver auth` first"}
	}
	convex := strings.TrimSpace(cfg.ConvexSiteURL)
	if convex == "" {
		convex = defaultConvexSiteURL
	}
	row, err := fetchMachineRolesRow(c.Ctx, convex, cfg.AuthToken, strings.TrimSpace(in.ProjectName))
	if err != nil {
		return OpsResult{OK: false, Code: "settings_unreachable", Error: err.Error()}
	}
	if row == nil || strings.TrimSpace(row.RunnerDeviceID) == "" {
		rep := machineRolesDoctorReport{
			Ready:   true,
			Code:    "single_box",
			Summary: "no runner/render split configured; tasks and rendering use the connected machine",
		}
		return OpsResult{OK: true, Initial: rep}
	}
	if strings.TrimSpace(row.RenderDeviceID) == "" {
		row.RenderDeviceID = row.RunnerDeviceID
	}

	report := machineRolesDoctorReport{
		ProjectName: strings.TrimSpace(in.ProjectName),
		Row:         row,
	}
	report.Roles = append(report.Roles, probeMachineRole(c.Ctx, cfg, "runner", row.RunnerDeviceID, perLeg))
	if row.RenderDeviceID == row.RunnerDeviceID {
		render := report.Roles[0]
		render.Role = "render"
		report.Roles = append(report.Roles, render)
	} else {
		report.Roles = append(report.Roles, probeMachineRole(c.Ctx, cfg, "render", row.RenderDeviceID, perLeg))
	}

	report.Ready = true
	for _, role := range report.Roles {
		if !role.Reachable {
			report.Ready = false
			report.Code = role.Role + "_unreachable"
			report.Summary = fmt.Sprintf("%s machine %s is not reachable: %s", role.Role, role.DeviceID[:min(8, len(role.DeviceID))], role.Summary)
			break
		}
	}
	if report.Ready {
		report.Code = "ready"
		report.Summary = "runner/render split is reachable"
	}
	return OpsResult{OK: true, Initial: report}
}

func fetchMachineRolesRow(ctx context.Context, convex, token, projectName string) (*machineRolesDoctorRow, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(convex, "/")+"/settings", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := remoteHTTPClient(8 * time.Second).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("settings: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var parsed struct {
		Settings struct {
			MachineRolesByProject []machineRolesDoctorRow `json:"machineRolesByProject"`
		} `json:"settings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, err
	}
	for _, row := range parsed.Settings.MachineRolesByProject {
		if strings.EqualFold(strings.TrimSpace(row.ProjectName), projectName) {
			copy := row
			return &copy, nil
		}
	}
	return nil, nil
}

func probeMachineRole(ctx context.Context, cfg *Config, role, deviceID string, perLeg time.Duration) machineRoleProbeReport {
	out := machineRoleProbeReport{Role: role, DeviceID: deviceID}
	targetCfg, target, err := findOwnedDeviceForHint(deviceID)
	if err != nil {
		out.Code = "not_found"
		out.Summary = err.Error()
		return out
	}
	out.Name = target.Name
	out.Heartbeat = heartbeatFromDevice(target)
	candidates, err := buildRemoteAgentCandidates(targetCfg, target)
	if err != nil {
		out.Code = "no_candidates"
		out.Summary = err.Error()
		return out
	}
	out.Legs = probeLegsConcurrently(ctx, candidates, cfg.AuthToken, perLeg)
	for _, leg := range out.Legs {
		if leg.OK {
			out.Reachable = true
			out.Via = leg.BaseURL
			out.Code = "reachable"
			out.Summary = "reachable via " + leg.Kind
			return out
		}
	}
	out.Code = "unreachable"
	out.Summary, _ = summarizeUnreachable(out.Legs)
	out.Fix = &machineRoleFix{
		Label:   "Recover via watchdog",
		Method:  "POST",
		Path:    "/ops",
		OpsVerb: "machine_repair",
		Payload: map[string]interface{}{
			"action":   "restart_agent",
			"deviceId": deviceID,
		},
	}
	return out
}
