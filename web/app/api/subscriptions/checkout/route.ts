import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/lib/session";

export async function POST(request: Request) {
  const convexSiteUrl = process.env.CONVEX_SITE_URL;
  if (!convexSiteUrl) {
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 }
    );
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { variantId: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  if (!body.variantId) {
    return NextResponse.json(
      { error: "variantId is required" },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(`${convexSiteUrl}/subscriptions/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ variantId: body.variantId }),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: text || "Failed to create checkout" },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("Checkout error:", err);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
