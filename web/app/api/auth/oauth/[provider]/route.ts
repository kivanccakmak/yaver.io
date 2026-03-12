import { NextResponse } from "next/server";
import {
  type OAuthProvider,
  isProviderConfigured,
  encodeOAuthState,
  buildAuthorizationUrl,
  generateNonce,
} from "@/lib/oauth";

const VALID_PROVIDERS = new Set<OAuthProvider>(["google", "microsoft", "apple"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider: rawProvider } = await params;
  const provider = rawProvider as OAuthProvider;

  if (!VALID_PROVIDERS.has(provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  if (!isProviderConfigured(provider)) {
    return NextResponse.json(
      { error: `${provider} OAuth is not configured` },
      { status: 501 }
    );
  }

  const url = new URL(request.url);
  const client = url.searchParams.get("client") || "web";
  const nonce = generateNonce();

  const state = encodeOAuthState({ nonce, client });
  const authUrl = buildAuthorizationUrl(provider, state);

  const response = NextResponse.redirect(authUrl);
  response.cookies.set("oauth_nonce", nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return response;
}
