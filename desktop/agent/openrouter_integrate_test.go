package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeOpenRouterFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"backend/convex/schema.ts": `import { defineSchema, defineTable } from "convex/server";
export default defineSchema({ sessions: defineTable({ token: v.string(), expiresAt: v.number() }).index("by_token", ["token"]) });
`,
		"backend/convex/http.ts": `import { httpRouter } from "convex/server";
const http = httpRouter();
export default http;
`,
		"apps/mobile/package.json": `{"dependencies":{"expo":"~57.0.0"}}`,
		".env.example":             "APP_URL=http://localhost:8081\n",
	}
	for rel, body := range files {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestIntegrateOpenRouterWritesSecureStreamingSeamAndIsIdempotent(t *testing.T) {
	dir := writeOpenRouterFixture(t)
	first, err := integrateOpenRouter(openRouterIntegrationOptions{Directory: dir, IncludeClient: true})
	if err != nil {
		t.Fatal(err)
	}
	if !first.OK || first.Transport != "http-sse-pass-through" {
		t.Fatalf("unexpected result: %#v", first)
	}
	server, err := os.ReadFile(filepath.Join(dir, "backend/convex", openRouterServerName))
	if err != nil {
		t.Fatal(err)
	}
	serverText := string(server)
	for _, want := range []string{
		"process.env.OPENROUTER_API_KEY",
		"internal.yaverOpenRouter.sessionForToken",
		"internal.yaverOpenRouter.claimRequestBudget",
		`.withIndex("by_user_key"`,
		"inCurrentWindow ? usage.requests + 1 : 1",
		"stream: true",
		"new Response(upstream.body",
	} {
		if !strings.Contains(serverText, want) {
			t.Fatalf("server seam missing %q:\n%s", want, serverText)
		}
	}
	if strings.Contains(serverText, "OPENROUTER_API_KEY=") {
		t.Fatal("server source contains what looks like an embedded API-key assignment")
	}
	validationAt := strings.Index(serverText, "message/context is missing or too large")
	budgetAt := strings.Index(serverText, "claimRequestBudget")
	budgetCallAt := strings.LastIndex(serverText, "claimRequestBudget")
	if validationAt < 0 || budgetAt < 0 || budgetCallAt < validationAt {
		t.Fatal("request budget must be claimed only after input/config validation")
	}
	if strings.Contains(serverText, "setInterval") || strings.Contains(serverText, "setTimeout") {
		t.Fatal("generated server seam must not poll OpenRouter")
	}
	schema, _ := os.ReadFile(filepath.Join(dir, "backend/convex/schema.ts"))
	if strings.Count(string(schema), "// yaver:openrouter-usage") != 1 ||
		!strings.Contains(string(schema), "aiUsage: defineTable") ||
		!strings.Contains(string(schema), `.index("by_user_key", ["userKey"])`) ||
		strings.Contains(string(schema), "by_user_window") {
		t.Fatalf("bounded request accounting was not added exactly once:\n%s", schema)
	}
	httpSource, _ := os.ReadFile(filepath.Join(dir, "backend/convex/http.ts"))
	if strings.Count(string(httpSource), openRouterRouteMark) != 1 || !strings.Contains(string(httpSource), `path: "/ai/chat"`) {
		t.Fatalf("HTTP route not wired exactly once:\n%s", httpSource)
	}
	client, err := os.ReadFile(filepath.Join(dir, "apps/mobile", openRouterClientName))
	if err != nil || !strings.Contains(string(client), "streamOpenRouterChat") || !strings.Contains(string(client), "XMLHttpRequest") {
		t.Fatalf("mobile stream client missing: %v\n%s", err, client)
	}

	second, err := integrateOpenRouter(openRouterIntegrationOptions{Directory: dir, IncludeClient: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.ChangedFiles) != 0 {
		t.Fatalf("idempotent rerun changed files: %#v", second.ChangedFiles)
	}
}

func TestIntegrateOpenRouterRefusesUnauthenticatedPaidProxy(t *testing.T) {
	dir := writeOpenRouterFixture(t)
	if err := os.WriteFile(filepath.Join(dir, "backend/convex/schema.ts"), []byte(`export default defineSchema({});`), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := integrateOpenRouter(openRouterIntegrationOptions{Directory: dir, IncludeClient: true})
	if err == nil || !strings.Contains(err.Error(), "will not create a public OpenRouter proxy") {
		t.Fatalf("expected auth-boundary refusal, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "backend/convex", openRouterServerName)); !os.IsNotExist(statErr) {
		t.Fatalf("failed preflight mutated server seam: %v", statErr)
	}
}

func TestIntegrateOpenRouterSupportsStandardConvexAuthAndRootExpoLayout(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{
		"convex/schema.ts":      `import { defineSchema } from "convex/server"; export default defineSchema({});`,
		"convex/http.ts":        "import { httpRouter } from \"convex/server\";\nconst http = httpRouter();\nexport default http;\n",
		"convex/auth.config.ts": "export default { providers: [] };\n",
		"package.json":          `{"dependencies":{"expo":"~57.0.0"}}`,
	}
	for rel, body := range files {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	result, err := integrateOpenRouter(openRouterIntegrationOptions{Directory: dir, IncludeClient: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.AuthMode != "convex_identity" || result.ConvexDirectory != "convex" || result.MobileDirectory != "." {
		t.Fatalf("unexpected layout/auth detection: %#v", result)
	}
	server, err := os.ReadFile(filepath.Join(dir, "convex", openRouterServerName))
	if err != nil {
		t.Fatal(err)
	}
	serverText := string(server)
	if !strings.Contains(serverText, "ctx.auth.getUserIdentity()") || strings.Contains(serverText, "sessionForToken") {
		t.Fatalf("standard Convex auth seam is wrong:\n%s", serverText)
	}
	if _, err := os.Stat(filepath.Join(dir, openRouterClientName)); err != nil {
		t.Fatalf("root Expo client missing: %v", err)
	}
}

func TestYaverOpenRouterIntegrateIsAdvertisedAndDispatched(t *testing.T) {
	dir := writeOpenRouterFixture(t)
	toolsResult := (&HTTPServer{}).getMCPToolsList().(map[string]interface{})
	advertised := false
	for _, tool := range toolsResult["tools"].([]map[string]interface{}) {
		if tool["name"] == "yaver_openrouter_integrate" {
			advertised = true
			break
		}
	}
	if !advertised {
		t.Fatal("yaver_openrouter_integrate is not advertised")
	}
	call, _ := json.Marshal(map[string]interface{}{
		"name":      "yaver_openrouter_integrate",
		"arguments": map[string]interface{}{"directory": dir},
	})
	text := billingToolText(t, (&HTTPServer{}).handleMCPToolCall(call))
	for _, want := range []string{`"ok": true`, `"transport": "http-sse-pass-through"`, `"expo-sse-client"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("MCP result missing %s:\n%s", want, text)
		}
	}
}
