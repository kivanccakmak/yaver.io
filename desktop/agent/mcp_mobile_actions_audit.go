package main

import (
	"os"
	"path/filepath"
	"strings"
)

type mobileProjectActionsAuditRow struct {
	Name             string   `json:"name"`
	Path             string   `json:"path"`
	Framework        string   `json:"framework,omitempty"`
	MobileCapable    bool     `json:"mobileCapable"`
	ActionLabels     []string `json:"actionLabels"`
	SupportedActions []string `json:"supportedActions"`
	OK               bool     `json:"ok"`
	Problem          string   `json:"problem,omitempty"`
	RecommendedFix   string   `json:"recommendedFix,omitempty"`
}

func mcpMobileProjectActionsAudit(directory string) map[string]interface{} {
	dir := strings.TrimSpace(directory)
	if dir != "" {
		if abs, err := filepath.Abs(dir); err == nil {
			dir = filepath.Clean(abs)
		}
	}

	projects := mobileCapableProjects(scanMobileProjects())
	if dir != "" {
		filtered := make([]MobileProject, 0, len(projects))
		for _, p := range projects {
			if pathWithinOrEqual(p.Path, dir) {
				filtered = append(filtered, p)
			}
		}
		projects = filtered
		if len(projects) == 0 {
			if st, err := os.Stat(dir); err == nil && st.IsDir() {
				projects = []MobileProject{{
					Name:          filepath.Base(dir),
					Path:          dir,
					MobileCapable: true,
					Framework:     inferFrameworkFromActions(DetectProjectActions(dir)),
				}}
			}
		}
	}

	rows := make([]mobileProjectActionsAuditRow, 0, len(projects))
	failures := 0
	for _, p := range projects {
		actions := DetectProjectActions(p.Path)
		row := mobileProjectActionsAuditRow{
			Name:             p.Name,
			Path:             p.Path,
			Framework:        p.Framework,
			MobileCapable:    p.MobileCapable,
			ActionLabels:     projectActionLabels(actions, false),
			SupportedActions: projectActionLabels(actions, true),
		}
		row.OK = len(row.SupportedActions) > 0
		if !row.OK {
			failures++
			row.Problem = "mobile project is discoverable but has no supported operation"
			row.RecommendedFix = "align DetectProjectActions with mobile discovery for this framework/manifest so the project card has Remote Runtime, Hot Reload, or a build action"
		}
		rows = append(rows, row)
	}

	return map[string]interface{}{
		"ok":           failures == 0,
		"checked":      len(rows),
		"failures":     failures,
		"directory":    dir,
		"failureClass": "inventory-says-yes-operation-says-no",
		"nextAction":   auditNextAction(failures),
		"projects":     rows,
	}
}

func projectActionLabels(actions []ProjectAction, supportedOnly bool) []string {
	labels := make([]string, 0, len(actions))
	for _, a := range actions {
		if supportedOnly && !a.Supported {
			continue
		}
		label := strings.TrimSpace(a.Label)
		if label == "" {
			label = strings.TrimSpace(a.Type)
		}
		if label != "" {
			labels = append(labels, label)
		}
	}
	return labels
}

func inferFrameworkFromActions(actions []ProjectAction) string {
	for _, a := range actions {
		if strings.TrimSpace(a.Framework) != "" {
			return a.Framework
		}
	}
	return ""
}

func pathWithinOrEqual(path, root string) bool {
	path = filepath.Clean(path)
	root = filepath.Clean(root)
	if path == root {
		return true
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel != "." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != ".."
}

func auditNextAction(failures int) string {
	if failures == 0 {
		return "all discovered mobile project cards expose at least one supported operation"
	}
	return "fix the failing framework/manifest action detector before telling the phone or MCP client the project is runnable"
}
