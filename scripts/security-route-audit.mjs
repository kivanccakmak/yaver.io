#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const sourcePath = path.join(repoRoot, "desktop/agent/httpserver.go");
const source = fs.readFileSync(sourcePath, "utf8");
const backendHTTPPath = path.join(repoRoot, "backend/convex/http.ts");
const backendHTTPSource = fs.readFileSync(backendHTTPPath, "utf8");
const cloudMachinesPath = path.join(repoRoot, "backend/convex/cloudMachines.ts");
const cloudMachinesSource = fs.readFileSync(cloudMachinesPath, "utf8");
const ownerDeploySources = [
  "scripts/deploy-yaver-agent-hetzner.sh",
  "scripts/provision-machine.sh",
].map((relativePath) => ({
  relativePath,
  source: fs.readFileSync(path.join(repoRoot, relativePath), "utf8"),
}));
const ownerOnlySurfaceSources = [
  "mobile/app/(tabs)/settings.tsx",
  "mobile/app/(tabs)/screenlog.tsx",
  "mobile/app/(tabs)/_layout.tsx",
  "web/app/dashboard/page.tsx",
].map((relativePath) => ({
  relativePath,
  source: fs.readFileSync(path.join(repoRoot, relativePath), "utf8"),
}));

const ROUTE_RE = /mux\.HandleFunc\("([^"]+)",\s*([^\n]+?)\)/g;
const BACKEND_ROUTE_RE = /path:\s*"([^"]+)"/g;

// Removed account-sharing surfaces are a product invariant, not merely a
// launch flag. Keep this list exact enough that unrelated concepts such as
// shared storage and Hermes guest bundles are unaffected.
const FORBIDDEN_AGENT_ROUTE_PREFIXES = [
  "/guests",
  "/guest",
  "/support",
  "/chat",
  "/host-share",
  "/users",
  "/sessions",
  "/teams",
  "/vibe/sessions",
  "/vibe/join",
  "/vibe/heartbeat",
  "/vibe/role",
  "/vibe/leave",
];
const FORBIDDEN_BACKEND_ROUTE_PREFIXES = [
  "/guests",
  "/support",
  "/chat",
  "/host-share",
  "/teams",
  "/project-shares",
  "/project-artifacts/public",
  "/packages/allocation",
  "/packages/accept",
  "/packages/shared",
];
const FORBIDDEN_REMOVED_FILES = [
  "desktop/agent/guest_cmd.go",
  "desktop/agent/guest_config_http.go",
  "desktop/agent/guest_http.go",
  "desktop/agent/host_share_cmd.go",
  "desktop/agent/host_share_workspace_http.go",
  "desktop/agent/support_cmd.go",
  "desktop/agent/support_http.go",
  "web/components/ChatWidget.tsx",
  "web/lib/guests.ts",
  "mobile/app/(tabs)/guests.tsx",
  "mobile/src/lib/guests.ts",
  "backend/convex/guests.ts",
  "backend/convex/hostShare.ts",
  "backend/convex/projectShares.ts",
  "backend/convex/teams.ts",
  "desktop/agent/testkit_grow.go",
  "desktop/agent/testkit_grow_test.go",
  "web/app/support/page.tsx",
  "web/app/j/[code]/page.tsx",
  "yaver-tests/feature-j-code.test.yaml",
  "yaver-tests/feature-support.test.yaml",
  ".github/workflows/remote-host-share-verify.yml",
  ".github/workflows/remote-host-share-agentless.yml",
  ".github/workflows/remote-host-share-lifecycle.yml",
  ".github/workflows/remote-guest-docker-verify.yml",
];

const PUBLIC_ALLOWLIST = new Set([
  "/health",
  "/identity/prove",
  "/$dwdsSseHandler",
  "/$dwdsSseHandler/",
  "/integrations/whatsapp/command",
  "/blobs/public",
  "/changelog.html",
  "/changelog.atom",
  "/auth/pair/info",
  "/auth/pair/session",
  "/auth/pair/submit",
  "/auth/pair/encrypted",
  "/auth/recover",
  "/auth/recover/session",
  "/auth/reload-from-disk",
  "/auth/factory-reset",
  "/auth/status",
  "/newsletter/subscribe",
  "/newsletter/confirm",
  "/newsletter/unsubscribe",
  "/oauth/.well-known/openid-configuration",
  "/oauth/authorize",
  "/oauth/login",
  "/oauth/token",
  "/oauth/userinfo",
  "/oauth/jwks",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/mail/onboard/callback",
  "/s/",
  "/waitlist/join",
  "/waitlist/leaderboard",
  "/docs",
  "/docs/",
  "/meet/",
  "/ab/assign",
  "/ab/events",
  "/webhooks/stripe",
  "/webhooks/lemonsqueezy",
  "/asciinema/",
  "/analytics/views",
  "/webhooks/trigger",
  "/dev/native-bundle",
  "/dev/native-assets",
  "/dev/web-bundle/",
  "/dev/hermes-wasm-runtime",
  "/dev/",
  "/dev-web/",
  "/deploy/webhook",
  "/forms/",
]);

const OWNER_ONLY_PREFIXES = [
  "/tasks",
  "/finalize",
  "/deploy",
  "/stores",
  "/listing",
  "/publish",
  "/info",
  "/hardware",
  "/self-check",
  "/bus",
  "/agent/status",
  "/agent/capabilities",
  "/agent/self-heal",
  "/runner-auth/set",
  "/auth/ssh",
  "/runner/opencode",
  "/machine",
  "/agent/env-profile",
  "/agent/toolchain-sync",
  "/agent/dev-configs",
  "/dev-environments",
  "/code",
  "/agent/runner/restart",
  "/agent/update",
  "/agent/shutdown",
  "/infra",
  "/agent/clean",
  "/agent/doctor",
  "/agent/tools",
  "/schedules",
  "/streams",
  "/clips",
  "/netcapture",
  "/autoideas",
  "/autoinit",
  "/releases",
  "/incidents",
  "/operations",
  "/capabilities/snapshot",
  "/errors",
  "/monitors",
  "/analytics/events",
  "/flags/override",
  "/flags/delete",
  "/logs",
  "/sourcemaps",
  "/env",
  "/sync",
  "/statuspage",
  "/email",
  "/apikeys",
  "/pubsub/topics",
  "/search",
  "/feedback-board",
  "/remoteview",
  "/ghost",
  "/capture",
  "/appletv",
  "/stream",
  "/tunnel",
  "/files",
  "/shared-storage",
  "/project",
  "/imports",
  "/forms",
  "/newsletter/subscribers",
  "/newsletter/campaigns",
  "/newsletter/compose",
  "/jobs",
  "/img",
  "/pdf",
  "/yaver-agent/audit",
  "/mcp/servers",
];

const SDK_SCOPED_PREFIXES = [
  "/agent/runners",
  "/agent/runner/switch",
  "/ops",
  "/dev/status",
  "/dev/target",
  "/dev/reload",
  "/dev/reload-app",
  "/dev/native-fingerprint",
  "/dev/events",
  "/dev/compatibility",
  "/dev/build-native",
  "/unity",
  "/vibing",
];

const SDK_PREFIXES = [
  "/runner-auth/setup",
  "/runner-auth/browser",
  "/runner-auth/credentials/import",
  "/runner-provider/preflight",
  "/company-ai/resolve-local",
  "/analytics/ingest",
  "/flags/eval",
  "/env/get",
  "/pubsub/publish",
  "/pubsub/subscribe",
  "/feedback-board/public",
  "/voice",
  "/feedback",
  "/shots",
  "/design-references",
  "/test-app",
  "/blackbox",
  "/mobile-workers",
  "/todolist",
  "/errors/ingest",
];

const SENSITIVE_HANDLER_NAMES = [
  "Credentials",
  "ToolchainGitCredentials",
  "OpenCodeConfig",
  "SSHAuthorizedKeys",
  "Shutdown",
  "EnvGet",
  "EnvList",
  "APIKeys",
  "Vault",
  "FilesRead",
  "FilesRaw",
  "SharedStorageRead",
  "SharedStorageRaw",
  "MCPServers",
  "YaverAgentDeviceAudit",
  "Netcapture",
  "Ghost",
  "Capture",
  "RemoteView",
  "Ops",
];

function classifyWrapper(handlerExpr) {
  if (handlerExpr.includes("s.authMCP(")) return "authMCP";
  if (handlerExpr.includes("s.attachOrAuth(")) return "capabilityOrAuth";
  if (handlerExpr.includes("s.authSDK(")) return "authSDK";
  if (handlerExpr.includes("s.auth(")) return "auth";
  if (handlerExpr.includes("s.authBuildLocal(")) return "authBuildLocal";
  if (handlerExpr.includes("s.rateLimit(s.auth(")) return "auth";
  if (handlerExpr.includes("s.rateLimit(s.authSDK(")) return "authSDK";
  return "public";
}

function matchesRoutePrefix(value, prefix) {
  return value === prefix || value.startsWith(`${prefix}/`);
}

function startsWithAny(value, prefixes) {
  return prefixes.some((prefix) => matchesRoutePrefix(value, prefix));
}

function routeExpected(pathname) {
  if (PUBLIC_ALLOWLIST.has(pathname)) return "public";
  if (startsWithAny(pathname, SDK_SCOPED_PREFIXES)) return "authSDK";
  if (startsWithAny(pathname, SDK_PREFIXES)) return "authSDK";
  if (startsWithAny(pathname, OWNER_ONLY_PREFIXES)) return "auth";
  return null;
}

function weakerThan(actual, expected) {
  if (expected === "public") return false;
  if (expected === "auth") return actual !== "auth" && actual !== "authMCP";
  if (expected === "authSDK") return actual === "public";
  return false;
}

const routes = [];
let match;
while ((match = ROUTE_RE.exec(source)) !== null) {
  routes.push({ path: match[1], expr: match[2].trim(), actual: classifyWrapper(match[2]) });
}

const findings = [];

for (const forbidden of [
  { pattern: /\.query\("teamMembers"\)/, detail: "team membership must not add machines to an owner's fleet" },
  { pattern: /teamId:\s*args\.teamId/, detail: "cloud-machine creation must not mint team-owned machines" },
  { pattern: /multiUser:\s*!!args\.teamId/, detail: "cloud machines are owner-account only" },
]) {
  if (forbidden.pattern.test(cloudMachinesSource)) {
    findings.push({
      severity: "high",
      check: "cross-account-cloud-machine-access-restored",
      path: "backend/convex/cloudMachines.ts",
      actual: "present",
      detail: forbidden.detail,
    });
  }
}

for (const { relativePath, source: deploySource } of ownerDeploySources) {
  if (/--multi-user|--max-users|guest users connect|team members can now/i.test(deploySource)) {
    findings.push({
      severity: "high",
      check: "cross-account-deploy-mode-restored",
      path: relativePath,
      actual: "present",
      detail: "deployment entrypoints must start owner-only agents",
    });
  }
}

for (const { relativePath, source: surfaceSource } of ownerOnlySurfaceSources) {
  if (/invite someone to code with you|invite you to share their machine|share it to you first|router\.(?:push|navigate)\(["']\/guests/i.test(surfaceSource)) {
    findings.push({
      severity: "high",
      check: "cross-account-surface-restored",
      path: relativePath,
      actual: "present",
      detail: "v1 surfaces must not advertise guest, visitor, or cross-account machine access",
    });
  }
}

for (const relativePath of FORBIDDEN_REMOVED_FILES) {
  if (fs.existsSync(path.join(repoRoot, relativePath))) {
    findings.push({
      severity: "high",
      check: "removed-account-sharing-file-restored",
      path: relativePath,
      actual: "present",
      detail: "visitor/guest UI, backend modules, and CI flows were permanently removed",
    });
  }
}

for (const route of routes) {
  if (FORBIDDEN_AGENT_ROUTE_PREFIXES.some((prefix) => matchesRoutePrefix(route.path, prefix))) {
    findings.push({
      severity: "high",
      check: "removed-account-sharing-route",
      path: route.path,
      actual: route.actual,
      detail: "visitor/guest and cross-account machine APIs were permanently removed",
    });
  }
}

let backendMatch;
while ((backendMatch = BACKEND_ROUTE_RE.exec(backendHTTPSource)) !== null) {
  const routePath = backendMatch[1];
  if (FORBIDDEN_BACKEND_ROUTE_PREFIXES.some((prefix) => matchesRoutePrefix(routePath, prefix))) {
    findings.push({
      severity: "high",
      check: "removed-backend-account-sharing-route",
      path: routePath,
      actual: "registered",
      detail: "visitor/guest and cross-account machine APIs were permanently removed",
    });
  }
}

for (const route of routes) {
  const expected = routeExpected(route.path);
  if (expected && weakerThan(route.actual, expected)) {
    findings.push({
      severity: expected === "auth" ? "high" : "medium",
      check: "weak-route-wrapper",
      path: route.path,
      expected,
      actual: route.actual,
      handler: route.expr,
    });
  }

  if (
    route.actual === "public" &&
    !PUBLIC_ALLOWLIST.has(route.path) &&
    SENSITIVE_HANDLER_NAMES.some((name) => route.expr.includes(name))
  ) {
    findings.push({
      severity: "high",
      check: "sensitive-public-handler",
      path: route.path,
      actual: route.actual,
      handler: route.expr,
    });
  }
}

const routeCount = routes.length;
const publicRoutes = routes.filter((r) => r.actual === "public").map((r) => r.path);
const unlistedPublic = publicRoutes.filter((p) => !PUBLIC_ALLOWLIST.has(p));
for (const pathname of unlistedPublic) {
  findings.push({
    severity: "low",
    check: "public-route-not-reviewed",
    path: pathname,
    actual: "public",
    detail: "public route is not in scripts/security-route-audit.mjs allowlist; review whether this is intentional",
  });
}

console.log(`Audited ${routeCount} desktop agent routes from ${sourcePath}`);
console.log(`Public routes: ${publicRoutes.length}`);
if (findings.length === 0) {
  console.log("No route wrapper regressions found.");
} else {
  console.log(`Findings: ${findings.length}`);
  for (const f of findings) {
    console.log(`[${f.severity}] ${f.check} ${f.path} expected=${f.expected || "review"} actual=${f.actual}`);
    if (f.handler) console.log(`  ${f.handler}`);
    if (f.detail) console.log(`  ${f.detail}`);
  }
}

if (findings.some((f) => ["high", "medium"].includes(f.severity))) {
  process.exit(1);
}
