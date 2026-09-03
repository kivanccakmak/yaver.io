package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMCPSelfHostedProjectCreateGeneratesFullMonorepo(t *testing.T) {
	t.Setenv("YAVER_DISABLE_WIZARD_AUTOINIT", "1")

	parent, err := os.MkdirTemp("", "yaver-mcp-project-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(parent) })

	raw := json.RawMessage(`{
		"name": "Pocket CRM",
		"slug": "pocket-crm",
		"description": "A mobile-first CRM for small teams.",
		"domain": "",
		"gitProvider": "none",
		"parentDir": "` + parent + `"
	}`)
	result := (&HTTPServer{}).mcpProjectNewQuick(raw)

	content, ok := result.(map[string]interface{})["content"].([]map[string]interface{})
	if !ok || len(content) == 0 {
		t.Fatalf("unexpected MCP result shape: %#v", result)
	}
	if isErr, _ := result.(map[string]interface{})["isError"].(bool); isErr {
		t.Fatalf("mcpProjectNewQuick returned error: %v", content[0]["text"])
	}
	var generated ProjectGenerationResult
	if err := json.Unmarshal([]byte(content[0]["text"].(string)), &generated); err != nil {
		t.Fatalf("unmarshal generated result: %v\n%s", err, content[0]["text"])
	}
	if !generated.OK {
		t.Fatalf("expected ok result: %#v", generated)
	}

	expectedFiles := []string{
		"package.json",
		"apps/web/package.json",
		"apps/web/wrangler.toml",
		"apps/landing/index.html",
		"apps/mobile/app.json",
		"apps/mobile/App.tsx",
		"apps/mobile/yaver/YaverFeedbackRoot.tsx",
		"backend/package.json",
		"backend/convex/schema.ts",
		"backend/convex/http.ts",
		"packages/shared/index.ts",
		".yaver/config.yaml",
		".yaver/services.yaml",
		"legal/app-review.md",
	}
	for _, rel := range expectedFiles {
		if _, err := os.Stat(filepath.Join(generated.Directory, rel)); err != nil {
			t.Fatalf("expected generated file %s: %v", rel, err)
		}
	}

	wrangler, err := os.ReadFile(filepath.Join(generated.Directory, "apps/web/wrangler.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(wrangler), "workers_dev = true") {
		t.Fatalf("domain-less Cloudflare starter should use workers_dev=true:\n%s", wrangler)
	}

	mobileApp, err := os.ReadFile(filepath.Join(generated.Directory, "apps/mobile/app.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(mobileApp), `"bundleIdentifier": "com.myco.pocketcrm"`) {
		t.Fatalf("default iOS bundle id missing:\n%s", mobileApp)
	}
	if !strings.Contains(string(mobileApp), `"package": "com.myco.pocketcrm"`) {
		t.Fatalf("default Android package missing:\n%s", mobileApp)
	}
	if !strings.Contains(string(mobileApp), `"yaver-feedback-react-native"`) {
		t.Fatalf("generated Expo app does not register the Yaver config plugin:\n%s", mobileApp)
	}

	mobilePackage, err := os.ReadFile(filepath.Join(generated.Directory, "apps/mobile/package.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(mobilePackage), `"yaver-feedback-react-native"`) {
		t.Fatalf("generated Expo app does not depend on the Yaver SDK:\n%s", mobilePackage)
	}
	mobileRoot, err := os.ReadFile(filepath.Join(generated.Directory, "apps/mobile/App.tsx"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(mobileRoot), "export default withYaverFeedback(App);") {
		t.Fatalf("generated Expo root does not mount the Yaver SDK:\n%s", mobileRoot)
	}
	yaverRoot, err := os.ReadFile(filepath.Join(generated.Directory, "apps/mobile/yaver/YaverFeedbackRoot.tsx"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"initExpo();", "<FeedbackModal />"} {
		if !strings.Contains(string(yaverRoot), want) {
			t.Fatalf("generated Yaver root missing %q:\n%s", want, yaverRoot)
		}
	}

	if generated.YaverOnboarding == nil {
		t.Fatalf("expected yaverOnboarding guidance")
	}
	stack, _ := generated.YaverOnboarding["stack"].(map[string]interface{})
	if stack["backend"] != "backend/convex local dev and hosted Convex deploy" {
		t.Fatalf("unexpected onboarding stack: %#v", generated.YaverOnboarding)
	}
	if len(generated.NextSteps) == 0 || !strings.Contains(generated.NextSteps[0], "Self-hosted first") {
		t.Fatalf("expected self-hosted-first next step, got %#v", generated.NextSteps)
	}

	httpRouter, err := os.ReadFile(filepath.Join(generated.Directory, "backend/convex/http.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(httpRouter), "internal.auth") || !strings.Contains(string(httpRouter), "internal.http.upsertUserAndSession") {
		t.Fatalf("generated Convex HTTP router references the wrong generated module:\n%s", httpRouter)
	}
	openRouter, err := integrateOpenRouter(openRouterIntegrationOptions{
		Directory:     generated.Directory,
		IncludeClient: true,
	})
	if err != nil {
		t.Fatalf("fresh Yaver starter rejected deterministic OpenRouter integration: %v", err)
	}
	if !openRouter.OK || openRouter.Transport != "http-sse-pass-through" {
		t.Fatalf("unexpected OpenRouter integration result: %#v", openRouter)
	}
}
