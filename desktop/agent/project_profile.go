package main

// project_profile.go — product, deploy-target, and adapter detection.
//
// Framework detection answers "how is this built?". This layer answers the
// user-facing question "what is this project and where can it run?". It is
// intentionally bounded and evidence-based: product classification must not
// walk node_modules or run package-manager commands during a status request.

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ProjectProfile is the compact, cross-surface answer to "what is this
// project and what can Yaver do with it?" It deliberately carries no secret
// values or external MCP credentials.
type ProjectProfile struct {
	WorkDir       string                `json:"workDir"`
	Framework     string                `json:"framework,omitempty"`
	Frameworks    []string              `json:"frameworks,omitempty"`
	Products      []DetectedProduct     `json:"products,omitempty"`
	Providers     []string              `json:"providers,omitempty"`
	DeployTargets []string              `json:"deployTargets,omitempty"`
	Adapters      []string              `json:"adapters,omitempty"`
	AdapterPolicy *ProjectAdapterPolicy `json:"adapterPolicy,omitempty"`
	Surfaces      []string              `json:"surfaces,omitempty"`
	TestSurfaces  []string              `json:"testSurfaces,omitempty"`
	Evidence      []StackEvidence       `json:"evidence,omitempty"`
}

func buildProjectProfile(dir string) (ProjectProfile, error) {
	if strings.TrimSpace(dir) == "" {
		return ProjectProfile{}, os.ErrInvalid
	}
	d := stackDetect(dir)
	if d == nil {
		return ProjectProfile{}, os.ErrInvalid
	}
	var policy *ProjectAdapterPolicy
	if manifest, err := LoadManifest(dir); err == nil {
		policy = projectAdapterPolicy(manifest)
	} else if !isProjectManifestMissing(err) {
		return ProjectProfile{}, err
	}
	if policy == nil {
		policy = workspaceAdapterPolicyForDir(dir)
	}
	return ProjectProfile{
		WorkDir: dir, Framework: d.Framework, Frameworks: d.Frameworks,
		Products: d.Products, Providers: append([]string{}, d.Services...),
		DeployTargets: d.DeployTargets, Adapters: d.Adapters,
		AdapterPolicy: policy, Surfaces: d.Surfaces,
		TestSurfaces: d.TestSurfaces, Evidence: d.Evidence,
	}, nil
}

func (s *HTTPServer) handleProjectProfile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	dir := strings.TrimSpace(r.URL.Query().Get("dir"))
	if dir == "" && s.taskMgr != nil {
		dir = strings.TrimSpace(s.taskMgr.workDir)
	}
	profile, err := buildProjectProfile(dir)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "project profile unavailable: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, profile)
}

func projectProfileMCPTools() []map[string]interface{} {
	return []map[string]interface{}{{
		"name":        "project_profile",
		"description": "Detect the project's framework, product/host type, providers, deploy targets, preview surfaces, and project-scoped MCP adapter policy. Read-only; credentials are never returned.",
		"inputSchema": map[string]interface{}{"type": "object", "properties": map[string]interface{}{
			"directory": map[string]interface{}{"type": "string", "description": "Project directory. Omit to use the agent's configured work directory."},
		}},
	}}
}

func mcpProjectProfile(directory string) interface{} {
	profile, err := buildProjectProfile(strings.TrimSpace(directory))
	if err != nil {
		return mcpToolError("project profile unavailable: " + err.Error())
	}
	return profile
}

func detectProjectProfile(dir string, d *StackDetection) ([]DetectedProduct, []string, []string) {
	if d == nil {
		return nil, nil, nil
	}
	products := detectProducts(dir)
	targets := append([]string{}, d.Surfaces...)
	if d.Backend != "" || hasTargetID(d, "supabase") || hasTargetID(d, "convex") || hasTargetID(d, "firebase") {
		targets = append(targets, "backend")
	}
	if containsAnyString(d.Frameworks, FwExpo, FwReactNative, FwFlutter, FwSwift, FwKotlin) {
		targets = append(targets, "testflight", "google-play")
	}
	for _, p := range products {
		targets = append(targets, productDeployTargets(p.ID)...)
	}
	for _, t := range d.Targets {
		for _, action := range t.Actions {
			if action.OpsTarget != "" {
				targets = append(targets, action.OpsTarget)
			}
		}
	}

	var adapters []string
	// Include weak provider evidence in the profile so the user can see the
	// complete stack. projectMCPSelection applies the stricter launch rule and
	// only auto-arms config-proven providers.
	for _, target := range d.Targets {
		adapters = append(adapters, target.ID)
	}
	adapters = append(adapters, d.Hosting...)
	for _, p := range products {
		adapters = append(adapters, productAdapter(p.ID)...)
	}
	return products, dedupeSorted(targets), dedupeSorted(adapters)
}

func productAdapterIDs(products []DetectedProduct) []string {
	var out []string
	for _, product := range products {
		out = append(out, productAdapter(product.ID)...)
	}
	return out
}

func detectProducts(dir string) []DetectedProduct {
	var out []DetectedProduct
	add := func(id, name, evidence string, hosts ...string) {
		out = append(out, DetectedProduct{ID: id, Name: name, Evidence: evidence, Hosts: dedupeSorted(hosts)})
	}

	if officeManifest := firstProjectFile(dir, "manifest.xml", "manifest.office.xml", "manifest.office.json"); officeManifest != "" {
		if text := boundedLowerFile(officeManifest, 512<<10); strings.Contains(text, "officeapp") || strings.Contains(text, "office.addin") || strings.Contains(text, "office/manifest") {
			host := "office"
			if strings.Contains(text, "presentation") || strings.Contains(text, "powerpoint") {
				host = "powerpoint"
			}
			add("office-addin", "Microsoft Office add-in", filepath.ToSlash(filepath.Join(".", filepath.Base(officeManifest))), host)
		}
	}
	if hasAnyFile(dir, "shopify.app.toml", "shopify.extension.toml") || hasAnyDir(dir, "extensions") && hasShopifyDependency(dir) {
		add("shopify-plugin", "Shopify app or extension", firstExistingProjectSignal(dir, "shopify.app.toml", "shopify.extension.toml", "package.json"), "shopify")
	}
	if pkg := readPkgJSON(dir); pkg.present && pkg.Name != "" && pkg.PublishConfig {
		add("npm-package", "npm package", "package.json:publishConfig", "npm")
	}
	if hasFigmaDependency(dir) || strings.Contains(boundedLowerFile(filepath.Join(dir, "manifest.json"), 256<<10), "figma") {
		add("figma-plugin", "Figma plugin", "package.json:figma", "figma")
	}
	if text := boundedLowerFile(filepath.Join(dir, "manifest.json"), 256<<10); strings.Contains(text, "manifest_version") && (strings.Contains(text, "content_scripts") || strings.Contains(text, "background")) {
		add("chrome-extension", "Chrome extension", "manifest.json:manifest_version", "chrome")
	}

	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func productDeployTargets(id string) []string {
	switch id {
	case "office-addin":
		return []string{"powerpoint"}
	case "shopify-plugin":
		return []string{"shopify"}
	case "figma-plugin":
		return []string{"figma"}
	case "chrome-extension":
		return []string{"chrome-web-store"}
	case "npm-package":
		return []string{"npm"}
	default:
		return nil
	}
}

func productAdapter(id string) []string {
	switch id {
	case "office-addin":
		return []string{"office-powerpoint"}
	case "shopify-plugin":
		return []string{"shopify"}
	case "figma-plugin":
		return []string{"figma"}
	case "npm-package":
		return []string{"npm"}
	default:
		return nil
	}
}

func hasShopifyDependency(dir string) bool {
	pkg := readPkgJSON(dir)
	return pkg.hasDep("@shopify/shopify-api") || pkg.hasDep("@shopify/app-bridge") || pkg.hasDep("@shopify/polaris")
}

func hasFigmaDependency(dir string) bool {
	pkg := readPkgJSON(dir)
	return pkg.hasDep("@figma/plugin-typings") || pkg.hasDep("figma")
}

func firstProjectFile(dir string, names ...string) string {
	for _, name := range names {
		path := filepath.Join(dir, name)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path
		}
	}
	return ""
}

func firstExistingProjectSignal(dir string, names ...string) string {
	for _, name := range names {
		if firstProjectFile(dir, name) != "" || isDir(filepath.Join(dir, name)) {
			return name
		}
	}
	return "project marker"
}

func hasAnyFile(dir string, names ...string) bool { return firstProjectFile(dir, names...) != "" }

func hasAnyDir(dir string, names ...string) bool {
	for _, name := range names {
		if isDir(filepath.Join(dir, name)) {
			return true
		}
	}
	return false
}

func boundedLowerFile(path string, max int64) string {
	if path == "" {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	b := make([]byte, max)
	n, err := f.Read(b)
	if err != nil && n == 0 {
		return ""
	}
	return strings.ToLower(string(b[:n]))
}
