package main

// project_adapters.go — project-scoped MCP/adapter policy.
//
// The agent's built-in Yaver MCP stays small. A project may declare the
// external adapters it needs in .yaver/project.yaml, but the declaration only
// names adapters. The endpoint, auth token, and installation state remain
// local to the agent. Required adapters are added to a task at launch;
// optional adapters require an explicit task selection; disabled adapters are
// always removed. This is deliberately resolved at runner launch rather than
// agent boot so an idle machine does not start or enumerate unrelated MCPs.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var projectAdapterNameRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)

type projectAdapterSelection struct {
	Servers []string            `json:"servers"`
	Allow   map[string][]string `json:"allow,omitempty"`
}

// projectAdapterPolicy returns the canonical adapters block. Tools.MCP is a
// compatibility spelling so older/connected project descriptors can opt into
// the same behavior without maintaining a second schema.
func projectAdapterPolicy(m *ProjectManifest) *ProjectAdapterPolicy {
	if m == nil {
		return nil
	}
	if m.Adapters != nil {
		return m.Adapters
	}
	if m.Tools != nil {
		return m.Tools.MCP
	}
	return nil
}

func normalizeProjectAdapterNames(names []string) ([]string, error) {
	seen := map[string]bool{}
	out := make([]string, 0, len(names))
	for _, raw := range names {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		if !projectAdapterNameRE.MatchString(name) {
			return nil, fmt.Errorf("invalid adapter name %q", name)
		}
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out, nil
}

func validateProjectAdapterPolicy(policy *ProjectAdapterPolicy) error {
	if policy == nil {
		return nil
	}
	for label, names := range map[string][]string{
		"required": policy.Required,
		"optional": policy.Optional,
		"disabled": policy.Disabled,
	} {
		if _, err := normalizeProjectAdapterNames(names); err != nil {
			return fmt.Errorf("adapters.%s: %w", label, err)
		}
	}
	for adapter, tools := range policy.Allow {
		if _, err := normalizeProjectAdapterNames([]string{adapter}); err != nil {
			return fmt.Errorf("adapters.allow: %w", err)
		}
		for _, tool := range tools {
			if strings.TrimSpace(tool) == "" {
				return fmt.Errorf("adapters.allow[%s] contains an empty tool", adapter)
			}
		}
	}
	return nil
}

// projectMCPSelection resolves the project policy against a task's explicit
// external-MCP selection. It does not install anything and does not perform
// network calls. That makes it safe to use during task creation and lets the
// caller surface a missing local adapter as an actionable preflight later.
func projectMCPSelection(workDir string, explicit []string) (projectAdapterSelection, error) {
	detectedAdapters := []string{}
	if stack := stackDetect(workDir); stack != nil {
		// Stack detection may report a provider from a dependency alone. That
		// is useful profile information, but it must not silently activate an
		// external MCP; only config-proven providers are launch defaults.
		for _, target := range stack.Targets {
			if !target.Weak {
				detectedAdapters = append(detectedAdapters, target.ID)
			}
		}
		detectedAdapters = append(detectedAdapters, stack.Hosting...)
		detectedAdapters = append(detectedAdapters, productAdapterIDs(stack.Products)...)
	}
	manifest, err := LoadManifest(workDir)
	if err != nil {
		if isProjectManifestMissing(err) {
			policy := workspaceAdapterPolicyForDir(workDir)
			if policy == nil {
				return projectAdapterSelection{Servers: uniqueSortedStrings(append(detectedAdapters, explicit...))}, nil
			}
			manifest = &ProjectManifest{Adapters: policy}
		} else {
			return projectAdapterSelection{}, fmt.Errorf("read project adapter policy: %w", err)
		}
	}
	policy := projectAdapterPolicy(manifest)
	if policy == nil {
		policy = workspaceAdapterPolicyForDir(workDir)
	}
	if err := validateProjectAdapterPolicy(policy); err != nil {
		return projectAdapterSelection{}, err
	}
	if policy == nil {
		return projectAdapterSelection{Servers: uniqueSortedStrings(append(detectedAdapters, explicit...))}, nil
	}

	required, _ := normalizeProjectAdapterNames(policy.Required)
	disabled, _ := normalizeProjectAdapterNames(policy.Disabled)
	disabledSet := make(map[string]bool, len(disabled))
	for _, name := range disabled {
		disabledSet[name] = true
	}
	selected := append([]string{}, required...)
	// Detection supplies the project-native adapter suggestions (for example
	// supabase from supabase/config.toml or office-powerpoint from an Office
	// manifest). They are still filtered by the manifest's disabled list and
	// by the local adapter/server registry at injection time.
	selected = append(selected, detectedAdapters...)
	selected = append(selected, explicit...)
	selected = uniqueSortedStrings(selected)
	filtered := selected[:0]
	for _, name := range selected {
		if !disabledSet[name] {
			filtered = append(filtered, name)
		}
	}
	selected = filtered

	allow := map[string][]string{}
	for name, tools := range policy.Allow {
		if disabledSet[name] {
			continue
		}
		copyTools := append([]string{}, tools...)
		sort.Strings(copyTools)
		allow[name] = copyTools
	}
	return projectAdapterSelection{Servers: selected, Allow: allow}, nil
}

// workspaceAdapterPolicyForDir lets a monorepo keep app-specific adapter
// policy in yaver.workspace.yaml. The walk is bounded to the project and its
// parents; it never scans the user's home or the whole checkout.
func workspaceAdapterPolicyForDir(workDir string) *ProjectAdapterPolicy {
	abs, err := filepath.Abs(workDir)
	if err != nil || abs == "" {
		return nil
	}
	for i := 0; i < 8; i++ {
		manifest, err := LoadWorkspaceManifest(abs)
		if err == nil && manifest != nil {
			for _, app := range manifest.Apps {
				appPath := filepath.Clean(filepath.Join(abs, app.Path))
				if sameAbsolutePath(appPath, workDir) && app.Adapters != nil {
					return app.Adapters
				}
			}
		}
		parent := filepath.Dir(abs)
		if parent == abs {
			break
		}
		abs = parent
	}
	return nil
}

func sameAbsolutePath(a, b string) bool {
	aa, errA := filepath.Abs(a)
	bb, errB := filepath.Abs(b)
	if errA != nil || errB != nil {
		return false
	}
	return filepath.Clean(aa) == filepath.Clean(bb)
}

func uniqueSortedStrings(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value != "" && !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	sort.Strings(out)
	return out
}

func isProjectManifestMissing(err error) bool {
	return errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "no such file or directory") || strings.Contains(err.Error(), "cannot find the path")
}
