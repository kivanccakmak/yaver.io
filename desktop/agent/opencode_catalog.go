package main

// OpenCode owns its provider/model catalog. Yaver deliberately does not copy
// that release data into mobile/web/tvOS: the agent reads OpenCode's own
// models.dev cache for provider discovery and probes `opencode models` for the
// models this exact machine can currently use. The former powers Settings;
// the latter powers task pickers. Both remain machine-scoped and secrets never
// leave OpenCode's auth store.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	osexec "os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	openCodeModelProbeTimeout = 6 * time.Second
	openCodeModelProbeTTL     = 30 * time.Second
	openCodeModelOutputLimit  = 4 << 20
)

type openCodeModelsDevModel struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type openCodeModelsDevProvider struct {
	ID     string                            `json:"id"`
	Name   string                            `json:"name"`
	Env    []string                          `json:"env"`
	API    string                            `json:"api"`
	Doc    string                            `json:"doc"`
	Models map[string]openCodeModelsDevModel `json:"models"`
}

var openCodeModelProbeCache struct {
	sync.Mutex
	expires time.Time
	models  []OpenCodeModelSummary
}

func preferredOpenCodeModelsCachePath() string {
	if path := strings.TrimSpace(os.Getenv("OPENCODE_MODELS_CACHE")); path != "" {
		return path
	}
	cacheDir, err := os.UserCacheDir()
	if err != nil || strings.TrimSpace(cacheDir) == "" {
		home, _ := os.UserHomeDir()
		cacheDir = filepath.Join(home, ".cache")
	}
	return filepath.Join(cacheDir, "opencode", "models.json")
}

// loadOpenCodeCatalogProviders reads the public catalog cached by OpenCode.
// With an empty providerID it returns provider metadata only, keeping the
// remote Settings index small. A providerID returns that provider's models on
// demand so 4 GB boxes and mobile relay links never carry the full catalog.
func loadOpenCodeCatalogProviders(providerID string) ([]OpenCodeProviderSummary, error) {
	raw, err := os.ReadFile(preferredOpenCodeModelsCachePath())
	if err != nil {
		return nil, err
	}
	var database map[string]json.RawMessage
	if err := json.Unmarshal(raw, &database); err != nil {
		return nil, fmt.Errorf("parse OpenCode models cache: %w", err)
	}
	wanted := strings.TrimSpace(providerID)
	ids := make([]string, 0, len(database))
	if wanted != "" {
		if _, ok := database[wanted]; !ok {
			return nil, fmt.Errorf("OpenCode provider %q not found", wanted)
		}
		ids = append(ids, wanted)
	} else {
		for id := range database {
			ids = append(ids, id)
		}
		sort.Strings(ids)
	}
	auth := openCodeAuthProviderKeySet()
	out := make([]OpenCodeProviderSummary, 0, len(ids))
	for _, id := range ids {
		var entry openCodeModelsDevProvider
		if err := json.Unmarshal(database[id], &entry); err != nil {
			continue
		}
		row := OpenCodeProviderSummary{
			ID:               id,
			Name:             entry.Name,
			BaseURL:          entry.API,
			EnvironmentKeys:  append([]string(nil), entry.Env...),
			DocumentationURL: entry.Doc,
			HasAPIKey:        auth[id],
			IsBuiltin:        true,
			Source:           "models.dev",
		}
		for _, envName := range entry.Env {
			if strings.TrimSpace(os.Getenv(envName)) != "" {
				row.HasAPIKey = true
				break
			}
		}
		if wanted != "" {
			modelIDs := make([]string, 0, len(entry.Models))
			for modelID := range entry.Models {
				modelIDs = append(modelIDs, modelID)
			}
			sort.Strings(modelIDs)
			row.Models = make([]OpenCodeModelSummary, 0, len(modelIDs))
			for _, modelID := range modelIDs {
				model := entry.Models[modelID]
				idOnWire := strings.TrimSpace(model.ID)
				if idOnWire == "" {
					idOnWire = modelID
				}
				fullID := idOnWire
				if !strings.HasPrefix(fullID, id+"/") {
					fullID = id + "/" + fullID
				}
				row.Models = append(row.Models, OpenCodeModelSummary{
					ID:          fullID,
					Name:        firstNonEmpty(model.Name, modelID),
					Description: model.Description,
					Provider:    id,
					Source:      "models.dev",
				})
			}
		}
		out = append(out, row)
	}
	return out, nil
}

func invalidateOpenCodeModelProbe() {
	openCodeModelProbeCache.Lock()
	openCodeModelProbeCache.expires = time.Time{}
	openCodeModelProbeCache.models = nil
	openCodeModelProbeCache.Unlock()
}

func projectOpenCodeRunnerModels(active, configured []OpenCodeModelSummary, backend []runnerModelInfo, defaultModel string) []runnerModelInfo {
	source := active
	if len(source) == 0 {
		source = configured
	}
	if len(source) == 0 {
		return nil
	}
	backendByID := make(map[string]runnerModelInfo, len(backend))
	for _, model := range backend {
		backendByID[model.ID] = model
	}
	configuredByID := make(map[string]OpenCodeModelSummary, len(configured))
	for _, model := range configured {
		configuredByID[model.ID] = model
	}
	rows := make([]runnerModelInfo, 0, len(source))
	for _, model := range source {
		row := runnerModelInfo{
			ID:        model.ID,
			Name:      model.Name,
			Provider:  model.Provider,
			Source:    model.Source,
			IsDefault: model.IsDefault || model.ID == defaultModel,
		}
		if configuredModel, ok := configuredByID[model.ID]; ok {
			if configuredModel.Name != "" {
				row.Name = configuredModel.Name
			}
			if configuredModel.Provider != "" {
				row.Provider = configuredModel.Provider
			}
		}
		if metadata, ok := backendByID[model.ID]; ok {
			row.Name = firstNonEmpty(metadata.Name, row.Name)
			row.Description = metadata.Description
			row.Provider = firstNonEmpty(metadata.Provider, row.Provider)
			row.ProviderName = metadata.ProviderName
			row.Lifecycle = metadata.Lifecycle
		}
		// The selected machine's OpenCode config is authoritative once it
		// names a default. Convex's catalog default is only a bootstrap choice;
		// it must not leave two models marked default after a user changes it.
		if defaultModel != "" {
			row.IsDefault = model.ID == defaultModel
		}
		if row.Provider == "" {
			row.Provider, _, _ = strings.Cut(row.ID, "/")
		}
		if row.Name == "" {
			_, row.Name, _ = strings.Cut(row.ID, "/")
		}
		rows = append(rows, row)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].IsDefault != rows[j].IsDefault {
			return rows[i].IsDefault
		}
		if rows[i].Provider != rows[j].Provider {
			return rows[i].Provider < rows[j].Provider
		}
		return rows[i].Name < rows[j].Name
	})
	return rows
}

// probeOpenCodeModels asks the installed CLI instead of treating a config row
// or API-key environment variable as proof. OpenCode applies its own provider
// integration, credentials, policy, and project/global config before printing
// one provider/model ID per line. The short cache prevents concurrent Settings
// surfaces from fighting over OpenCode's own model-cache database lock.
func probeOpenCodeModels(parent context.Context) ([]OpenCodeModelSummary, error) {
	openCodeModelProbeCache.Lock()
	defer openCodeModelProbeCache.Unlock()
	if time.Now().Before(openCodeModelProbeCache.expires) {
		return append([]OpenCodeModelSummary(nil), openCodeModelProbeCache.models...), nil
	}
	path, err := osexec.LookPath("opencode")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(parent, openCodeModelProbeTimeout)
	defer cancel()
	output, err := osexec.CommandContext(ctx, path, "models", "--pure").Output()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, fmt.Errorf("opencode models timed out after %s", openCodeModelProbeTimeout)
	}
	if err != nil {
		return nil, fmt.Errorf("opencode models: %w", err)
	}
	if len(output) > openCodeModelOutputLimit {
		return nil, fmt.Errorf("opencode models returned more than %d bytes", openCodeModelOutputLimit)
	}
	seen := map[string]bool{}
	models := make([]OpenCodeModelSummary, 0)
	for _, line := range strings.Split(string(output), "\n") {
		id := strings.TrimSpace(line)
		provider, modelID, ok := strings.Cut(id, "/")
		if !ok || provider == "" || modelID == "" || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, OpenCodeModelSummary{
			ID:       id,
			Name:     modelID,
			Provider: provider,
			Source:   "opencode-cli",
		})
	}
	if len(models) == 0 {
		return nil, errors.New("opencode models returned no selectable models")
	}
	openCodeModelProbeCache.models = append([]OpenCodeModelSummary(nil), models...)
	openCodeModelProbeCache.expires = time.Now().Add(openCodeModelProbeTTL)
	return models, nil
}

func mergeOpenCodeModels(defaultModel string, groups ...[]OpenCodeModelSummary) []OpenCodeModelSummary {
	seen := map[string]OpenCodeModelSummary{}
	order := make([]string, 0)
	for _, group := range groups {
		for _, model := range group {
			id := strings.TrimSpace(model.ID)
			if id == "" {
				continue
			}
			if existing, ok := seen[id]; ok {
				if model.Name != "" && (existing.Name == "" || existing.Name == strings.TrimPrefix(id, existing.Provider+"/")) {
					existing.Name = model.Name
				}
				if model.Description != "" {
					existing.Description = model.Description
				}
				if model.Provider != "" {
					existing.Provider = model.Provider
				}
				if model.Source != "" {
					existing.Source = model.Source
				}
				seen[id] = existing
				continue
			}
			seen[id] = model
			order = append(order, id)
		}
	}
	if defaultModel != "" {
		if row, ok := seen[defaultModel]; ok {
			row.IsDefault = true
			seen[defaultModel] = row
		}
	}
	sort.SliceStable(order, func(i, j int) bool {
		left, right := seen[order[i]], seen[order[j]]
		if left.IsDefault != right.IsDefault {
			return left.IsDefault
		}
		if left.Provider != right.Provider {
			return left.Provider < right.Provider
		}
		return left.Name < right.Name
	})
	out := make([]OpenCodeModelSummary, 0, len(order))
	for _, id := range order {
		out = append(out, seen[id])
	}
	return out
}

func enrichOpenCodeConfigSummary(ctx context.Context, summary OpenCodeConfigSummary) OpenCodeConfigSummary {
	active, err := probeOpenCodeModels(ctx)
	if err != nil || len(active) == 0 {
		return summary
	}
	// When the user has not chosen a machine-local model yet, mark the current
	// Convex/Yaver default in the live list. This is display metadata only; it
	// does not mutate opencode.json and updates as soon as Convex changes.
	defaultModel := firstNonEmpty(summary.Model, yaverDefaultModelForRunner("opencode"))
	summary.Models = mergeOpenCodeModels(defaultModel, active, summary.Models)
	providerByID := make(map[string]OpenCodeProviderSummary, len(summary.Providers))
	for _, provider := range summary.Providers {
		providerByID[provider.ID] = provider
	}
	catalog, _ := loadOpenCodeCatalogProviders("")
	catalogByID := make(map[string]OpenCodeProviderSummary, len(catalog))
	for _, provider := range catalog {
		catalogByID[provider.ID] = provider
	}
	for _, model := range active {
		providerID := model.Provider
		if providerID == "" {
			providerID, _, _ = strings.Cut(model.ID, "/")
		}
		if providerID == "" {
			continue
		}
		provider := providerByID[providerID]
		if provider.ID == "" {
			provider = catalogByID[providerID]
			provider.ID = providerID
			providerByID[providerID] = provider
		}
	}
	ids := make([]string, 0, len(providerByID))
	for id := range providerByID {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	summary.Providers = make([]OpenCodeProviderSummary, 0, len(ids))
	for _, id := range ids {
		provider := providerByID[id]
		provider.Models = nil // summary.Models is the compact active list
		summary.Providers = append(summary.Providers, provider)
	}
	return summary
}

func (s *HTTPServer) handleOpenCodeCatalog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}
	providerID := strings.TrimSpace(r.URL.Query().Get("provider"))
	providers, err := loadOpenCodeCatalogProviders(providerID)
	if err != nil {
		// A first OpenCode invocation normally creates/refreshes models.json.
		// Attempt the real operation once, then retry the public cache read.
		_, _ = probeOpenCodeModels(r.Context())
		providers, err = loadOpenCodeCatalogProviders(providerID)
	}
	if err != nil {
		jsonError(w, http.StatusServiceUnavailable, "OpenCode catalog unavailable: "+err.Error())
		return
	}
	jsonReply(w, http.StatusOK, map[string]any{
		"ok":        true,
		"source":    "opencode-models.dev",
		"providers": providers,
	})
}
