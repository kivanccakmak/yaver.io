package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Task lifecycle synchronization must happen before the ordinary batch dedup
// return. It is the only cross-device session roster; the superseded tmux
// ledger must not add a second mutation or publish terminal names.
func TestTaskSyncRunsBeforeBatchDedupWithoutLegacyTmuxSync(t *testing.T) {
	raw, err := os.ReadFile("convex_state_sync.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	start := strings.Index(src, "func (s *convexSyncer) syncAll")
	if start < 0 {
		t.Fatal("syncAll not found")
	}
	body := src[start:]
	if end := strings.Index(body, "func (s *convexSyncer) syncLifecycleState"); end >= 0 {
		body = body[:end]
	}
	lifecycleAt := strings.Index(body, "s.syncLifecycleState(ctx)")
	dedupAt := strings.Index(body, "if skip {")
	if lifecycleAt < 0 || dedupAt < 0 || lifecycleAt > dedupAt {
		t.Fatalf("task lifecycle sync must precede batch dedup: lifecycle=%d dedup=%d", lifecycleAt, dedupAt)
	}
	lifecycleStart := strings.Index(src, "func (s *convexSyncer) syncLifecycleState")
	if lifecycleStart < 0 {
		t.Fatal("syncLifecycleState not found")
	}
	lifecycleBody := src[lifecycleStart:]
	if strings.Contains(strings.SplitN(lifecycleBody, "\n}\n", 2)[0], "syncTmuxSessionsToConvex") {
		t.Fatal("legacy tmux ledger remains in the active lifecycle sync path")
	}
	if !strings.Contains(lifecycleBody, "syncTaskSnapshotToConvex(ctx, s.taskMgr)") {
		t.Fatal("task snapshot sync missing from lifecycle path")
	}
}

// The "which project is on which machine" seeding contract (2026-08-09):
// the agent pushes a per-device runtime project catalog to Convex so web +
// mobile can answer that question without fanning out to every box. The
// catalog must be TOP-LEVEL only (a nested clone inside another repo is not
// a pickable project) and each entry must carry its git provider identity.

func TestDeriveGitProviderIdentity(t *testing.T) {
	cases := []struct {
		remote   string
		wantRepo string
		wantProv string
	}{
		{"git@github.com:yaver-io/yaver.io.git", "yaver.io", "github"},
		{"https://github.com/kivanccakmak/talos.git", "talos", "github"},
		{"git@gitlab.com:kivanccakmak/sfmg", "sfmg", "gitlab"},
		{"https://gitlab.com/kivanccakmak/medici.ai.git", "medici.ai", "gitlab"},
		{"https://gitlab.com/group/subgroup/project.git", "project", "gitlab"},
		// SSH over https:// with a token — credentials must never leak into
		// the provider or repo name.
		{"https://token@github.com/owner/repo.git", "repo", "github"},
		{"ssh://git@bitbucket.org/team/app", "app", "bitbucket.org"},
		{"git@selfhosted.example.com:team/tool.git", "tool", "selfhosted.example.com"},
	}
	for _, tc := range cases {
		repo, prov := deriveGitProviderIdentity(tc.remote, "fallback")
		if repo != tc.wantRepo || prov != tc.wantProv {
			t.Fatalf("deriveGitProviderIdentity(%q) = (%q, %q), want (%q, %q)",
				tc.remote, repo, prov, tc.wantRepo, tc.wantProv)
		}
	}
}

func TestDeriveGitProviderIdentityFallsBackToName(t *testing.T) {
	repo, prov := deriveGitProviderIdentity("git@github.com:", "medici.ai")
	if repo != "medici.ai" {
		t.Fatalf("unparseable remote path must fall back to the dir name, got %q", repo)
	}
	if prov != "github" {
		t.Fatalf("provider must still derive from the host, got %q", prov)
	}
}

// mkRealGitRepo creates a real git repo (so DetectProjectInfo can read the
// origin remote + branch) with a fake origin URL. The branch depends on the
// host's init.defaultBranch, so tests never assert on it.
func mkRealGitRepo(t *testing.T, base string, parts ...string) string {
	t.Helper()
	dir := filepath.Join(append([]string{base}, parts...)...)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v\n%s", args, err, out)
		}
	}
	git("init", "-q")
	git("-c", "user.email=test@test", "-c", "user.name=test", "commit", "--allow-empty", "-q", "-m", "init")
	return dir
}

func setRemote(t *testing.T, dir, remote string) {
	t.Helper()
	cmd := exec.Command("git", "-C", dir, "remote", "add", "origin", remote)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git remote add failed: %v\n%s", err, out)
	}
}

// writeProjectsFile seeds PROJECTS.md under the temp HOME so
// listDiscoveredProjects sees exactly the given repo dirs.
func writeProjectsFile(t *testing.T, dirs []string) {
	t.Helper()
	fp, err := projectsFilePath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(fp), 0o755); err != nil {
		t.Fatal(err)
	}
	var sb string
	for _, d := range dirs {
		sb += "### " + d + "\n- Branch: main\n"
	}
	if err := os.WriteFile(fp, []byte(sb), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The batch payload must carry the catalog, and the catalog must be built
// from the same TOP-LEVEL collapse as /projects — a nested clone
// (yaver.io/mobile inside yaver.io) must never be seeded as its own machine
// project.
func TestBuildRuntimeProjectCatalogTopLevelOnly(t *testing.T) {
	home := withHome(t)
	ws := filepath.Join(home, "Workspace")
	top := mkRealGitRepo(t, ws, "yaver.io")
	nested := mkRealGitRepo(t, ws, "yaver.io", "mobile")
	setRemote(t, top, "git@github.com:yaver-io/yaver.io.git")
	setRemote(t, nested, "git@github.com:yaver-io/yaver.io.git")
	writeProjectsFile(t, []string{top, nested})

	catalog := buildRuntimeProjectCatalog()
	byRepo := map[string]map[string]interface{}{}
	for _, row := range catalog {
		byRepo[row["repoName"].(string)] = row
	}
	if _, ok := byRepo["mobile"]; ok {
		t.Fatalf("nested clone yaver.io/mobile leaked into the catalog: %v", catalog)
	}
	root, ok := byRepo["yaver.io"]
	if !ok {
		t.Fatalf("top-level yaver.io missing from catalog: %v", catalog)
	}
	if root["gitProvider"] != "github" {
		t.Fatalf("gitProvider must be derived from the remote, got %q", root["gitProvider"])
	}
	if root["gitRemote"] != "git@github.com:yaver-io/yaver.io.git" {
		t.Fatalf("gitRemote must be preserved verbatim, got %q", root["gitRemote"])
	}
}

// A repo with no origin remote has no provider identity and must be skipped —
// seeding a pathless/identity-less row would pollute the catalog.
func TestBuildRuntimeProjectCatalogSkipsReposWithoutRemote(t *testing.T) {
	home := withHome(t)
	ws := filepath.Join(home, "Workspace")
	repo := mkRealGitRepo(t, ws, "local-only")
	writeProjectsFile(t, []string{repo})

	catalog := buildRuntimeProjectCatalog()
	for _, row := range catalog {
		if row["repoName"] == "local-only" {
			t.Fatalf("repo without an origin remote must not be seeded: %v", catalog)
		}
	}
}

// The batch payload carries the catalog so the Convex seeding has data, and
// the per-device identity (deviceId) rides the same payload.
func TestBatchPayloadIncludesRuntimeProjectCatalog(t *testing.T) {
	home := withHome(t)
	ws := filepath.Join(home, "Workspace")
	repo := mkRealGitRepo(t, ws, "talos")
	setRemote(t, repo, "git@gitlab.com:kivanccakmak/talos.git")
	writeProjectsFile(t, []string{repo})

	s := &convexSyncer{deviceID: "box-1"}
	payload, err := s.buildBatchPayload()
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		t.Fatal(err)
	}
	catalog, ok := parsed["runtimeProjectCatalog"].([]interface{})
	if !ok || len(catalog) == 0 {
		t.Fatalf("batch payload must carry runtimeProjectCatalog; got %v", parsed)
	}
	row := catalog[0].(map[string]interface{})
	if row["repoName"] != "talos" || row["gitProvider"] != "gitlab" {
		t.Fatalf("catalog row missing provider identity: %v", row)
	}
}

// The MCP catalog is the cross-machine answer to "which MCP server lives on
// which machine" — web chat + mobile composers render it. Privacy contract:
// name/url/toolCount only, NEVER the auth token.
func TestBuildMCPCatalogIncludesEnabledServersNoTokens(t *testing.T) {
	resetExternalMCPCacheForTest()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, configDirName), 0o700); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	if err := SaveConfig(&Config{
		ExternalMCPServers: []ExternalMCPServer{
			{Name: "sentry", URL: "https://mcp.example/sentry", AuthToken: "super-secret", Enabled: true},
			{Name: "github", URL: "https://mcp.example/github", Enabled: true},
			{Name: "retired", URL: "https://mcp.example/retired", Enabled: false},
		},
	}); err != nil {
		t.Fatalf("seed config: %v", err)
	}
	// Warm the tools cache for one server so toolCount rides the row.
	extMCPCache.Store("sentry", &extToolEntry{
		at:    time.Now(),
		tools: []map[string]interface{}{{"name": "a"}, {"name": "b"}},
	})

	catalog := buildMCPCatalog()
	byName := map[string]map[string]interface{}{}
	for _, row := range catalog {
		byName[row["name"].(string)] = row
	}
	if _, ok := byName["retired"]; ok {
		t.Fatalf("disabled MCP server leaked into the catalog: %v", catalog)
	}
	for _, name := range []string{"sentry", "github"} {
		row, ok := byName[name]
		if !ok {
			t.Fatalf("enabled MCP server %q missing from catalog: %v", name, catalog)
		}
		if row["url"] == "" || row["enabled"] != true {
			t.Fatalf("row %q missing url/enabled: %v", name, row)
		}
		if _, leaked := row["auth_token"]; leaked {
			t.Fatalf("auth_token LEAKED into the catalog for %q: %v", name, row)
		}
		if _, leaked := row["authToken"]; leaked {
			t.Fatalf("authToken LEAKED into the catalog for %q: %v", name, row)
		}
	}
	if got := byName["sentry"]["toolCount"]; got != 2 {
		t.Fatalf("toolCount for sentry = %v, want 2 (from warm cache)", got)
	}
	if _, ok := byName["github"]["toolCount"]; ok {
		t.Fatalf("uncached server must omit toolCount, got %v", byName["github"])
	}
}

// The batch payload carries the MCP catalog with the device identity, and
// must NEVER include the auth token even when the source config has one.
func TestBatchPayloadIncludesMCPCatalogNoTokens(t *testing.T) {
	resetExternalMCPCacheForTest()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, configDirName), 0o700); err != nil {
		t.Fatalf("mkdir config dir: %v", err)
	}
	if err := SaveConfig(&Config{
		ExternalMCPServers: []ExternalMCPServer{{
			Name: "bet", URL: "https://mcp.example/bet", AuthToken: "hunter2", Enabled: true,
		}},
	}); err != nil {
		t.Fatalf("seed config: %v", err)
	}

	s := &convexSyncer{deviceID: "box-1"}
	payload, err := s.buildBatchPayload()
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		t.Fatal(err)
	}
	raw := string(payload)
	if strings.Contains(raw, "hunter2") || strings.Contains(raw, "auth_token") {
		t.Fatalf("batch payload leaks MCP auth material: %s", raw)
	}
	catalog, ok := parsed["mcpCatalog"].([]interface{})
	if !ok || len(catalog) == 0 {
		t.Fatalf("batch payload must carry mcpCatalog; got %v", parsed)
	}
	row := catalog[0].(map[string]interface{})
	if row["name"] != "bet" || row["enabled"] != true {
		t.Fatalf("catalog row missing name/enabled: %v", row)
	}
}
