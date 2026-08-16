package main

// package_ops.go — owner-only MCP/ops verbs for Yaver Task Packages: author,
// publish, run once (incl. MCP-over-MCP), and inspect.
// Domain-agnostic; verticals (yaver-bet, fintech, …) are use cases.
// See docs/yaver-task-packages.md.

import (
	"encoding/json"
	"strings"
)

func init() {
	registerOpsVerb(opsVerbSpec{
		Name: "package_publish",
		Description: "Validate and store a Task Package (yaver/v1 manifest). Payload IS the manifest " +
			"{apiVersion,kind,metadata:{name,...},spec:{task:{kind,sources?,steps?,mcp?,goal?},...}}. " +
			"Returns the stored package (version auto-bumps on re-publish). Owner-only.",
		Schema: ghostJSONSchema(map[string]interface{}{
			"metadata": map[string]interface{}{"type": "object", "description": "{name (required), description?, version?}"},
			"spec":     map[string]interface{}{"type": "object", "description": "{task:{kind, sources?, steps?, mcp?, goal?}, runtimes?, vantage?, schedule?, output?, consent?, guard?}"},
		}, "spec"),
		Handler:        packagePublishHandler,
		AllowCompanion: false,
	})
	registerOpsVerb(opsVerbSpec{
		Name:           "package_list",
		Description:    "List published Task Packages (name, kind, version, engines, vantage requirement). Owner-only.",
		Schema:         ghostJSONSchema(map[string]interface{}{}),
		Handler:        packageListHandler,
		AllowCompanion: false,
	})
	registerOpsVerb(opsVerbSpec{
		Name:        "package_get",
		Description: "Get one Task Package manifest + its recent runs. Owner-only.",
		Schema: ghostJSONSchema(map[string]interface{}{
			"name": map[string]interface{}{"type": "string"},
		}, "name"),
		Handler:        packageGetHandler,
		AllowCompanion: false,
	})
	registerOpsVerb(opsVerbSpec{
		Name: "package_run",
		Description: "Run a Task Package ONCE on this runtime and return the result. Executes declarative " +
			"fetch sources and MCP-over-MCP bindings (call another MCP server — e.g. your yaver-bet MCP — or a " +
			"local Yaver verb). Results are stored vantage-tagged in the collection store. ACTING-tier packages " +
			"(operate/agent) require confirm=true. Owner-only.",
		Schema: ghostJSONSchema(map[string]interface{}{
			"name":    map[string]interface{}{"type": "string"},
			"confirm": map[string]interface{}{"type": "boolean", "description": "Required to run an ACTING-tier (operate/agent/write) package."},
		}, "name"),
		Handler:        packageRunHandler,
		AllowCompanion: false,
	})
	registerOpsVerb(opsVerbSpec{
		Name:        "package_delete",
		Description: "Delete a published Task Package by name. Owner-only.",
		Schema: ghostJSONSchema(map[string]interface{}{
			"name": map[string]interface{}{"type": "string"},
		}, "name"),
		Handler:        packageDeleteHandler,
		AllowCompanion: false,
	})
}

func packagePublishHandler(c OpsContext, payload json.RawMessage) OpsResult {
	var p TaskPackage
	if len(payload) == 0 {
		return OpsResult{OK: false, Code: "bad_payload", Error: "manifest payload required"}
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return OpsResult{OK: false, Code: "bad_payload", Error: err.Error()}
	}
	if p.Metadata.Owner == "" {
		p.Metadata.Owner = c.ActorUserID
	}
	if err := validatePackage(&p); err != nil {
		return OpsResult{OK: false, Code: "bad_payload", Error: err.Error()}
	}
	out := pkgStore.upsertPackage(p)
	// Best-effort: publish privacy-safe owner bookkeeping to Convex so the
	// owner's other devices can list the package. Never blocks local publish.
	go func() {
		defer func() { _ = recover() }()
		if cfg, _ := LoadConfig(); cfg != nil {
			syncTaskPackage(cfg.DeviceID, out)
		}
	}()
	return OpsResult{OK: true, Initial: map[string]interface{}{"package": out, "tier": out.effectiveTier()}}
}

func packageListHandler(c OpsContext, payload json.RawMessage) OpsResult {
	pkgs := pkgStore.listPackages()
	rows := make([]map[string]interface{}, 0, len(pkgs))
	for _, p := range pkgs {
		rows = append(rows, map[string]interface{}{
			"name":     p.Metadata.Name,
			"kind":     p.Spec.Task.Kind,
			"version":  p.Metadata.Version,
			"engines":  p.Spec.Task.Engines,
			"runtimes": p.Spec.Runtimes,
			"vantage":  p.Spec.Vantage,
			"tier":     p.effectiveTier(),
		})
	}
	return OpsResult{OK: true, Initial: map[string]interface{}{"packages": rows, "count": len(rows)}}
}

func packageGetHandler(c OpsContext, payload json.RawMessage) OpsResult {
	var args struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(payload, &args)
	if strings.TrimSpace(args.Name) == "" {
		return OpsResult{OK: false, Code: "bad_payload", Error: "name required"}
	}
	p, ok := pkgStore.getPackage(args.Name)
	if !ok {
		return OpsResult{OK: false, Code: "not_found", Error: "no such package"}
	}
	return OpsResult{OK: true, Initial: map[string]interface{}{
		"package":    p,
		"tier":       p.effectiveTier(),
		"recentRuns": pkgStore.recentRuns(args.Name, 20),
	}}
}

func packageRunHandler(c OpsContext, payload json.RawMessage) OpsResult {
	var args struct {
		Name    string `json:"name"`
		Confirm bool   `json:"confirm"`
	}
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &args); err != nil {
			return OpsResult{OK: false, Code: "bad_payload", Error: err.Error()}
		}
	}
	if strings.TrimSpace(args.Name) == "" {
		return OpsResult{OK: false, Code: "bad_payload", Error: "name required"}
	}
	p, ok := pkgStore.getPackage(args.Name)
	if !ok {
		return OpsResult{OK: false, Code: "not_found", Error: "no such package"}
	}
	res := runPackageOnce(c, p, args.Confirm)
	return OpsResult{OK: true, Initial: map[string]interface{}{"run": res}}
}

func packageDeleteHandler(c OpsContext, payload json.RawMessage) OpsResult {
	var args struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(payload, &args)
	if !pkgStore.deletePackage(strings.TrimSpace(args.Name)) {
		return OpsResult{OK: false, Code: "not_found", Error: "no such package"}
	}
	return OpsResult{OK: true, Initial: map[string]interface{}{"deleted": args.Name}}
}
