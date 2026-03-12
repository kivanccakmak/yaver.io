import { NextResponse } from "next/server";
import {
  type OAuthProvider,
  isProviderConfigured,
  encodeOAuthState,
  buildAuthorizationUrl,
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

  const state = encodeOAuthState({ client });
  const authUrl = buildAuthorizationUrl(provider, state);

  return NextResponse.redirect(authUrl);
}
