import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { sha256Hex, randomHex } from "./auth";

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

// ── Google OAuth ─────────────────────────────────────────────────────

/** POST /auth/google — Redirect to Google OAuth consent screen. */
http.route({
  path: "/auth/google",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectBase = process.env.AUTH_REDIRECT_URL;
    if (!clientId || !redirectBase) {
      return errorResponse("Google OAuth not configured", 500);
    }

    const body = await request.json().catch(() => ({}));
    const state = randomHex(16);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${redirectBase}/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "offline",
      prompt: "consent",
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    return jsonResponse({ url, state });
  }),
});

/** GET /auth/google/callback — Handle Google OAuth callback. */
http.route({
  path: "/auth/google/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error || !code) {
      return errorResponse(`OAuth failed: ${error || "no code"}`, 400);
    }

    const clientId = process.env.GOOGLE_CLIENT_ID!;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
    const redirectBase = process.env.AUTH_REDIRECT_URL!;
    const deepLink = process.env.MOBILE_DEEP_LINK || "yaver://oauth-callback";

    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${redirectBase}/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return errorResponse(`Token exchange failed: ${text}`, 502);
    }

    const tokens = await tokenRes.json();

    // Fetch user info
    const userInfoRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );

    if (!userInfoRes.ok) {
      return errorResponse("Failed to fetch user info", 502);
    }

    const userInfo = await userInfoRes.json();

    // Upsert user
    const userId = await ctx.runMutation(api.auth.createOrUpdateUser, {
      email: userInfo.email,
      fullName: userInfo.name || userInfo.email,
      provider: "google",
      providerId: userInfo.id,
      avatarUrl: userInfo.picture,
    });

    // Create session
    const rawToken = randomHex(32);
    const tokenHash = await sha256Hex(rawToken);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    await ctx.runMutation(api.auth.createSession, {
      tokenHash,
      userId,
      expiresAt: Date.now() + thirtyDays,
    });

    // Redirect to mobile deep link with token
    const redirectUrl = `${deepLink}?token=${rawToken}&provider=google`;
    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl },
    });
  }),
});

// ── Microsoft OAuth ──────────────────────────────────────────────────

/** POST /auth/microsoft — Redirect to Microsoft OAuth consent screen. */
http.route({
  path: "/auth/microsoft",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    const redirectBase = process.env.AUTH_REDIRECT_URL;
    if (!clientId || !redirectBase) {
      return errorResponse("Microsoft OAuth not configured", 500);
    }

    const state = randomHex(16);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${redirectBase}/auth/microsoft/callback`,
      response_type: "code",
      scope: "openid email profile User.Read",
      state,
      response_mode: "query",
    });

    const url = `https://login.microsoftonline.com/common/oauth2/v2/authorize?${params.toString()}`;
    return jsonResponse({ url, state });
  }),
});

/** GET /auth/microsoft/callback — Handle Microsoft OAuth callback. */
http.route({
  path: "/auth/microsoft/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error || !code) {
      return errorResponse(
        `OAuth failed: ${error || "no code"}`,
        400
      );
    }

    const clientId = process.env.MICROSOFT_CLIENT_ID!;
    const clientSecret = process.env.MICROSOFT_CLIENT_SECRET!;
    const redirectBase = process.env.AUTH_REDIRECT_URL!;
    const deepLink = process.env.MOBILE_DEEP_LINK || "yaver://oauth-callback";

    // Exchange code for tokens
    const tokenRes = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: `${redirectBase}/auth/microsoft/callback`,
          grant_type: "authorization_code",
        }),
      }
    );

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return errorResponse(`Token exchange failed: ${text}`, 502);
    }

    const tokens = await tokenRes.json();

    // Fetch user info from Microsoft Graph
    const userInfoRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoRes.ok) {
      return errorResponse("Failed to fetch user info", 502);
    }

    const userInfo = await userInfoRes.json();

    // Upsert user
    const userId = await ctx.runMutation(api.auth.createOrUpdateUser, {
      email: userInfo.mail || userInfo.userPrincipalName,
      fullName: userInfo.displayName || userInfo.mail || "Unknown",
      provider: "microsoft",
      providerId: userInfo.id,
    });

    // Create session
    const rawToken = randomHex(32);
    const tokenHash = await sha256Hex(rawToken);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;

    await ctx.runMutation(api.auth.createSession, {
      tokenHash,
      userId,
      expiresAt: Date.now() + thirtyDays,
    });

    // Redirect to mobile deep link with token
    const redirectUrl = `${deepLink}?token=${rawToken}&provider=microsoft`;
    return new Response(null, {
      status: 302,
      headers: { Location: redirectUrl },
    });
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
      publicKey: body.publicKey,
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
    });

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

export default http;
