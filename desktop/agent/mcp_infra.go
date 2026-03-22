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
// Kubernetes — wraps kubectl (no API key, uses local kubeconfig)
// ---------------------------------------------------------------------------

func mcpK8sPods(namespace, context string) interface{} {
	args := kubectlArgs(namespace, context)
	args = append(args, "get", "pods", "-o", "wide")
	return kubectlRun(args)
}

func mcpK8sLogs(pod, namespace, context, container string, tail int) interface{} {
	args := kubectlArgs(namespace, context)
	args = append(args, "logs", pod)
	if container != "" {
		args = append(args, "-c", container)
	}
	if tail > 0 {
		args = append(args, "--tail", fmt.Sprintf("%d", tail))
	} else {
		args = append(args, "--tail", "100")
	}
	return kubectlRun(args)
}

func mcpK8sDescribe(resource, name, namespace, context string) interface{} {
	args := kubectlArgs(namespace, context)
	args = append(args, "describe", resource, name)
	return kubectlRun(args)
}

func mcpK8sGet(resource, namespace, context string) interface{} {
	args := kubectlArgs(namespace, context)
	args = append(args, "get", resource, "-o", "wide")
	return kubectlRun(args)
}

func mcpK8sApply(file, namespace, context string) interface{} {
	args := kubectlArgs(namespace, context)
	args = append(args, "apply", "-f", file)
	return kubectlRun(args)
}

func mcpK8sExec(pod, namespace, context, command, container string) interface{} {
	args := kubectlArgs(namespace, context)
	args = append(args, "exec", pod)
	if container != "" {
		args = append(args, "-c", container)
	}
	args = append(args, "--", "sh", "-c", command)
	return kubectlRun(args)
}

func mcpK8sContexts() interface{} {
	return kubectlRun([]string{"config", "get-contexts"})
}

func mcpK8sNamespaces(context string) interface{} {
	args := []string{}
	if context != "" {
		args = append(args, "--context", context)
	}
	args = append(args, "get", "namespaces")
	return kubectlRun(args)
}

func mcpK8sTopPods(namespace, context string) interface{} {
	args := kubectlArgs(namespace, context)
	args = append(args, "top", "pods")
	return kubectlRun(args)
}

func mcpK8sTopNodes(context string) interface{} {
	args := []string{}
	if context != "" {
		args = append(args, "--context", context)
	}
	args = append(args, "top", "nodes")
	return kubectlRun(args)
}

func mcpK8sEvents(namespace, context string) interface{} {
	args := kubectlArgs(namespace, context)
	args = append(args, "get", "events", "--sort-by=.lastTimestamp")
	return kubectlRun(args)
}

func kubectlArgs(namespace, context string) []string {
	args := []string{}
	if context != "" {
		args = append(args, "--context", context)
	}
	if namespace != "" {
		args = append(args, "-n", namespace)
	} else {
		args = append(args, "--all-namespaces")
	}
	return args
}

func kubectlRun(args []string) interface{} {
	out, err := runCmd("kubectl", args...)
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("kubectl: %s — %s", err, out)}
	}
	return map[string]interface{}{"output": out}
}

// ---------------------------------------------------------------------------
// Terraform — wraps terraform CLI
// ---------------------------------------------------------------------------

func mcpTerraformPlan(dir string) interface{} {
	return tfRun(dir, "plan", "-no-color")
}

func mcpTerraformApply(dir string, autoApprove bool) interface{} {
	args := []string{"apply", "-no-color"}
	if autoApprove {
		args = append(args, "-auto-approve")
	}
	return tfRun(dir, args...)
}

func mcpTerraformState(dir string) interface{} {
	return tfRun(dir, "state", "list")
}

func mcpTerraformOutput(dir string) interface{} {
	return tfRun(dir, "output", "-json")
}

func mcpTerraformInit(dir string) interface{} {
	return tfRun(dir, "init", "-no-color")
}

func mcpTerraformDestroy(dir string) interface{} {
	// Never auto-approve destroy
	return tfRun(dir, "plan", "-destroy", "-no-color")
}

func mcpTerraformValidate(dir string) interface{} {
	return tfRun(dir, "validate", "-no-color")
}

func tfRun(dir string, args ...string) interface{} {
	cmd := osexec.Command("terraform", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("terraform: %s", err), "output": string(out)}
	}
	return map[string]interface{}{"output": string(out)}
}

// ---------------------------------------------------------------------------
// Serverless — AWS Lambda, GCP Cloud Functions
// ---------------------------------------------------------------------------

func mcpLambdaList() interface{} {
	out, err := runCmd("aws", "lambda", "list-functions", "--query", "Functions[].{Name:FunctionName,Runtime:Runtime,Memory:MemorySize}", "--output", "json")
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("aws: %s", out)}
	}
	var result interface{}
	json.Unmarshal([]byte(out), &result)
	return map[string]interface{}{"functions": result}
}

func mcpLambdaInvoke(name, payload string) interface{} {
	args := []string{"lambda", "invoke", "--function-name", name, "--cli-binary-format", "raw-in-base64-out", "/dev/stdout"}
	if payload != "" {
		args = append(args[:len(args)-1], "--payload", payload, "/dev/stdout")
	}
	out, err := runCmd("aws", args...)
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("aws lambda invoke: %s", out)}
	}
	return map[string]interface{}{"output": out}
}

func mcpLambdaLogs(name string, minutes int) interface{} {
	if minutes <= 0 {
		minutes = 30
	}
	since := fmt.Sprintf("%dm", minutes)
	out, err := runCmd("aws", "logs", "tail", fmt.Sprintf("/aws/lambda/%s", name), "--since", since, "--format", "short")
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("aws logs: %s", out)}
	}
	return map[string]interface{}{"logs": out}
}

// ---------------------------------------------------------------------------
// Vercel — wraps vercel CLI
// ---------------------------------------------------------------------------

func mcpVercelStatus(dir string) interface{} {
	cmd := osexec.Command("vercel", "ls", "--json")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("vercel: %s", string(out))}
	}
	var result interface{}
	json.Unmarshal(out, &result)
	return result
}

func mcpVercelLogs(deploymentURL string) interface{} {
	out, err := runCmd("vercel", "logs", deploymentURL)
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("vercel logs: %s", out)}
	}
	return map[string]interface{}{"logs": out}
}

func mcpVercelEnv(dir string) interface{} {
	cmd := osexec.Command("vercel", "env", "ls")
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"error": string(out)}
	}
	return map[string]interface{}{"env": string(out)}
}

// ---------------------------------------------------------------------------
// Netlify — wraps netlify CLI
// ---------------------------------------------------------------------------

func mcpNetlifyStatus(dir string) interface{} {
	cmd := osexec.Command("netlify", "status", "--json")
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

// ---------------------------------------------------------------------------
// Sentry — wraps sentry-cli or uses API
// ---------------------------------------------------------------------------

func mcpSentryIssues(org, project string) interface{} {
	out, err := runCmd("sentry-cli", "issues", "list", "--org", org, "--project", project)
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("sentry-cli: %s (install: pip install sentry-cli) — %s", err, out)}
	}
	return map[string]interface{}{"issues": out}
}

// ---------------------------------------------------------------------------
// Linear — GraphQL API
// ---------------------------------------------------------------------------

func mcpLinearIssues(apiKey, teamKey string) interface{} {
	if apiKey == "" {
		return map[string]interface{}{"error": "Linear API key required. Get from: linear.app → Settings → API"}
	}
	query := `{"query": "{ issues(filter: { state: { type: { in: [\"started\", \"unstarted\", \"backlog\"] } } }, first: 20, orderBy: updatedAt) { nodes { identifier title state { name } assignee { name } priority createdAt } } }"}`
	if teamKey != "" {
		query = fmt.Sprintf(`{"query": "{ issues(filter: { team: { key: { eq: \"%s\" } }, state: { type: { in: [\"started\", \"unstarted\"] } } }, first: 20) { nodes { identifier title state { name } assignee { name } priority } } }"}`, teamKey)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("POST", "https://api.linear.app/graphql", strings.NewReader(query))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", apiKey)
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var result interface{}
	json.Unmarshal(body, &result)
	return result
}

// ---------------------------------------------------------------------------
// Notion — API
// ---------------------------------------------------------------------------

func mcpNotionSearch(apiKey, query string) interface{} {
	if apiKey == "" {
		return map[string]interface{}{"error": "Notion API key required. Create at: notion.so/my-integrations"}
	}
	body := fmt.Sprintf(`{"query": %q, "page_size": 10}`, query)
	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("POST", "https://api.notion.com/v1/search", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Notion-Version", "2022-06-28")
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	var result map[string]interface{}
	json.Unmarshal(respBody, &result)

	// Simplify results
	var pages []map[string]interface{}
	if results, ok := result["results"].([]interface{}); ok {
		for _, r := range results {
			if m, ok := r.(map[string]interface{}); ok {
				page := map[string]interface{}{
					"id":   m["id"],
					"type": m["object"],
					"url":  m["url"],
				}
				if props, ok := m["properties"].(map[string]interface{}); ok {
					if title, ok := props["Name"].(map[string]interface{}); ok {
						if titleArr, ok := title["title"].([]interface{}); ok && len(titleArr) > 0 {
							if t, ok := titleArr[0].(map[string]interface{}); ok {
								page["title"] = t["plain_text"]
							}
						}
					}
				}
				pages = append(pages, page)
			}
		}
	}
	return map[string]interface{}{"pages": pages, "count": len(pages)}
}

// ---------------------------------------------------------------------------
// Raycast / Alfred — trigger workflows (macOS)
// ---------------------------------------------------------------------------

func mcpRaycastTrigger(command string) interface{} {
	// Raycast deeplink
	out, err := runCmd("open", fmt.Sprintf("raycast://extensions/%s", command))
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return map[string]interface{}{"ok": true, "command": command, "output": out}
}

// ---------------------------------------------------------------------------
// 1Password — read-only lookup via op CLI
// ---------------------------------------------------------------------------

func mcpOnePasswordGet(item, vault string) interface{} {
	args := []string{"item", "get", item, "--format", "json"}
	if vault != "" {
		args = append(args, "--vault", vault)
	}
	out, err := runCmd("op", args...)
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("1Password CLI (op): %s (install: brew install 1password-cli) — %s", err, out)}
	}
	var result map[string]interface{}
	json.Unmarshal([]byte(out), &result)
	// Mask passwords — only return metadata, not secrets
	if fields, ok := result["fields"].([]interface{}); ok {
		var safeFields []map[string]interface{}
		for _, f := range fields {
			if fm, ok := f.(map[string]interface{}); ok {
				safe := map[string]interface{}{
					"label":   fm["label"],
					"type":    fm["type"],
					"section": fm["section"],
				}
				// Only show non-concealed values
				if fm["type"] != "CONCEALED" {
					safe["value"] = fm["value"]
				} else {
					safe["value"] = "***"
				}
				safeFields = append(safeFields, safe)
			}
		}
		result["fields"] = safeFields
	}
	return result
}

func mcpOnePasswordList(vault string) interface{} {
	args := []string{"item", "list", "--format", "json"}
	if vault != "" {
		args = append(args, "--vault", vault)
	}
	out, err := runCmd("op", args...)
	if err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("op: %s", out)}
	}
	var result interface{}
	json.Unmarshal([]byte(out), &result)
	return map[string]interface{}{"items": result}
}
