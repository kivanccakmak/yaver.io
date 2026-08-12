import { NextRequest, NextResponse } from "next/server";

/**
 * Force HTTPS on the yaver.io public worker.
 *
 * Cloudflare serves the zone on BOTH http and https with no zone-level
 * "Always Use HTTPS" rule and no HSTS, so a plain
 * `http://yaver.io/dashboard?tab=chat` request used to get a 200 with no
 * redirect and no HSTS header — the dashboard's auth token and every
 * cookie would happily travel in cleartext. This middleware is the
 * repo-level guard: http → 308 https, and every https response carries
 * Strict-Transport-Security so browsers upgrade subsequent requests.
 *
 * HSTS is deliberately NOT includeSubDomains: subdomains like
 * `public.yaver.io` (the relay) and `<id>.dev.yaver.io` are separate
 * services with their own TLS posture, and forcing them via an apex
 * HSTS pin is a change we have not measured. Only yaver.io and
 * www.yaver.io (both routed to this worker) get the pin.
 *
 * Verified 2026-08-13: before this file, `curl -sI http://yaver.io/dashboard`
 * returned HTTP/1.1 200 with no Strict-Transport-Security.
 */
export function middleware(request: NextRequest) {
  // Cloudflare terminates TLS before the worker; the original scheme is
  // relayed here. Anything else (direct worker access, preview hosts)
  // is already https and passes through untouched.
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  if (proto === "http") {
    const url = new URL(request.url);
    url.protocol = "https:";
    url.host = url.host.replace(/^www\./, ""); // www → apex canonical
    return NextResponse.redirect(url, 308);
  }
  const response = NextResponse.next();
  response.headers.set("Strict-Transport-Security", "max-age=31536000");
  return response;
}

export const config = {
  // Everything except Next.js internals and static assets. Middleware
  // needs to run on the dashboard/app HTML so the browser redirects
  // before any script executes — static files are redirected by the
  // browser itself once the HTML is https.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|apple-touch-icon.png|icon-192.png|icon-512.png|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|mp4|wasm|json)).*)",
  ],
};
