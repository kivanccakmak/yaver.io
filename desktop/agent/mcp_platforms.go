package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	osexec "os/exec"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Supabase — wraps supabase CLI
// ---------------------------------------------------------------------------

func mcpSupabaseStatus(dir string) interface{} {
	return supabaseRun(dir, "status")
}

func mcpSupabaseDB(dir, query string) interface{} {
	return supabaseRun(dir, "db", "execute", "--sql", query)
}

func mcpSupabaseMigrations(dir string) interface{} {
	return supabaseRun(dir, "migration", "list")
}

func mcpSupabaseFunctions(dir string) interface{} {
	return supabaseRun(dir, "functions", "list")
}

func mcpSupabaseDeploy(dir, function string) interface{} {
	if function != "" {
		return supabaseRun(dir, "functions", "deploy", function)
	}
	return supabaseRun(dir, "db", "push")
}

func supabaseRun(dir string, args ...string) interface{} {
	cmd := osexec.Command("supabase", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("supabase: %s (install: brew install supabase/tap/supabase)", err), "output": string(out)}
	}
	return map[string]interface{}{"output": string(out)}
}

// ---------------------------------------------------------------------------
// Convex — wraps npx convex CLI
// ---------------------------------------------------------------------------

func mcpConvexStatus(dir string) interface{} {
	return convexRun(dir, "dashboard")
}

func mcpConvexDeploy(dir string) interface{} {
	return convexRun(dir, "deploy", "--yes")
}

func mcpConvexLogs(dir string) interface{} {
	return convexRun(dir, "logs", "--success", "--limit", "20")
}

func mcpConvexFunctions(dir string) interface{} {
	return convexRun(dir, "functions", "list")
}

func mcpConvexRun(dir, functionPath, argsJSON string) interface{} {
	cliArgs := []string{"run", functionPath}
	if argsJSON != "" {
		cliArgs = append(cliArgs, argsJSON)
	}
	return convexRun(dir, cliArgs...)
}

func convexRun(dir string, args ...string) interface{} {
	allArgs := append([]string{"convex"}, args...)
	cmd := osexec.Command("npx", allArgs...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("convex: %s", err), "output": string(out)}
	}
	return map[string]interface{}{"output": string(out)}
}

// ---------------------------------------------------------------------------
// Cloudflare — wraps wrangler CLI
// ---------------------------------------------------------------------------

func mcpCFWorkers(dir string) interface{} {
	return wranglerRun(dir, "deployments", "list")
}

func mcpCFDeploy(dir string) interface{} {
	return wranglerRun(dir, "deploy")
}

func mcpCFTail(dir, workerName string) interface{} {
	// Get recent logs (non-interactive)
	return wranglerRun(dir, "tail", workerName, "--format", "json", "--once")
}

func mcpCFPages(dir string) interface{} {
	return wranglerRun(dir, "pages", "deployment", "list")
}

func mcpCFR2(action, bucket, key string) interface{} {
	switch action {
	case "list":
		return wranglerRun("", "r2", "object", "list", bucket)
	case "buckets":
		return wranglerRun("", "r2", "bucket", "list")
	default:
		return map[string]interface{}{"error": "action: list, buckets"}
	}
}

func mcpCFD1(action, dbName, query string) interface{} {
	switch action {
	case "list":
		return wranglerRun("", "d1", "list")
	case "query":
		return wranglerRun("", "d1", "execute", dbName, "--command", query)
	default:
		return map[string]interface{}{"error": "action: list, query"}
	}
}

func mcpCFKV(action, namespace, key, value string) interface{} {
	switch action {
	case "list":
		return wranglerRun("", "kv", "namespace", "list")
	case "keys":
		return wranglerRun("", "kv", "key", "list", "--namespace-id", namespace)
	case "get":
		return wranglerRun("", "kv", "key", "get", "--namespace-id", namespace, key)
	case "put":
		return wranglerRun("", "kv", "key", "put", "--namespace-id", namespace, key, value)
	default:
		return map[string]interface{}{"error": "action: list, keys, get, put"}
	}
}

func mcpCFDNS(zone, action, name, dnsType, content string) interface{} {
	switch action {
	case "list":
		return wranglerRun("", "dns", "records", "list", zone)
	default:
		return map[string]interface{}{"error": "action: list"}
	}
}

func wranglerRun(dir string, args ...string) interface{} {
	allArgs := append([]string{"wrangler"}, args...)
	cmd := osexec.Command("npx", allArgs...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("wrangler: %s (install: npm install -g wrangler)", err), "output": string(out)}
	}
	return map[string]interface{}{"output": string(out)}
}

// ---------------------------------------------------------------------------
// GitLab — wraps glab CLI
// ---------------------------------------------------------------------------

func mcpGitLabMRs(dir, state string) interface{} {
	if state == "" {
		state = "opened"
	}
	args := []string{"mr", "list", "--state", state}
	return glabRun(dir, args...)
}

func mcpGitLabIssues(dir, state string) interface{} {
	if state == "" {
		state = "opened"
	}
	return glabRun(dir, "issue", "list", "--state", state)
}

func mcpGitLabPipelines(dir string) interface{} {
	return glabRun(dir, "ci", "list")
}

func mcpGitLabPipelineJobs(dir, pipelineID string) interface{} {
	return glabRun(dir, "ci", "view", pipelineID)
}

func mcpGitLabCI(dir string) interface{} {
	return glabRun(dir, "ci", "status")
}

func glabRun(dir string, args ...string) interface{} {
	cmd := osexec.Command("glab", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("glab: %s (install: brew install glab)", err), "output": string(out)}
	}
	return map[string]interface{}{"output": string(out)}
}

// ---------------------------------------------------------------------------
// GitHub CLI extras — beyond what we already have
// ---------------------------------------------------------------------------

func mcpGitHubRepoInfo(dir string) interface{} {
	cmd := osexec.Command("gh", "repo", "view", "--json", "name,owner,description,stargazerCount,forkCount,isPrivate,defaultBranchRef,languages,licenseInfo,url")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": string(out)}
	}
	var result interface{}
	json.Unmarshal(out, &result)
	return result
}

func mcpGitHubReleases(dir string) interface{} {
	cmd := osexec.Command("gh", "release", "list", "--json", "tagName,name,publishedAt,isDraft,isPrerelease", "--limit", "10")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": string(out)}
	}
	var result interface{}
	json.Unmarshal(out, &result)
	return map[string]interface{}{"releases": result}
}

func mcpGitHubStargazers(repo string) interface{} {
	out, err := runCmd("gh", "api", fmt.Sprintf("repos/%s", repo), "--jq", ".stargazers_count")
	if err != nil {
		return map[string]interface{}{"error": out}
	}
	return map[string]interface{}{"repo": repo, "stars": strings.TrimSpace(out)}
}

// ---------------------------------------------------------------------------
// PlanetScale — wraps pscale CLI
// ---------------------------------------------------------------------------

func mcpPlanetScaleBranches(db string) interface{} {
	out, err := runCmd("pscale", "branch", "list", db, "--format", "json")
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("pscale: %s (install: brew install planetscale/tap/pscale)", out)}
	}
	var result interface{}
	json.Unmarshal([]byte(out), &result)
	return result
}

func mcpPlanetScaleDeploy(db, branch string) interface{} {
	out, err := runCmd("pscale", "deploy-request", "create", db, branch)
	if err != nil {
		return map[string]interface{}{"error": out}
	}
	return map[string]interface{}{"output": out}
}

// ---------------------------------------------------------------------------
// Prisma — wraps prisma CLI
// ---------------------------------------------------------------------------

func mcpPrismaStatus(dir string) interface{} {
	cmd := osexec.Command("npx", "prisma", "migrate", "status")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": string(out)}
	}
	return map[string]interface{}{"output": string(out)}
}

func mcpPrismaGenerate(dir string) interface{} {
	cmd := osexec.Command("npx", "prisma", "generate")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": string(out)}
	}
	return map[string]interface{}{"ok": true, "output": string(out)}
}

func mcpPrismaPush(dir string) interface{} {
	cmd := osexec.Command("npx", "prisma", "db", "push")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": string(out)}
	}
	return map[string]interface{}{"ok": true, "output": string(out)}
}

// ---------------------------------------------------------------------------
// Drizzle ORM
// ---------------------------------------------------------------------------

func mcpDrizzlePush(dir string) interface{} {
	cmd := osexec.Command("npx", "drizzle-kit", "push")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": string(out)}
	}
	return map[string]interface{}{"ok": true, "output": string(out)}
}

func mcpDrizzleGenerate(dir string) interface{} {
	cmd := osexec.Command("npx", "drizzle-kit", "generate")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": string(out)}
	}
	return map[string]interface{}{"ok": true, "output": string(out)}
}

// ---------------------------------------------------------------------------
// Fly.io — wraps flyctl
// ---------------------------------------------------------------------------

func mcpFlyStatus(dir string) interface{} {
	cmd := osexec.Command("flyctl", "status", "--json")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("flyctl: %s", string(out))}
	}
	var result interface{}
	json.Unmarshal(out, &result)
	return result
}

func mcpFlyDeploy(dir string) interface{} {
	cmd := osexec.Command("flyctl", "deploy")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": string(out)}
	}
	return map[string]interface{}{"ok": true, "output": string(out)}
}

func mcpFlyLogs(appName string) interface{} {
	out, err := runCmd("flyctl", "logs", "--app", appName, "--no-tail")
	if err != nil {
		return map[string]interface{}{"error": out}
	}
	return map[string]interface{}{"logs": out}
}

// ---------------------------------------------------------------------------
// Railway — wraps railway CLI
// ---------------------------------------------------------------------------

func mcpRailwayStatus(dir string) interface{} {
	cmd := osexec.Command("railway", "status", "--json")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("railway: %s", string(out))}
	}
	var result interface{}
	json.Unmarshal(out, &result)
	return result
}

func mcpRailwayDeploy(dir string) interface{} {
	cmd := osexec.Command("railway", "up")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": err.Error(), "output": string(out)}
	}
	return map[string]interface{}{"ok": true, "output": string(out)}
}

// Unused import guard
var _ = http.StatusOK
var _ = io.Discard
var _ = time.Now
