import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  type OAuthProvider,
  decodeOAuthState,
  exchangeCodeForTokens,
  getUserInfo,
} from "@/lib/oauth";
import {
  createSessionToken,
  hashSessionToken,
  sessionExpiresAtMs,
  SESSION_COOKIE_NAME,
  sessionMaxAgeSeconds,
} from "@/lib/session";

const VALID_PROVIDERS = new Set<OAuthProvider>(["google", "microsoft", "apple"]);

function getBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function errorRedirect(message: string): NextResponse {
  const url = new URL("/auth", getBaseUrl());
  url.searchParams.set("error", message);
  return NextResponse.redirect(url);
}

async function handleCallback(
  provider: OAuthProvider,
  code: string,
  stateParam: string
) {
  const cookieStore = await cookies();
  const storedNonce = cookieStore.get("oauth_nonce")?.value;
  cookieStore.delete("oauth_nonce");

  if (!storedNonce) {
    return errorRedirect("OAuth session expired. Please try again.");
  }

  const state = decodeOAuthState(stateParam);

  if (state.nonce !== storedNonce) {
    return errorRedirect("Invalid OAuth state. Please try again.");
  }

  const tokens = await exchangeCodeForTokens(provider, code);
  const userInfo = await getUserInfo(provider, tokens);

  if (!userInfo.email) {
    return errorRedirect("Could not retrieve email from provider.");
  }

  // Call Convex HTTP endpoints to create user and session
  const convexSiteUrl = process.env.CONVEX_SITE_URL;
  if (!convexSiteUrl) {
    throw new Error("CONVEX_SITE_URL is not set");
  }

  // Upsert user via Convex HTTP action
  const userRes = await fetch(`${convexSiteUrl}/auth/upsert-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: userInfo.email.toLowerCase(),
      fullName: userInfo.name || userInfo.email,
      provider,
      providerId: userInfo.providerId,
      avatarUrl: userInfo.avatarUrl,
    }),
  });

  if (!userRes.ok) {
    const text = await userRes.text();
    throw new Error(`User upsert failed: ${text}`);
  }

  const { userId } = await userRes.json();

  // Create session via Convex HTTP action
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = sessionExpiresAtMs();

  const sessionRes = await fetch(`${convexSiteUrl}/auth/create-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenHash, userId, expiresAt }),
  });

  if (!sessionRes.ok) {
    const text = await sessionRes.text();
    throw new Error(`Session creation failed: ${text}`);
  }

  const baseUrl = getBaseUrl();
  const deepLink = process.env.MOBILE_DEEP_LINK || "yaver://oauth-callback";

  // Mobile client: redirect to deep link
  if (state.client === "mobile") {
    const mobileUrl = new URL(deepLink);
    mobileUrl.searchParams.set("token", token);
    mobileUrl.searchParams.set("provider", provider);
    return NextResponse.redirect(mobileUrl.toString());
  }

  // Desktop CLI client: redirect to local callback server
  if (state.client === "desktop") {
    const localUrl = new URL("http://127.0.0.1:19836/callback");
    localUrl.searchParams.set("token", token);
    localUrl.searchParams.set("provider", provider);
    return NextResponse.redirect(localUrl.toString());
  }

  // Web client: set session cookie and redirect to dashboard
  const dashboardUrl = new URL("/dashboard", baseUrl);
  const response = NextResponse.redirect(dashboardUrl);

  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: sessionMaxAgeSeconds(),
  });

  return response;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider: rawProvider } = await params;
  const provider = rawProvider as OAuthProvider;

  if (!VALID_PROVIDERS.has(provider)) {
    return errorRedirect("Invalid provider");
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return errorRedirect(`OAuth error: ${oauthError}`);
  }

  if (!code || !stateParam) {
    return errorRedirect("Missing authorization code.");
  }

  try {
    return await handleCallback(provider, code, stateParam);
  } catch (err) {
    const message = err instanceof Error ? err.message : "OAuth callback failed";
    console.error("OAuth callback error:", err);
    return errorRedirect(message);
  }
}

// Apple Sign In uses form_post response mode
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider: rawProvider } = await params;
  const provider = rawProvider as OAuthProvider;

  if (provider !== "apple") {
    return errorRedirect("POST callback only supported for Apple");
  }

  const formData = await request.formData();
  const code = formData.get("code") as string | null;
  const stateParam = formData.get("state") as string | null;
  const oauthError = formData.get("error") as string | null;

  if (oauthError) {
    return errorRedirect(`OAuth error: ${oauthError}`);
  }

  if (!code || !stateParam) {
    return errorRedirect("Missing authorization code.");
  }

  try {
    return await handleCallback(provider, code, stateParam);
  } catch (err) {
    const message = err instanceof Error ? err.message : "OAuth callback failed";
    console.error("OAuth callback error:", err);
    return errorRedirect(message);
  }
}
