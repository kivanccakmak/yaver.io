import { NextResponse } from "next/server";

/**
 * /auth/<CODE> → /auth/device?code=<CODE>
 *
 * The TV's sign-in QR encodes the query form (/auth/device?code=ABCD-1234),
 * but a human looking at the 8-char code on the screen will type
 * `yaver.io/auth/ABCD-1234` — a path that had NO route, so the page 404'd
 * and the TV kept waiting for an approval that never happened (the code was
 * never authorized). This catch-all makes the path form work: any
 * single-segment path under /auth that isn't a real route is treated as a
 * device code and redirected into the approve page. Static routes
 * (/auth/device, /auth/callback, /auth/totp, …) win over this dynamic
 * segment by Next.js precedence, so nothing existing is shadowed.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const raw = String(code || "").trim();
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length === 8) {
    const formatted = `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
    return NextResponse.redirect(`/auth/device?code=${encodeURIComponent(formatted)}`, 307);
  }
  // Not a code-shaped path — land on the code-entry page rather than 404.
  return NextResponse.redirect("/auth/device", 307);
}
