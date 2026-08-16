package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type OpsExecutionPlan struct {
	OK               bool                     `json:"ok"`
	Verb             string                   `json:"verb"`
	RequestedMachine string                   `json:"requestedMachine"`
	ResolvedMachine  string                   `json:"resolvedMachine"`
	SelectionReason  string                   `json:"selectionReason,omitempty"`
	RemoteExecution  bool                     `json:"remoteExecution"`
	Access           OpsExecutionAccessPlan   `json:"access"`
	Project          *OpsExecutionProjectPlan `json:"project,omitempty"`
	Warnings         []string                 `json:"warnings,omitempty"`
}

type OpsExecutionAccessPlan struct {
	Caller string `json:"caller"`
	Scope  string `json:"scope,omitempty"`
}

type OpsExecutionProjectPlan struct {
	WorkDir              string                              `json:"workDir"`
	RequestedProject     string                              `json:"requestedProject,omitempty"`
	Name                 string                              `json:"name,omitempty"`
	GitBranch            string                              `json:"gitBranch,omitempty"`
	GitRemote            string                              `json:"gitRemote,omitempty"`
	Framework            string                              `json:"framework,omitempty"`
	Tags                 []string                            `json:"tags,omitempty"`
	Discovery            projectDiscoverySnapshot            `json:"discovery"`
	WorkspaceRoot        string                              `json:"workspaceRoot,omitempty"`
	WorkspaceName        string                              `json:"workspaceName,omitempty"`
	WorkspacePrimary     string                              `json:"workspacePrimaryDevice,omitempty"`
	WorkspaceVaultMode   string                              `json:"workspaceVaultMode,omitempty"`
	ProjectRemote        *ProjectRemote                      `json:"projectRemote,omitempty"`
	RuntimeAssignments   []ProjectRuntimeResolvedAssignment  `json:"runtimeAssignments,omitempty"`
	ExportPlans          []ProjectRuntimeExportPlan          `json:"exportPlans,omitempty"`
	ProviderRequirements []ProjectRuntimeProviderRequirement `json:"providerRequirements,omitempty"`
	RuntimeWarnings      []string                            `json:"runtimeWarnings,omitempty"`
}

func buildOpsExecutionPlan(octx OpsContext, req OpsRequest) OpsExecutionPlan {
	plan := OpsExecutionPlan{
		OK:               true,
		Verb:             strings.TrimSpace(req.Verb),
		RequestedMachine: strings.TrimSpace(req.Machine),
		Access:           buildOpsExecutionAccessPlan(octx),
	}
	if plan.RequestedMachine == "" {
		plan.RequestedMachine = "local"
	}

	resolved := plan.RequestedMachine
	decision := autoMachineDecision{}
	switch resolved {
	case "", "local":
		resolved = "local"
	case "auto":
		decision = resolveAutoOpsMachine(octx, req)
		resolved = decision.Machine
	case "primary":
		if octx.Server == nil {
			plan.Warnings = append(plan.Warnings, "primary alias could not be resolved without a server context")
		} else if deviceID, err := resolvePrimaryDeviceID(octx.Ctx, octx.Server); err != nil {
			plan.Warnings = append(plan.Warnings, "primary alias resolution failed: "+err.Error())
		} else if strings.TrimSpace(deviceID) != "" {
			resolved = strings.TrimSpace(deviceID)
			decision = autoMachineDecision{
				Machine: resolved,
				Reason:  "matched the user's primary device",
			}
		} else {
			plan.Warnings = append(plan.Warnings, "no primary device configured")
		}
	}
	if strings.TrimSpace(resolved) == "" {
		resolved = "local"
	}
	plan.ResolvedMachine = resolved
	plan.SelectionReason = strings.TrimSpace(decision.Reason)
	plan.RemoteExecution = resolved != "local"
	if plan.SelectionReason == "" && resolved == "local" {
		plan.SelectionReason = "local execution"
	}

	if project := buildOpsExecutionProjectPlan(octx, req); project != nil {
		plan.Project = project
		if len(project.RuntimeWarnings) > 0 {
			plan.Warnings = append(plan.Warnings, project.RuntimeWarnings...)
		}
	}
	return plan
}

func buildOpsExecutionAccessPlan(octx OpsContext) OpsExecutionAccessPlan {
	return OpsExecutionAccessPlan{
		Caller: strings.TrimSpace(octx.Caller),
		Scope:  strings.TrimSpace(octx.Scope),
	}
}

func buildOpsExecutionProjectPlan(octx OpsContext, req OpsRequest) *OpsExecutionProjectPlan {
	workDir := inferOpsExecutionWorkDir(req)
	requestedProject := inferOpsExecutionProjectHint(req)
	if (workDir == "" || requestedProject != "") && requestedProject != "" {
		if resolved, err := resolveProjectRef(requestedProject, workDir); err == nil {
			workDir = resolved.Path
		}
	}
	if workDir == "" && octx.Server != nil && octx.Server.taskMgr != nil {
		workDir = strings.TrimSpace(octx.Server.taskMgr.workDir)
	}
	if workDir == "" {
		if wd, err := os.Getwd(); err == nil {
			workDir = wd
		}
	}
	workDir = strings.TrimSpace(workDir)
	if workDir == "" {
		return nil
	}
	if abs, err := filepath.Abs(workDir); err == nil {
		workDir = abs
	}
	if info, err := os.Stat(workDir); err != nil || !info.IsDir() {
		return &OpsExecutionProjectPlan{
			WorkDir:          workDir,
			RequestedProject: requestedProject,
			Discovery:        currentProjectDiscoverySnapshot(),
		}
	}

	project := &OpsExecutionProjectPlan{
		WorkDir:          workDir,
		RequestedProject: requestedProject,
		Discovery:        currentProjectDiscoverySnapshot(),
	}
	info := DetectProjectInfo(workDir)
	project.Name = info.Name
	project.GitBranch = info.GitBranch
	project.GitRemote = info.GitRemote
	project.Framework = info.Framework
	project.Tags = DetectProjectTags(workDir)
	if project.GitRemote == "" {
		if binding := findProjectRemote(project.Name); binding != nil {
			project.ProjectRemote = binding
			project.GitRemote = binding.RemoteURL
		}
	} else if binding := findProjectRemote(project.Name); binding != nil {
		project.ProjectRemote = binding
	}

	if root, wm := loadNearestWorkspaceManifest(workDir); wm != nil {
		project.WorkspaceRoot = root
		project.WorkspaceName = strings.TrimSpace(wm.Name)
		project.WorkspacePrimary = strings.TrimSpace(wm.Workspace.PrimaryDevice)
		project.WorkspaceVaultMode = strings.TrimSpace(wm.Workspace.Vault)
	}
	if summary, err := BuildProjectRuntimeSummary(context.Background(), octx.Server, workDir); err == nil && summary != nil {
		project.RuntimeAssignments = append(project.RuntimeAssignments, summary.ResolvedAssignments...)
		project.ExportPlans = append(project.ExportPlans, summary.ExportPlans...)
		project.ProviderRequirements = append(project.ProviderRequirements, summary.ProviderRequirements...)
		project.RuntimeWarnings = append(project.RuntimeWarnings, summary.Warnings...)
	}
	return project
}

func inferOpsExecutionWorkDir(req OpsRequest) string {
	switch strings.TrimSpace(req.Verb) {
	case "reload":
		var p opsReloadPayload
		if json.Unmarshal(req.Payload, &p) == nil && strings.TrimSpace(p.WorkDir) != "" {
			return p.WorkDir
		}
	case "deploy":
		var p opsDeployPayload
		if json.Unmarshal(req.Payload, &p) == nil && strings.TrimSpace(p.WorkDir) != "" {
			return p.WorkDir
		}
	}
	var payload map[string]interface{}
	if json.Unmarshal(req.Payload, &payload) != nil {
		return ""
	}
	for _, key := range []string{"workDir", "directory", "dir", "cwd", "path"} {
		if v := strings.TrimSpace(fmt.Sprint(payload[key])); v != "" && v != "<nil>" {
			return v
		}
	}
	return ""
}

func inferOpsExecutionProjectHint(req OpsRequest) string {
	var payload map[string]interface{}
	if json.Unmarshal(req.Payload, &payload) != nil {
		return ""
	}
	for _, key := range []string{"project", "projectName", "name", "slug", "app"} {
		if v := strings.TrimSpace(fmt.Sprint(payload[key])); v != "" && v != "<nil>" {
			return v
		}
	}
	return ""
}
