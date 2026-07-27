package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func init() {
	registerOpsVerb(opsVerbSpec{
		Name:        "machine_roles",
		Description: "Read, set, or clear the account/project runner-render machine split. This is the agent/MCP route behind web/mobile Settings: use it from Codex, Claude Code, chat, or task flows to set the primary AI runner and primary renderer without touching the UI.",
		Schema: ghostJSONSchema(map[string]interface{}{
			"action": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"get", "set", "clear"},
				"description": "get = read current row; set = save runner/render devices; clear = return to single-box default.",
			},
			"runner":          map[string]interface{}{"type": "string", "description": "Runner device selector: deviceId, unique prefix, exact name, or alias."},
			"runnerDeviceId":  map[string]interface{}{"type": "string", "description": "Runner deviceId or selector."},
			"render":          map[string]interface{}{"type": "string", "description": "Renderer device selector: deviceId, unique prefix, exact name, or alias. Defaults to runner."},
			"renderDeviceId":  map[string]interface{}{"type": "string", "description": "Renderer deviceId or selector."},
			"secondaryRunner": map[string]interface{}{"type": "string", "description": "Optional fallback runner selector."},
			"secondaryRender": map[string]interface{}{"type": "string", "description": "Optional fallback renderer selector."},
			"projectName":     map[string]interface{}{"type": "string", "description": "Optional project-scoped row. Empty means account-wide favorite."},
			"workspace": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"runner-clone", "render-ssh"},
				"description": "How runner/render workspaces sync. Default runner-clone.",
			},
			"autoPush": map[string]interface{}{
				"type":        "string",
				"enum":        []string{"never", "ask", "always"},
				"description": "Whether task changes should auto-push from runner to renderer. Default ask.",
			},
		}),
		Handler:    machineRolesHandler,
		AllowGuest: false,
	})
}

type machineRolesPayload struct {
	Action          string `json:"action"`
	Runner          string `json:"runner"`
	RunnerDeviceID  string `json:"runnerDeviceId"`
	RunnerDeviceID2 string `json:"runner_device_id"`
	Render          string `json:"render"`
	RenderDeviceID  string `json:"renderDeviceId"`
	RenderDeviceID2 string `json:"render_device_id"`
	SecondaryRunner string `json:"secondaryRunner"`
	SecondaryRender string `json:"secondaryRender"`
	ProjectName     string `json:"projectName"`
	Workspace       string `json:"workspace"`
	AutoPush        string `json:"autoPush"`
}

type machineRolesSetReport struct {
	OK      bool                      `json:"ok"`
	Action  string                    `json:"action"`
	Row     machineRolesDoctorRow     `json:"row,omitempty"`
	Devices map[string]string         `json:"devices,omitempty"`
	Doctor  *machineRolesDoctorReport `json:"doctor,omitempty"`
}

func machineRolesHandler(c OpsContext, payload json.RawMessage) OpsResult {
	var in machineRolesPayload
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &in); err != nil {
			return OpsResult{OK: false, Code: "bad_payload", Error: "bad payload: " + err.Error()}
		}
	}
	action := strings.ToLower(strings.TrimSpace(in.Action))
	if action == "" {
		action = "get"
	}

	cfg, err := LoadConfig()
	if err != nil || cfg == nil || strings.TrimSpace(cfg.AuthToken) == "" {
		return OpsResult{OK: false, Code: "auth_required", Error: "not signed in - run `yaver auth` first"}
	}
	convex := strings.TrimSpace(cfg.ConvexSiteURL)
	if convex == "" {
		convex = defaultConvexSiteURL
	}

	switch action {
	case "get":
		row, err := fetchMachineRolesRow(c.Ctx, convex, cfg.AuthToken, strings.TrimSpace(in.ProjectName))
		if err != nil {
			return OpsResult{OK: false, Code: "settings_unreachable", Error: err.Error()}
		}
		report := machineRolesSetReport{OK: true, Action: "get"}
		if row != nil {
			report.Row = *row
		}
		return OpsResult{OK: true, Initial: report}
	case "clear":
		if err := postMachineRolesRow(c.Ctx, convex, cfg.AuthToken, map[string]interface{}{
			"runnerDeviceId": nil,
			"projectName":    strings.TrimSpace(in.ProjectName),
		}); err != nil {
			return OpsResult{OK: false, Code: "settings_write_failed", Error: err.Error()}
		}
		return OpsResult{OK: true, Initial: machineRolesSetReport{OK: true, Action: "clear"}}
	case "set":
	default:
		return OpsResult{OK: false, Code: "bad_action", Error: fmt.Sprintf("unsupported action %q — use get, set, or clear", in.Action)}
	}

	devices, err := primaryListDevices(c.Ctx, cfg.AuthToken, convex)
	if err != nil {
		return OpsResult{OK: false, Code: "devices_unreachable", Error: err.Error()}
	}
	runnerHint := strings.TrimSpace(firstNonEmpty(in.RunnerDeviceID, in.RunnerDeviceID2, in.Runner))
	if runnerHint == "" {
		return OpsResult{OK: false, Code: "bad_payload", Error: "runner or runnerDeviceId is required for action=set"}
	}
	runner, err := resolveMachineRoleDevice(runnerHint, devices)
	if err != nil {
		return OpsResult{OK: false, Code: "runner_not_found", Error: err.Error()}
	}
	renderHint := strings.TrimSpace(firstNonEmpty(in.RenderDeviceID, in.RenderDeviceID2, in.Render))
	if renderHint == "" {
		renderHint = runner.DeviceID
	}
	render, err := resolveMachineRoleDevice(renderHint, devices)
	if err != nil {
		return OpsResult{OK: false, Code: "render_not_found", Error: err.Error()}
	}
	secondaryRunnerID, err := resolveOptionalMachineRoleDevice(in.SecondaryRunner, devices)
	if err != nil {
		return OpsResult{OK: false, Code: "secondary_runner_not_found", Error: err.Error()}
	}
	secondaryRenderID, err := resolveOptionalMachineRoleDevice(in.SecondaryRender, devices)
	if err != nil {
		return OpsResult{OK: false, Code: "secondary_render_not_found", Error: err.Error()}
	}

	workspace := strings.TrimSpace(in.Workspace)
	if workspace == "" {
		workspace = "runner-clone"
	}
	if workspace != "runner-clone" && workspace != "render-ssh" {
		return OpsResult{OK: false, Code: "bad_workspace", Error: "workspace must be runner-clone or render-ssh"}
	}
	autoPush := strings.TrimSpace(in.AutoPush)
	if autoPush == "" {
		autoPush = "ask"
	}
	if autoPush != "never" && autoPush != "ask" && autoPush != "always" {
		return OpsResult{OK: false, Code: "bad_auto_push", Error: "autoPush must be never, ask, or always"}
	}

	row := machineRolesDoctorRow{
		ProjectName:             strings.TrimSpace(in.ProjectName),
		RunnerDeviceID:          runner.DeviceID,
		SecondaryRunnerDeviceID: secondaryRunnerID,
		RenderDeviceID:          render.DeviceID,
		SecondaryRenderDeviceID: secondaryRenderID,
		Workspace:               workspace,
		AutoPush:                autoPush,
	}
	write := map[string]interface{}{
		"projectName":    row.ProjectName,
		"runnerDeviceId": row.RunnerDeviceID,
		"renderDeviceId": row.RenderDeviceID,
		"workspace":      row.Workspace,
		"autoPush":       row.AutoPush,
		"updatedAt":      time.Now().UnixMilli(),
	}
	if row.SecondaryRunnerDeviceID != "" {
		write["secondaryRunnerDeviceId"] = row.SecondaryRunnerDeviceID
	}
	if row.SecondaryRenderDeviceID != "" {
		write["secondaryRenderDeviceId"] = row.SecondaryRenderDeviceID
	}
	if err := postMachineRolesRow(c.Ctx, convex, cfg.AuthToken, write); err != nil {
		return OpsResult{OK: false, Code: "settings_write_failed", Error: err.Error()}
	}
	report := machineRolesSetReport{
		OK:     true,
		Action: "set",
		Row:    row,
		Devices: map[string]string{
			"runner": runner.Name,
			"render": render.Name,
		},
	}
	return OpsResult{OK: true, Initial: report}
}

func resolveOptionalMachineRoleDevice(hint string, devices []primaryDevice) (string, error) {
	hint = strings.TrimSpace(hint)
	if hint == "" {
		return "", nil
	}
	d, err := resolveMachineRoleDevice(hint, devices)
	if err != nil {
		return "", err
	}
	return d.DeviceID, nil
}

func resolveMachineRoleDevice(hint string, devices []primaryDevice) (*primaryDevice, error) {
	hint = strings.TrimSpace(hint)
	if hint == "" {
		return nil, fmt.Errorf("empty device selector")
	}
	var matches []primaryDevice
	for _, d := range devices {
		if d.IsGuest {
			continue
		}
		if d.DeviceID == hint || strings.EqualFold(d.Name, hint) {
			copy := d
			return &copy, nil
		}
		if strings.HasPrefix(d.DeviceID, hint) || strings.Contains(strings.ToLower(d.Name), strings.ToLower(hint)) {
			matches = append(matches, d)
		}
	}
	if len(matches) == 0 {
		// Aliases live on the full device row, not this primaryDevice listing —
		// fall back to the alias-aware resolver so `runner=<alias>` works the
		// same way machine_repair's device=<alias> does.
		if _, d, err := findOwnedDeviceForHint(hint); err == nil && d != nil {
			return &primaryDevice{DeviceID: d.DeviceID, Name: d.Name}, nil
		}
		return nil, fmt.Errorf("no owned device matches %q", hint)
	}
	if len(matches) > 1 {
		ids := make([]string, 0, len(matches))
		for _, d := range matches {
			ids = append(ids, d.DeviceID[:min(8, len(d.DeviceID))]+" "+d.Name)
		}
		return nil, fmt.Errorf("%q matches multiple devices: %s", hint, strings.Join(ids, ", "))
	}
	return &matches[0], nil
}

func postMachineRolesRow(ctx context.Context, convex, token string, row map[string]interface{}) error {
	body, _ := json.Marshal(map[string]interface{}{"machineRolesForProject": row})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(convex, "/")+"/settings", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := remoteHTTPClient(10 * time.Second).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		out, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("settings: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(out)))
	}
	return nil
}
