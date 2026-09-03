package main

// openrouter_integrate.go owns the optional deterministic OpenRouter seam for
// Expo apps that explicitly use Convex. A coding agent should not have to improvise where the API key
// lives or turn one streamed token into one database write. This integration
// keeps the key in Convex env, proxies OpenRouter's SSE response directly, and
// gives the mobile app a small stream parser. Domain UI remains ordinary app
// code that Codex/Claude/OpenCode can add through Vibing.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	openRouterServerName = "yaverOpenRouter.ts"
	openRouterClientName = "yaver/openRouterChat.ts"
	openRouterRouteMark  = "// yaver:openrouter-routes"
)

type openRouterIntegrationOptions struct {
	Directory       string
	ConvexDirectory string
	MobileDirectory string
	IncludeClient   bool
	AuthMode        string
}

type openRouterIntegrationResult struct {
	OK              bool     `json:"ok"`
	Directory       string   `json:"directory"`
	ConvexDirectory string   `json:"convex_directory"`
	MobileDirectory string   `json:"mobile_directory,omitempty"`
	AuthMode        string   `json:"auth_mode"`
	Transport       string   `json:"transport"`
	ChangedFiles    []string `json:"changed_files,omitempty"`
	UnchangedFiles  []string `json:"unchanged_files,omitempty"`
	Verification    []string `json:"verification,omitempty"`
	RequiredEnv     []string `json:"required_env"`
	Security        []string `json:"security"`
	NextVibingSteps []string `json:"next_vibing_steps"`
	Error           string   `json:"error,omitempty"`
}

func integrateOpenRouter(opts openRouterIntegrationOptions) (openRouterIntegrationResult, error) {
	result := openRouterIntegrationResult{
		Transport:   "http-sse-pass-through",
		RequiredEnv: []string{"OPENROUTER_API_KEY", "OPENROUTER_MODEL", "APP_URL", "EXPO_PUBLIC_CONVEX_SITE_URL"},
		Security: []string{
			"OpenRouter API key stays in Convex environment variables and is never written to Expo source.",
			"Every request must cross a detected Convex authentication boundary; unauthenticated proxies are refused.",
			"Browser CORS is restricted to APP_URL; native clients are unaffected.",
			"The active response streams directly from OpenRouter; there is no database write per token.",
			"Rate limiting uses one bounded counter row per user and at most one small mutation per accepted request.",
			"Set OpenRouter credit limits and Convex usage limits before production; application rate limiting is not a provider spend cap.",
		},
		NextVibingSteps: []string{
			"Build a domain-aware chat card that calls streamOpenRouterChat with the signed-in auth token and current record context.",
			"Add photo capture + storage metadata, then extend the server message content for a vision-capable model.",
			"Persist only the final answer for history, or use throttled Convex stream deltas when reconnectable background generation is required.",
		},
	}
	dir := strings.TrimSpace(opts.Directory)
	if dir == "" {
		return result, fmt.Errorf("directory is required; pass the monorepo root explicitly")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return result, fmt.Errorf("resolve project directory: %w", err)
	}
	result.Directory = abs
	if info, statErr := os.Stat(abs); statErr != nil || !info.IsDir() {
		return result, fmt.Errorf("project directory is not readable: %s", abs)
	}
	convexDir, convexRel, err := resolveOpenRouterDirectory(abs, opts.ConvexDirectory, []string{"backend/convex", "convex"}, func(path string) bool {
		return fileExists(filepath.Join(path, "schema.ts")) && fileExists(filepath.Join(path, "http.ts"))
	})
	if err != nil {
		return result, fmt.Errorf("resolve Convex directory: %w", err)
	}
	result.ConvexDirectory = convexRel

	schemaPath := filepath.Join(convexDir, "schema.ts")
	schema, err := os.ReadFile(schemaPath)
	if err != nil {
		return result, fmt.Errorf("read Convex schema: %w", err)
	}
	authMode, err := resolveOpenRouterAuthMode(opts.AuthMode, convexDir, string(schema))
	if err != nil {
		return result, err
	}
	result.AuthMode = authMode
	serverRel := filepath.ToSlash(filepath.Join(convexRel, openRouterServerName))
	httpRel := filepath.ToSlash(filepath.Join(convexRel, "http.ts"))
	serverSource := openRouterServerSourceFor(authMode)
	if err := preflightGeneratedOpenRouterFile(abs, serverRel, serverSource); err != nil {
		return result, err
	}
	httpPath := filepath.Join(convexDir, "http.ts")
	if err := preflightOpenRouterRoutes(httpPath); err != nil {
		return result, err
	}
	clientRel := ""
	if opts.IncludeClient {
		mobileDir, mobileRel, resolveErr := resolveOpenRouterDirectory(abs, opts.MobileDirectory, []string{".", "apps/mobile", "mobile"}, isExpoProject)
		if resolveErr != nil {
			return result, fmt.Errorf("resolve Expo mobile directory: %w", resolveErr)
		}
		_ = mobileDir
		result.MobileDirectory = mobileRel
		clientRel = filepath.ToSlash(filepath.Join(mobileRel, openRouterClientName))
		if err := preflightGeneratedOpenRouterFile(abs, clientRel, openRouterClientSource); err != nil {
			return result, err
		}
	}
	if err := patchOpenRouterSchema(schemaPath, string(schema), filepath.ToSlash(filepath.Join(convexRel, "schema.ts")), &result); err != nil {
		return result, err
	}

	if err := writeGeneratedOpenRouterFile(abs, serverRel, serverSource, &result); err != nil {
		return result, err
	}
	if err := wireOpenRouterRoutes(httpPath, httpRel, &result); err != nil {
		return result, err
	}
	if opts.IncludeClient {
		if err := writeGeneratedOpenRouterFile(abs, clientRel, openRouterClientSource, &result); err != nil {
			return result, err
		}
	}
	if err := appendOpenRouterEnv(filepath.Join(abs, ".env.example"), &result); err != nil {
		return result, err
	}
	result.Verification = []string{"convex-auth-boundary", "openrouter-sse-route", "server-only-api-key", "bounded-request-counter"}
	if opts.IncludeClient {
		result.Verification = append(result.Verification, "expo-sse-client")
	}
	result.OK = true
	return result, nil
}

func resolveOpenRouterDirectory(root, explicit string, candidates []string, matches func(string) bool) (string, string, error) {
	resolve := func(value string) (string, string, error) {
		path := value
		if !filepath.IsAbs(path) {
			path = filepath.Join(root, filepath.FromSlash(path))
		}
		abs, err := filepath.Abs(path)
		if err != nil {
			return "", "", err
		}
		rel, err := filepath.Rel(root, abs)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", "", fmt.Errorf("directory must stay inside project root %s", root)
		}
		if !matches(abs) {
			return "", "", fmt.Errorf("%s does not match the required project shape", abs)
		}
		return abs, filepath.ToSlash(rel), nil
	}
	if strings.TrimSpace(explicit) != "" {
		return resolve(strings.TrimSpace(explicit))
	}
	type foundDirectory struct{ abs, rel string }
	var found []foundDirectory
	seen := map[string]bool{}
	for _, candidate := range candidates {
		abs, rel, err := resolve(candidate)
		if err != nil || seen[abs] {
			continue
		}
		seen[abs] = true
		found = append(found, foundDirectory{abs: abs, rel: rel})
	}
	if len(found) == 0 {
		return "", "", fmt.Errorf("no matching directory found; pass it explicitly")
	}
	if len(found) > 1 {
		rels := make([]string, 0, len(found))
		for _, item := range found {
			rels = append(rels, item.rel)
		}
		return "", "", fmt.Errorf("multiple matching directories (%s); pass one explicitly", strings.Join(rels, ", "))
	}
	return found[0].abs, found[0].rel, nil
}

func resolveOpenRouterAuthMode(requested, convexDir, schema string) (string, error) {
	mode := strings.ToLower(strings.TrimSpace(requested))
	if mode == "starter-session" {
		mode = "starter_session"
	}
	if mode == "convex-auth" {
		mode = "convex_identity"
	}
	hasStarterSession := strings.Contains(schema, "sessions: defineTable") && strings.Contains(schema, `index("by_token"`)
	hasConvexAuth := fileExists(filepath.Join(convexDir, "auth.config.ts")) || fileExists(filepath.Join(convexDir, "auth.config.js"))
	if mode == "" || mode == "auto" {
		switch {
		case hasStarterSession:
			return "starter_session", nil
		case hasConvexAuth:
			return "convex_identity", nil
		default:
			return "", fmt.Errorf("no supported Convex auth boundary detected; add auth.config.ts or pass auth_mode after wiring authentication (Yaver will not create a public OpenRouter proxy)")
		}
	}
	switch mode {
	case "starter_session":
		if !hasStarterSession {
			return "", fmt.Errorf("auth_mode starter_session requires sessions.by_token (Yaver will not create a public OpenRouter proxy)")
		}
		return mode, nil
	case "convex_identity":
		if !hasConvexAuth {
			return "", fmt.Errorf("auth_mode convex_identity requires Convex auth.config.ts (Yaver will not create a public OpenRouter proxy)")
		}
		return mode, nil
	default:
		return "", fmt.Errorf("unsupported auth_mode %q (use auto, starter_session, or convex_identity)", requested)
	}
}

func preflightGeneratedOpenRouterFile(root, rel, body string) error {
	path := filepath.Join(root, filepath.FromSlash(rel))
	existing, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if string(existing) == body || strings.HasPrefix(string(existing), "// Generated by yaver openrouter integrate.") {
		return nil
	}
	return fmt.Errorf("refusing to overwrite non-Yaver file %s", path)
}

func preflightOpenRouterRoutes(httpPath string) error {
	source, err := os.ReadFile(httpPath)
	if err != nil {
		return fmt.Errorf("Convex HTTP router is missing at %s; generate or restore convex/http.ts before adding OpenRouter: %w", httpPath, err)
	}
	text := string(source)
	if strings.Contains(text, openRouterRouteMark) {
		return nil
	}
	if !strings.Contains(text, "httpRouter(") || !strings.Contains(text, "export default http;") {
		return fmt.Errorf("cannot safely patch %s: expected a Convex httpRouter exported as http", httpPath)
	}
	return nil
}

func patchOpenRouterSchema(schemaPath, source, schemaRel string, result *openRouterIntegrationResult) error {
	const marker = "// yaver:openrouter-usage"
	if strings.Contains(source, marker) {
		result.UnchangedFiles = append(result.UnchangedFiles, schemaRel)
		return nil
	}
	if !strings.Contains(source, `from "convex/values"`) && !strings.Contains(source, `from 'convex/values'`) {
		source = insertAfterImportBlock(source, `import { v } from "convex/values";`+"\n")
	}
	end := strings.LastIndex(source, "});")
	if end < 0 {
		return fmt.Errorf("cannot safely patch %s: expected defineSchema({...})", schemaPath)
	}
	prefix := strings.TrimRight(source[:end], " \t\r\n")
	if !strings.HasSuffix(prefix, ",") {
		prefix += ","
	}
	patched := prefix + `

  // yaver:openrouter-usage
  aiUsage: defineTable({
	userKey: v.string(),
    windowStart: v.number(),
    requests: v.number(),
	}).index("by_user_key", ["userKey"]),
` + source[end:]
	if err := os.WriteFile(schemaPath, []byte(patched), infoMode(schemaPath)); err != nil {
		return fmt.Errorf("add OpenRouter request budget table: %w", err)
	}
	result.ChangedFiles = append(result.ChangedFiles, schemaRel)
	return nil
}

func writeGeneratedOpenRouterFile(root, rel, body string, result *openRouterIntegrationResult) error {
	path := filepath.Join(root, filepath.FromSlash(rel))
	if existing, err := os.ReadFile(path); err == nil {
		if string(existing) == body {
			result.UnchangedFiles = append(result.UnchangedFiles, rel)
			return nil
		}
		if !strings.HasPrefix(string(existing), "// Generated by yaver openrouter integrate.") {
			return fmt.Errorf("refusing to overwrite non-Yaver file %s", path)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		return err
	}
	result.ChangedFiles = append(result.ChangedFiles, rel)
	return nil
}

func wireOpenRouterRoutes(httpPath, httpRel string, result *openRouterIntegrationResult) error {
	source, err := os.ReadFile(httpPath)
	if err != nil {
		return fmt.Errorf("Convex HTTP router is missing at %s; generate or restore convex/http.ts before adding OpenRouter: %w", httpPath, err)
	}
	text := string(source)
	if strings.Contains(text, openRouterRouteMark) {
		result.UnchangedFiles = append(result.UnchangedFiles, httpRel)
		return nil
	}
	if !strings.Contains(text, "httpRouter(") || !strings.Contains(text, "export default http;") {
		return fmt.Errorf("cannot safely patch %s: expected a Convex httpRouter exported as http", httpPath)
	}
	text = insertAfterImportBlock(text, `import { openRouterChat, openRouterPreflight } from "./yaverOpenRouter";`+"\n")
	routes := openRouterRouteMark + `
http.route({ path: "/ai/chat", method: "POST", handler: openRouterChat });
http.route({ path: "/ai/chat", method: "OPTIONS", handler: openRouterPreflight });

`
	text = strings.Replace(text, "export default http;", routes+"export default http;", 1)
	if err := os.WriteFile(httpPath, []byte(text), infoMode(httpPath)); err != nil {
		return fmt.Errorf("wire OpenRouter HTTP routes: %w", err)
	}
	result.ChangedFiles = append(result.ChangedFiles, httpRel)
	return nil
}

func appendOpenRouterEnv(path string, result *openRouterIntegrationResult) error {
	source, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	text := string(source)
	if strings.Contains(text, "OPENROUTER_API_KEY=") {
		result.UnchangedFiles = append(result.UnchangedFiles, ".env.example")
		return nil
	}
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	text += "\n# Server-only AI. Set OPENROUTER_API_KEY with `npx convex env set`; never EXPO_PUBLIC_.\n" +
		"OPENROUTER_API_KEY=\nOPENROUTER_MODEL=openai/gpt-4.1-mini\nOPENROUTER_REQUESTS_PER_MINUTE=5\nAPP_URL=http://localhost:8081\nEXPO_PUBLIC_CONVEX_SITE_URL=\n"
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		return err
	}
	result.ChangedFiles = append(result.ChangedFiles, ".env.example")
	return nil
}

const openRouterServerTemplate = `// Generated by yaver openrouter integrate. Safe to regenerate.
import { httpAction, internalMutation{{INTERNAL_QUERY_IMPORT}} } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

{{SESSION_QUERY}}

export const claimRequestBudget = internalMutation({
  args: { userKey: v.string(), windowStart: v.number(), limit: v.number() },
  handler: async (ctx, { userKey, windowStart, limit }) => {
    const usage = await ctx.db.query("aiUsage")
      .withIndex("by_user_key", (q) => q.eq("userKey", userKey))
      .unique();
    const inCurrentWindow = usage?.windowStart === windowStart;
    if (usage && inCurrentWindow && usage.requests >= limit) return false;
    if (usage) {
      await ctx.db.patch(usage._id, {
        windowStart,
        requests: inCurrentWindow ? usage.requests + 1 : 1,
      });
    }
    else await ctx.db.insert("aiUsage", { userKey, windowStart, requests: 1 });
    return true;
  },
});

/* {{AUTH_MODE}} */
`

const openRouterStarterSessionQuery = `
export const sessionForToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db.query("sessions").withIndex("by_token", (q) => q.eq("token", token)).unique();
    return session && session.expiresAt > Date.now() ? { userKey: String(session.userId) } : null;
  },
});
`

const openRouterServerRemainder = `
function corsHeaders(request: Request): Record<string, string> {
  const configured = (process.env.APP_URL || "").replace(/\/$/, "");
  const origin = request.headers.get("origin") || "";
  return configured && origin === configured
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, content-type", "Vary": "Origin" }
    : {};
}

export const openRouterPreflight = httpAction(async (_ctx, request) =>
  new Response(null, { status: 204, headers: { ...corsHeaders(request), "Access-Control-Allow-Methods": "POST, OPTIONS" } }),
);

export const openRouterChat = httpAction(async (ctx, request) => {
  const cors = corsHeaders(request);
  {{AUTH_BLOCK}}

  const apiKey = process.env.OPENROUTER_API_KEY || "";
  if (!apiKey) return new Response("OPENROUTER_API_KEY is not configured", { status: 503, headers: cors });
  const body = await request.json().catch(() => null) as { message?: unknown; context?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const context = typeof body?.context === "string" ? body.context.trim() : "";
  if (!message || message.length > 12_000 || context.length > 24_000) {
    return new Response("message/context is missing or too large", { status: 400, headers: cors });
  }
  const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
  const configuredLimit = Number(process.env.OPENROUTER_REQUESTS_PER_MINUTE || 5);
  const limit = Math.min(20, Math.max(1, Number.isFinite(configuredLimit) ? configuredLimit : 5));
  const withinBudget = await ctx.runMutation(internal.yaverOpenRouter.claimRequestBudget, {
    userKey, windowStart, limit,
  });
  if (!withinBudget) return new Response("OpenRouter request budget exceeded; retry next minute", { status: 429, headers: cors });
  const maxTokens = Math.min(2048, Math.max(128, Number(process.env.OPENROUTER_MAX_TOKENS || 800)));
  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "https://yaver.io",
      "X-OpenRouter-Title": process.env.OPENROUTER_APP_TITLE || "Yaver app",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || "openai/gpt-4.1-mini",
      stream: true,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: "Answer from the supplied operational context. Be concise and state uncertainty." },
        ...(context ? [{ role: "system", content: "Operational context:\n" + context }] : []),
        { role: "user", content: message },
      ],
    }),
  });
  if (!upstream.ok || !upstream.body) {
    return new Response("OpenRouter request failed with HTTP " + upstream.status, { status: 502, headers: cors });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
});
`

func openRouterServerSourceFor(authMode string) string {
	queryImport := ""
	sessionQuery := ""
	authBlock := `const identity = await ctx.auth.getUserIdentity();
  if (!identity) return new Response("unauthorized", { status: 401, headers: cors });
  const userKey = identity.tokenIdentifier || identity.subject;`
	if authMode == "starter_session" {
		queryImport = ", internalQuery"
		sessionQuery = strings.TrimSpace(openRouterStarterSessionQuery)
		authBlock = `const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const session = token ? await ctx.runQuery(internal.yaverOpenRouter.sessionForToken, { token }) : null;
  if (!session) return new Response("unauthorized", { status: 401, headers: cors });
  const userKey = session.userKey;`
	}
	header := strings.ReplaceAll(openRouterServerTemplate, "{{INTERNAL_QUERY_IMPORT}}", queryImport)
	header = strings.ReplaceAll(header, "{{SESSION_QUERY}}", sessionQuery)
	header = strings.ReplaceAll(header, "{{AUTH_MODE}}", "auth mode: "+authMode)
	remainder := strings.ReplaceAll(openRouterServerRemainder, "{{AUTH_BLOCK}}", authBlock)
	return header + remainder
}

const openRouterClientSource = `// Generated by yaver openrouter integrate. Safe to regenerate.
export type OpenRouterChatInput = {
  siteUrl: string;
  sessionToken: string;
  message: string;
  context?: string;
  onDelta: (text: string) => void;
};

// XMLHttpRequest progress works in native React Native and RN-web. The server
// passes OpenRouter SSE through without writing every token into Convex.
export function streamOpenRouterChat(input: OpenRouterChatInput): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let consumed = 0;
    let pending = "";
    let answer = "";
    xhr.open("POST", input.siteUrl.replace(/\/$/, "") + "/ai/chat");
    xhr.setRequestHeader("Authorization", "Bearer " + input.sessionToken);
    xhr.setRequestHeader("Content-Type", "application/json");
    const consume = () => {
      pending += xhr.responseText.slice(consumed);
      consumed = xhr.responseText.length;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data);
          const delta = event?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            answer += delta;
            input.onDelta(delta);
          }
        } catch { /* incomplete/non-content SSE event */ }
      }
    };
    xhr.onprogress = consume;
    xhr.onerror = () => reject(new Error("OpenRouter stream network error"));
    xhr.onload = () => {
      consume();
      if (xhr.status >= 200 && xhr.status < 300) resolve(answer);
      else reject(new Error(xhr.responseText || "OpenRouter stream HTTP " + xhr.status));
    };
    xhr.send(JSON.stringify({ message: input.message, context: input.context || "" }));
  });
}
`

func mcpIntegrateOpenRouter(raw json.RawMessage) interface{} {
	var args struct {
		Directory       string `json:"directory"`
		ConvexDirectory string `json:"convex_directory"`
		MobileDirectory string `json:"mobile_directory"`
		AuthMode        string `json:"auth_mode"`
		IncludeClient   *bool  `json:"include_mobile_client"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return mcpToolError("invalid arguments: " + err.Error())
	}
	includeClient := true
	if args.IncludeClient != nil {
		includeClient = *args.IncludeClient
	}
	result, err := integrateOpenRouter(openRouterIntegrationOptions{
		Directory:       args.Directory,
		ConvexDirectory: args.ConvexDirectory,
		MobileDirectory: args.MobileDirectory,
		AuthMode:        args.AuthMode,
		IncludeClient:   includeClient,
	})
	if err != nil {
		result.Error = err.Error()
		encoded, _ := json.MarshalIndent(result, "", "  ")
		return mcpToolError(string(encoded))
	}
	return mcpToolJSON(result)
}
