import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { sha256Hex } from "./auth";

const http = httpRouter();

// ── Helpers ──────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

/** Extract Bearer token from Authorization header, hash it, and validate. */
async function authenticateRequest(
  ctx: { runQuery: (query: any, args: any) => Promise<any> },
  request: Request
): Promise<{
  userId: string;
  email: string;
  fullName: string;
  provider: string;
  avatarUrl?: string;
} | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const tokenHash = await sha256Hex(token);

  return await ctx.runQuery(api.auth.validateSession, { tokenHash });
}

// ── Password Hashing Helpers (PBKDF2-SHA256) ────────────────────────

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const saltB64 = btoa(String.fromCharCode(...salt));
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return `${saltB64}:${hashB64}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(":");
  if (!saltB64 || !hashB64) return false;
  const encoder = new TextEncoder();
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const computedB64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return computedB64 === hashB64;
}

async function createSessionToken(ctx: { runMutation: (m: any, args: any) => Promise<any> }, userId: any) {
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const tokenHash = await sha256Hex(token);
  const expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
  await ctx.runMutation(api.auth.createSession, { tokenHash, userId, expiresAt });
  return token;
}

// ── Email/Password Auth Endpoints ───────────────────────────────────

/** POST /auth/signup — Email/password signup. */
http.route({
  path: "/auth/signup",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const { email, fullName, password } = body;

    if (!email || !fullName || !password) {
      return errorResponse("Missing required fields", 400);
    }
    if (password.length < 8) {
      return errorResponse("Password must be at least 8 characters", 400);
    }

    const passwordHash = await hashPassword(password);

    let userId;
    try {
      userId = await ctx.runMutation(api.auth.createEmailUser, {
        email: email.toLowerCase().trim(),
        fullName: fullName.trim(),
        passwordHash,
      });
    } catch (e: any) {
      if (e.message?.includes("EMAIL_EXISTS")) {
        return errorResponse("An account with this email already exists", 409);
      }
      return errorResponse("Signup failed", 500);
    }

    const token = await createSessionToken(ctx, userId);
    return jsonResponse({ token, userId: String(userId) });
  }),
});

/** POST /auth/login — Email/password login. */
http.route({
  path: "/auth/login",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return errorResponse("Missing email or password", 400);
    }

    const user = await ctx.runQuery(api.auth.lookupEmailUser, {
      email: email.toLowerCase().trim(),
    });

    if (!user || !user.passwordHash) {
      return errorResponse("Invalid email or password", 401);
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return errorResponse("Invalid email or password", 401);
    }

    // Check if 2FA is enabled
    const fullUser = await ctx.runQuery(api.auth.getUserWithTotp, { userId: user._id });
    if (fullUser?.totpEnabled) {
      const { pendingToken } = await ctx.runMutation(api.totp.createPendingAuth, { userId: user._id });
      return jsonResponse({ requires2fa: true, pendingToken });
    }

    const token = await createSessionToken(ctx, user._id);
    return jsonResponse({ token, userId: user.userId });
  }),
});

// ── Survey Endpoints ────────────────────────────────────────────────

/** POST /survey/submit — Submit developer survey (authed). */
http.route({
  path: "/survey/submit",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const body = await request.json();
    try {
      await ctx.runMutation(api.survey.submitSurvey, {
        tokenHash,
        isDeveloper: body.isDeveloper ?? true,
        fullName: body.fullName,
        languages: body.languages,
        experienceLevel: body.experienceLevel,
        role: body.role,
        companySize: body.companySize,
        useCase: body.useCase,
      });
      return jsonResponse({ ok: true });
    } catch {
      return errorResponse("Failed to submit survey", 500);
    }
  }),
});

/** GET /survey — Get survey status (authed). */
http.route({
  path: "/survey",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const survey = await ctx.runQuery(api.survey.getSurvey, { tokenHash });
    if (!survey) return errorResponse("Unauthorized", 401);
    return jsonResponse(survey);
  }),
});

// ── Auth Endpoints (called by Next.js API routes) ────────────────────

/** POST /auth/upsert-user — Create or update a user (called from web server). */
http.route({
  path: "/auth/upsert-user",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const userId = await ctx.runMutation(api.auth.createOrUpdateUser, {
      email: body.email,
      fullName: body.fullName,
      provider: body.provider,
      providerId: body.providerId,
      avatarUrl: body.avatarUrl,
    });
    return jsonResponse({ userId });
  }),
});

/** POST /auth/create-session — Create a session (called from web server). */
http.route({
  path: "/auth/create-session",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const sessionId = await ctx.runMutation(api.auth.createSession, {
      tokenHash: body.tokenHash,
      userId: body.userId,
      expiresAt: body.expiresAt,
    });
    return jsonResponse({ sessionId });
  }),
});

// ── Profile Update Endpoint ──────────────────────────────────────────

/** POST /auth/update-profile — Update user profile (authed). */
http.route({
  path: "/auth/update-profile",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const body = await request.json();
    try {
      await ctx.runMutation(api.auth.updateProfile, {
        tokenHash,
        fullName: body.fullName,
      });
      return jsonResponse({ ok: true });
    } catch {
      return errorResponse("Failed to update profile", 500);
    }
  }),
});

// ── Auth Validation Endpoint ─────────────────────────────────────────

/** GET /auth/validate — Validate bearer token, return user info. */
http.route({
  path: "/auth/validate",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const user = await authenticateRequest(ctx, request);
    if (!user) {
      return errorResponse("Unauthorized", 401);
    }
    return jsonResponse({ user });
  }),
});

// ── Token Refresh ────────────────────────────────────────────────────

/** POST /auth/refresh — Extend session by 30 days. Returns new expiresAt. */
http.route({
  path: "/auth/refresh",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const result = await ctx.runMutation(api.auth.refreshSession, { tokenHash });
    if (!result) {
      return errorResponse("Session expired or invalid", 401);
    }
    return jsonResponse({ ok: true, expiresAt: result.expiresAt });
  }),
});

// ── Apple Sign-In ────────────────────────────────────────────────────

/** POST /auth/apple-native — Native iOS Apple Sign-In (receives identityToken). */
http.route({
  path: "/auth/apple-native",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const { identityToken, fullName } = body;

    if (!identityToken) {
      return errorResponse("Missing identityToken", 400);
    }

    // Decode Apple's identity token (JWT) to extract email and sub
    const parts = identityToken.split(".");
    if (parts.length !== 3) {
      return errorResponse("Invalid identityToken format", 400);
    }

    let payload: Record<string, unknown>;
    try {
      const decoded = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
      payload = JSON.parse(decoded);
    } catch {
      return errorResponse("Failed to decode identityToken", 400);
    }

    const email = payload.email as string;
    const sub = payload.sub as string;

    if (!email || !sub) {
      return errorResponse("Token missing email or sub", 400);
    }

    // Upsert user
    const userId = await ctx.runMutation(api.auth.createOrUpdateUser, {
      email: email.toLowerCase(),
      fullName: fullName || "",
      provider: "apple",
      providerId: sub,
    });

    // Check if 2FA is enabled
    const totpCheck = await ctx.runQuery(api.auth.getUserWithTotp, { userId });
    if (totpCheck?.totpEnabled) {
      const { pendingToken } = await ctx.runMutation(api.totp.createPendingAuth, { userId });
      return jsonResponse({ requires2fa: true, pendingToken });
    }

    // Create session
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = Array.from(tokenBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const tokenHash = await sha256Hex(token);
    const expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000; // 30 days

    await ctx.runMutation(api.auth.createSession, {
      tokenHash,
      userId,
      expiresAt,
    });

    return jsonResponse({ token, userId });
  }),
});

/** POST /auth/apple-notifications — Apple sends account events here. */
http.route({
  path: "/auth/apple-notifications",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    console.log("Apple notification received:", JSON.stringify(body));
    return new Response(null, { status: 200 });
  }),
});

// ── Device Endpoints ─────────────────────────────────────────────────

/** POST /devices/register — Register a device (authed). */
http.route({
  path: "/devices/register",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const body = await request.json();
    const deviceId = await ctx.runMutation(api.devices.registerDevice, {
      tokenHash,
      deviceId: body.deviceId,
      name: body.name,
      platform: body.platform,
      publicKey: body.publicKey || undefined,
      quicHost: body.quicHost,
      quicPort: body.quicPort,
    });

    return jsonResponse({ deviceId });
  }),
});

/** POST /devices/heartbeat — Device heartbeat (authed). */
http.route({
  path: "/devices/heartbeat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const body = await request.json();
    await ctx.runMutation(api.devices.heartbeat, {
      tokenHash,
      deviceId: body.deviceId,
      runners: body.runners,
      quicHost: body.quicHost || undefined,
    });

    // Auto-extend session on heartbeat (keeps CLI sessions alive indefinitely)
    await ctx.runMutation(api.auth.refreshSession, { tokenHash }).catch(() => {});

    return jsonResponse({ ok: true });
  }),
});

/** GET /devices/list — List user's devices (authed). */
http.route({
  path: "/devices/list",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const devices = await ctx.runQuery(api.devices.listMyDevices, {
      tokenHash,
    });

    return jsonResponse({ devices });
  }),
});

/** POST /devices/offline — Mark device offline (authed). */
http.route({
  path: "/devices/offline",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const body = await request.json();
    await ctx.runMutation(api.devices.markOffline, {
      tokenHash,
      deviceId: body.deviceId,
    });

    return jsonResponse({ ok: true });
  }),
});

/** POST /devices/remove — Remove a device (authed). */
http.route({
  path: "/devices/remove",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const body = await request.json();
    await ctx.runMutation(api.devices.removeDevice, {
      tokenHash,
      deviceId: body.deviceId,
    });

    return jsonResponse({ ok: true });
  }),
});

// ── Device Metrics & Events ──────────────────────────────────────────

/** POST /devices/metrics — Report CPU/RAM metrics (authed, called by agent every 60s). */
http.route({
  path: "/devices/metrics",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const body = await request.json();
    try {
      await ctx.runMutation(api.deviceMetrics.report, {
        tokenHash,
        deviceId: body.deviceId,
        cpuPercent: body.cpuPercent,
        memoryUsedMb: body.memoryUsedMb,
        memoryTotalMb: body.memoryTotalMb,
      });
      return jsonResponse({ ok: true });
    } catch (e: any) {
      return errorResponse(e.message || "Failed to report metrics", 500);
    }
  }),
});

/** GET /devices/metrics?deviceId=xxx — Get metrics for a device (authed). */
http.route({
  path: "/devices/metrics",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const url = new URL(request.url);
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) return errorResponse("deviceId required", 400);

    const metrics = await ctx.runQuery(api.deviceMetrics.getMetrics, {
      tokenHash,
      deviceId,
    });
    return jsonResponse({ metrics });
  }),
});

/** POST /devices/event — Record a device event (crash, restart, etc.) (authed). */
http.route({
  path: "/devices/event",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const body = await request.json();
    try {
      await ctx.runMutation(api.deviceEvents.record, {
        tokenHash,
        deviceId: body.deviceId,
        event: body.event,
        details: body.details,
      });
      return jsonResponse({ ok: true });
    } catch (e: any) {
      return errorResponse(e.message || "Failed to record event", 500);
    }
  }),
});

/** GET /devices/events?deviceId=xxx — Get recent events for a device (authed). */
http.route({
  path: "/devices/events",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const url = new URL(request.url);
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) return errorResponse("deviceId required", 400);

    const events = await ctx.runQuery(api.deviceEvents.getEvents, {
      tokenHash,
      deviceId,
    });
    return jsonResponse({ events });
  }),
});

/** POST /usage/record — Record runner usage when a task finishes (authed). */
http.route({
  path: "/usage/record",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const body = await request.json();
    try {
      await ctx.runMutation(api.runnerUsage.record, {
        tokenHash,
        deviceId: body.deviceId,
        taskId: body.taskId,
        runner: body.runner,
        model: body.model,
        durationSec: body.durationSec,
        startedAt: body.startedAt,
        finishedAt: body.finishedAt,
        source: body.source,
      });
      return jsonResponse({ ok: true });
    } catch (e: any) {
      return errorResponse(e.message || "Failed to record usage", 500);
    }
  }),
});

/** GET /usage — Get usage summary with daily aggregation (authed). */
http.route({
  path: "/usage",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const url = new URL(request.url);
    const since = url.searchParams.get("since");

    const usage = await ctx.runQuery(api.runnerUsage.getUsage, {
      tokenHash,
      since: since ? parseInt(since) : undefined,
    });
    return jsonResponse(usage);
  }),
});

/** POST /devices/runner-down — Set runner down/up flag (authed). */
http.route({
  path: "/devices/runner-down",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    const body = await request.json();
    try {
      await ctx.runMutation(api.devices.setRunnerDown, {
        tokenHash,
        deviceId: body.deviceId,
        runnerDown: body.runnerDown,
      });
      return jsonResponse({ ok: true });
    } catch (e: any) {
      return errorResponse(e.message || "Failed to update runner status", 500);
    }
  }),
});

// ── Logout (delete all sessions) ─────────────────────────────────────

/** POST /auth/logout — Delete all sessions for the authenticated user. */
http.route({
  path: "/auth/logout",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    try {
      await ctx.runMutation(api.auth.deleteAllSessions, { tokenHash });
      return jsonResponse({ ok: true });
    } catch {
      return errorResponse("Failed to logout", 500);
    }
  }),
});

// ── Account Deletion ────────────────────────────────────────────────

/** POST /auth/delete-account — Delete user account and all data (authed). */
http.route({
  path: "/auth/delete-account",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return errorResponse("Unauthorized", 401);
    }
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);

    try {
      await ctx.runMutation(api.auth.deleteAccount, { tokenHash });
      return jsonResponse({ ok: true });
    } catch {
      return errorResponse("Failed to delete account", 500);
    }
  }),
});

// ── Auth Logging (unauthenticated — for debugging OAuth) ───────────

/** POST /auth/log — Log an auth event (unauthenticated, called from web OAuth flow). */
http.route({
  path: "/auth/log",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const body = await request.json();
      await ctx.runMutation(api.authLogs.writeLog, {
        level: body.level || "info",
        provider: body.provider || "unknown",
        step: body.step || "unknown",
        message: body.message || "",
        details: body.details ? String(body.details).slice(0, 2000) : undefined,
      });
      return jsonResponse({ ok: true });
    } catch (e) {
      console.error("Auth log error:", e);
      return jsonResponse({ ok: false }, 500);
    }
  }),
});

// ── User Settings ───────────────────────────────────────────────────

http.route({
  path: "/settings",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return errorResponse("Unauthorized", 401);
    const tokenHash = await sha256Hex(authHeader.slice(7));
    const settings = await ctx.runQuery(api.userSettings.getByToken, { tokenHash });
    return jsonResponse({
      ok: true,
      settings: settings || { forceRelay: false, runnerId: undefined, customRunnerCommand: undefined, relayUrl: undefined, relayPassword: undefined, tunnelUrl: undefined },
    });
  }),
});

http.route({
  path: "/settings",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return errorResponse("Unauthorized", 401);
    const tokenHash = await sha256Hex(authHeader.slice(7));
    const body = await request.json();
    await ctx.runMutation(api.userSettings.setByToken, {
      tokenHash,
      forceRelay: body.forceRelay,
      runnerId: body.runnerId,
      customRunnerCommand: body.customRunnerCommand,
      relayUrl: body.relayUrl,
      relayPassword: body.relayPassword,
      tunnelUrl: body.tunnelUrl,
      speechProvider: body.speechProvider,
      speechApiKey: body.speechApiKey,
      ttsEnabled: body.ttsEnabled,
      verbosity: body.verbosity,
      keyStorage: body.keyStorage,
    });
    return jsonResponse({ ok: true });
  }),
});

// ── Mobile Stream Logs ──────────────────────────────────────────────

http.route({
  path: "/mobile/log",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const body = await request.json();
      // Best-effort user identification
      let userId: string | undefined;
      const user = await authenticateRequest(ctx, request);
      if (user) userId = user.userId;

      await ctx.runMutation(api.mobileStreamLogs.writeLog, {
        userId,
        platform: body.platform || "unknown",
        appVersion: body.appVersion || "unknown",
        buildNumber: body.buildNumber || "unknown",
        level: body.level || "info",
        step: body.step || "unknown",
        message: body.message || "",
        details: body.details ? String(body.details).slice(0, 2000) : undefined,
      });
      return jsonResponse({ ok: true });
    } catch (e) {
      console.error("Mobile log error:", e);
      return jsonResponse({ ok: false }, 500);
    }
  }),
});

// ── Developer Logs (developer-only debugging) ──────────────────────

/** POST /dev/log — Write a developer log (only accepted from developer emails). */
http.route({
  path: "/dev/log",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const body = await request.json();
      // Best-effort user identification
      let email: string | undefined = body.email;
      let userId: string | undefined;
      const user = await authenticateRequest(ctx, request);
      if (user) {
        email = user.email;
        userId = user.userId;
      }

      await ctx.runMutation(api.developerLogs.writeLog, {
        email,
        userId,
        source: body.source || "agent",
        level: body.level || "info",
        tag: body.tag || "general",
        message: body.message || "",
        data: body.data ? String(body.data).slice(0, 8000) : undefined,
      });
      return jsonResponse({ ok: true });
    } catch (e) {
      console.error("Dev log error:", e);
      return jsonResponse({ ok: false }, 500);
    }
  }),
});

/** GET /dev/logs — Read developer logs (no auth — dev-only data). */
http.route({
  path: "/dev/logs",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const email = url.searchParams.get("email") || undefined;
    const logs = await ctx.runQuery(api.developerLogs.getLogs, { limit, email });
    return jsonResponse({ logs });
  }),
});

// ── TOTP 2FA Endpoints ──────────────────────────────────────────────

/** POST /auth/totp/setup — Generate TOTP secret (authenticated). */
http.route({
  path: "/auth/totp/setup",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return errorResponse("Unauthorized", 401);
    const tokenHash = await sha256Hex(authHeader.slice(7));

    try {
      const result = await ctx.runMutation(api.totp.setupTotp, { tokenHash });
      return jsonResponse(result);
    } catch (e: any) {
      return errorResponse(e.message || "Failed to setup TOTP", 400);
    }
  }),
});

/** POST /auth/totp/enable — Verify code and enable 2FA (authenticated). */
http.route({
  path: "/auth/totp/enable",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return errorResponse("Unauthorized", 401);
    const tokenHash = await sha256Hex(authHeader.slice(7));

    const body = await request.json();
    if (!body.code) return errorResponse("code required", 400);

    try {
      const result = await ctx.runMutation(api.totp.verifyAndEnableTotp, {
        tokenHash,
        code: body.code,
      });
      return jsonResponse(result);
    } catch (e: any) {
      if (e.message === "INVALID_CODE") return errorResponse("Invalid verification code", 401);
      return errorResponse(e.message || "Failed to enable TOTP", 400);
    }
  }),
});

/** POST /auth/totp/disable — Disable 2FA (authenticated, requires TOTP code). */
http.route({
  path: "/auth/totp/disable",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return errorResponse("Unauthorized", 401);
    const tokenHash = await sha256Hex(authHeader.slice(7));

    const body = await request.json();
    if (!body.code) return errorResponse("code required", 400);

    try {
      await ctx.runMutation(api.totp.disableTotp, { tokenHash, code: body.code });
      return jsonResponse({ ok: true });
    } catch (e: any) {
      if (e.message === "INVALID_CODE") return errorResponse("Invalid verification code", 401);
      return errorResponse(e.message || "Failed to disable TOTP", 400);
    }
  }),
});

/** GET /auth/totp/status — Get 2FA status (authenticated). */
http.route({
  path: "/auth/totp/status",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return errorResponse("Unauthorized", 401);
    const tokenHash = await sha256Hex(authHeader.slice(7));

    const status = await ctx.runQuery(api.totp.getTotpStatus, { tokenHash });
    if (!status) return errorResponse("Unauthorized", 401);
    return jsonResponse(status);
  }),
});

/** POST /auth/totp/check-user — Check if a user has 2FA enabled (server-to-server, takes userId). */
http.route({
  path: "/auth/totp/check-user",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    if (!body.userId) return errorResponse("userId required", 400);
    const result = await ctx.runQuery(api.auth.getUserWithTotp, { userId: body.userId });
    return jsonResponse({ totpEnabled: result?.totpEnabled ?? false });
  }),
});

/** POST /auth/totp/create-pending — Create a pending auth for 2FA (server-to-server, takes userId). */
http.route({
  path: "/auth/totp/create-pending",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    if (!body.userId) return errorResponse("userId required", 400);
    const result = await ctx.runMutation(api.totp.createPendingAuth, { userId: body.userId });
    return jsonResponse(result);
  }),
});

/** POST /auth/verify-totp — Verify TOTP for pending auth, get session token (unauthenticated). */
http.route({
  path: "/auth/verify-totp",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    if (!body.pendingToken || !body.code) {
      return errorResponse("pendingToken and code required", 400);
    }

    try {
      const result = await ctx.runMutation(api.totp.verifyTotpForLogin, {
        pendingToken: body.pendingToken,
        code: body.code,
      });
      return jsonResponse(result);
    } catch (e: any) {
      if (e.message === "INVALID_CODE") return errorResponse("Invalid code", 401);
      if (e.message === "INVALID_PENDING") return errorResponse("Invalid or expired session", 404);
      if (e.message === "PENDING_EXPIRED") return errorResponse("Session expired, please login again", 410);
      if (e.message === "TOO_MANY_ATTEMPTS") return errorResponse("Too many attempts, please login again", 429);
      return errorResponse(e.message || "Verification failed", 400);
    }
  }),
});

// ── Device Code Auth (Headless) ─────────────────────────────────────

/** POST /auth/device-code — Create a new device code for headless auth (unauthenticated). */
http.route({
  path: "/auth/device-code",
  method: "POST",
  handler: httpAction(async (ctx) => {
    const result = await ctx.runMutation(api.deviceCode.createDeviceCode, {});
    return jsonResponse(result);
  }),
});

/** GET /auth/device-code/poll — Poll device code status (unauthenticated, called by CLI). */
http.route({
  path: "/auth/device-code/poll",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const deviceCode = url.searchParams.get("device_code");
    if (!deviceCode) {
      return errorResponse("device_code required", 400);
    }
    const result = await ctx.runMutation(api.deviceCode.pollDeviceCode, { deviceCode });
    return jsonResponse(result);
  }),
});

/** POST /auth/device-code/authorize — Authorize a device code (authenticated). */
http.route({
  path: "/auth/device-code/authorize",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const user = await authenticateRequest(ctx, request);
    if (!user) {
      return errorResponse("Unauthorized", 401);
    }

    const body = await request.json();
    const { userCode } = body;
    if (!userCode) {
      return errorResponse("userCode required", 400);
    }

    // Look up the user's _id from the session
    const authHeader = request.headers.get("Authorization")!;
    const token = authHeader.slice(7);
    const tokenHash = await sha256Hex(token);
    const session = await ctx.runQuery(api.auth.validateSession, { tokenHash });
    if (!session) {
      return errorResponse("Unauthorized", 401);
    }

    // We need the user's document _id for the mutation. Get it via a dedicated query.
    const userDoc = await ctx.runQuery(api.auth.getUserDocId, { tokenHash });
    if (!userDoc) {
      return errorResponse("User not found", 404);
    }

    try {
      await ctx.runMutation(api.deviceCode.authorizeDeviceCode, {
        userCode: userCode.toUpperCase().trim(),
        userId: userDoc,
      });
      return jsonResponse({ ok: true });
    } catch (e: any) {
      if (e.message === "INVALID_CODE") return errorResponse("Invalid code", 404);
      if (e.message === "CODE_EXPIRED") return errorResponse("Code expired", 410);
      if (e.message === "CODE_ALREADY_USED") return errorResponse("Code already used", 409);
      return errorResponse("Failed to authorize", 500);
    }
  }),
});

// ── Download Endpoints ──────────────────────────────────────────────

/** GET /downloads/list — List all available downloads (public, no auth). */
http.route({
  path: "/downloads/list",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const downloads = await ctx.runQuery(api.downloads.listDownloads, {});
    return new Response(JSON.stringify({ downloads }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }),
});

// ── Platform Config ──────────────────────────────────────────────────

/** GET /config — Public platform config (relay servers, runners, models). No auth required. */
http.route({
  path: "/config",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const [config, runners, models] = await Promise.all([
      ctx.runQuery(api.platformConfig.getClientConfig, {}),
      ctx.runQuery(api.aiRunners.list, {}),
      ctx.runQuery(api.aiModels.list, {}),
    ]);
    // Parse relay_servers from JSON string to array for client convenience
    let relayServers: unknown[] = [];
    if (config.relay_servers) {
      try {
        relayServers = JSON.parse(config.relay_servers);
      } catch {
        // ignore parse errors
      }
    }
    return new Response(
      JSON.stringify({
        relayServers,
        runners,
        models,
        cliVersion: config.cli_version || null,
        mobileVersion: config.mobile_version || null,
        relayVersion: config.relay_version || null,
        webVersion: config.web_version || null,
        backendVersion: config.backend_version || null,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          // Cache for 5 minutes — config doesn't change often
          "Cache-Control": "public, max-age=300",
        },
      }
    );
  }),
});

// ── AI Runners ──────────────────────────────────────────────────────

/** GET /runners — List all AI runners (public, no auth). */
http.route({
  path: "/runners",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const runners = await ctx.runQuery(api.aiRunners.list, {});
    return jsonResponse({ runners });
  }),
});

/** POST /runners/seed — Seed predefined AI runners (idempotent, no auth). */
http.route({
  path: "/runners/seed",
  method: "POST",
  handler: httpAction(async (ctx) => {
    await ctx.runMutation(api.aiRunners.seed, {});
    return jsonResponse({ ok: true });
  }),
});

// ── AI Models ────────────────────────────────────────────────────────

/** GET /models — List all AI models (public, no auth). */
http.route({
  path: "/models",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const models = await ctx.runQuery(api.aiModels.list, {});
    return jsonResponse({ models });
  }),
});

/** POST /models/seed — Seed predefined AI models (idempotent, no auth). */
http.route({
  path: "/models/seed",
  method: "POST",
  handler: httpAction(async (ctx) => {
    await ctx.runMutation(api.aiModels.seed, {});
    return jsonResponse({ ok: true });
  }),
});

// ── Subscription & Managed Relay ─────────────────────────────────────

/** Generate a random relay password. */
function generateRelayPassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** POST /webhooks/lemonsqueezy — LemonSqueezy webhook (no auth — validated by signature). */
http.route({
  path: "/webhooks/lemonsqueezy",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Verify webhook signature
    const signature = request.headers.get("x-signature");
    const body = await request.text();

    // TODO: Verify HMAC signature with LEMONSQUEEZY_WEBHOOK_SECRET env var
    // For now, check basic structure

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    const eventName = payload.meta?.event_name;
    const data = payload.data?.attributes;

    if (!eventName || !data) {
      return errorResponse("Invalid payload", 400);
    }

    // Extract user email from custom data or customer email
    const userEmail = payload.meta?.custom_data?.user_email || data.user_email;
    if (!userEmail) {
      return errorResponse("No user email", 400);
    }

    // Find user by email
    const user = await ctx.runQuery(internal.auth.getUserByEmail, { email: userEmail });
    if (!user) {
      return errorResponse("User not found", 404);
    }

    const lemonSqueezyId = String(payload.data.id);
    const customerId = String(data.customer_id);

    switch (eventName) {
      case "subscription_created":
      case "subscription_updated":
      case "subscription_resumed": {
        const plan = data.variant_name?.includes("yearly") ? "relay-yearly" : "relay-monthly";
        const status = data.status === "active" ? "active" : data.status === "past_due" ? "past_due" : "active";
        const periodEnd = new Date(data.renews_at || data.ends_at).getTime();

        const subId = await ctx.runMutation(internal.subscriptions.upsertFromWebhook, {
          lemonSqueezyId,
          lemonSqueezyCustomerId: customerId,
          userId: user._id,
          plan,
          status,
          currentPeriodEnd: periodEnd,
        });

        // If new subscription, create managed relay
        if (eventName === "subscription_created") {
          const password = generateRelayPassword();
          await ctx.runMutation(internal.managedRelays.create, {
            userId: user._id,
            subscriptionId: subId,
            region: payload.meta?.custom_data?.region || "eu",
            password,
          });
          // TODO: Trigger Hetzner provisioning via action
        }
        break;
      }

      case "subscription_cancelled":
      case "subscription_expired": {
        await ctx.runMutation(internal.subscriptions.cancel, { lemonSqueezyId });
        break;
      }

      case "subscription_payment_failed": {
        await ctx.runMutation(internal.subscriptions.upsertFromWebhook, {
          lemonSqueezyId,
          lemonSqueezyCustomerId: customerId,
          userId: user._id,
          plan: "relay-monthly",
          status: "past_due",
          currentPeriodEnd: Date.now(),
        });
        break;
      }
    }

    return jsonResponse({ ok: true });
  }),
});

/** GET /subscription — Get subscription and managed relay status (authenticated). */
http.route({
  path: "/subscription",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return errorResponse("Unauthorized", 401);
    const tokenHash = await sha256Hex(authHeader.slice(7));

    const session = await ctx.runQuery(api.auth.validateSession, { tokenHash });
    if (!session) return errorResponse("Unauthorized", 401);

    // Get user doc to get _id
    const userDocId = await ctx.runQuery(api.auth.getUserDocId, { tokenHash });
    if (!userDocId) return errorResponse("User not found", 404);

    const [subscription, relay] = await Promise.all([
      ctx.runQuery(api.subscriptions.getByUser, { userId: userDocId }),
      ctx.runQuery(api.managedRelays.getByUser, { userId: userDocId }),
    ]);

    return jsonResponse({
      subscription: subscription ? {
        plan: subscription.plan,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelledAt: subscription.cancelledAt,
      } : null,
      relay: relay ? {
        status: relay.status,
        domain: relay.domain,
        region: relay.region,
        quicPort: relay.quicPort,
        httpPort: relay.httpPort,
      } : null,
    });
  }),
});

export default http;
