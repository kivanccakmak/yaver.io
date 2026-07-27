// rateLimiter.ts — a self-contained, dependency-free fixed-window rate limiter.
//
// Yaver is public open source and launching on HN: anyone can read the code
// and hammer the HTTP routes. Convex bills per function call + bandwidth, so
// an uncapped loop against a cheap endpoint is a direct bill-amplification
// attack. This is the shared guard those endpoints call.
//
// Design:
//   - One `rateLimits` table, keyed by an opaque bucket string the caller
//     builds (e.g. `signup:ip:<ip>` or `deviceCode:global`). Fixed window:
//     the row records the window start and a count; a request in a new window
//     resets both. Convex mutations are transactional per document, so the
//     read-modify-write is atomic — no lost updates under concurrency.
//   - httpActions cannot touch the db directly, so they call the
//     `enforceRateLimit` internalMutation. Queries/mutations can call
//     `checkAndBump` inline.
//   - FAIL-CLOSED on the limit, FAIL-OPEN on internal error: a limiter bug
//     must never lock every user out of signup — but a caller that reaches
//     the cap is refused.
//
// It is deliberately NOT the @convex-dev/rate-limiter component: that needs a
// convex.config.ts component wiring this repo doesn't have, and a launch guard
// should be one readable file with no new moving parts.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// clientIpFromRequest — best-effort caller IP for per-IP buckets. Convex sits
// behind its own edge, so X-Forwarded-For's FIRST hop is the real client.
// Never trust it for auth (spoofable) — only for coarse rate-limit buckets,
// where the worst case of a spoofed IP is the attacker rate-limiting a
// stranger's bucket, which the per-route global bucket still backstops.
export function clientIpFromRequest(request: Request): string {
  const xff = request.headers.get("X-Forwarded-For") || "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first.slice(0, 64);
  const real = request.headers.get("X-Real-IP")?.trim();
  return (real || "unknown").slice(0, 64);
}

// checkAndBumpRateLimit — the core primitive, callable from any mutation.
// Returns { allowed, remaining, retryAfterMs }. `now` is passed in so it is
// deterministic/testable (Convex mutations may not read wall-clock freely at
// module load, but Date.now() inside a handler is fine).
export async function checkAndBumpRateLimit(
  ctx: { db: any },
  bucket: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  try {
    const key = bucket.slice(0, 200);
    const existing = await ctx.db
      .query("rateLimits")
      .withIndex("by_key", (q: any) => q.eq("key", key))
      .first();

    if (!existing || now - existing.windowStart >= windowMs) {
      // New or expired window.
      if (existing) {
        await ctx.db.patch(existing._id, { windowStart: now, count: 1 });
      } else {
        await ctx.db.insert("rateLimits", { key, windowStart: now, count: 1 });
      }
      return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterMs: 0 };
    }

    if (existing.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, existing.windowStart + windowMs - now),
      };
    }

    await ctx.db.patch(existing._id, { count: existing.count + 1 });
    return { allowed: true, remaining: Math.max(0, limit - existing.count - 1), retryAfterMs: 0 };
  } catch {
    // Fail-open: a limiter fault must never become a global outage.
    return { allowed: true, remaining: limit, retryAfterMs: 0 };
  }
}

// enforceRateLimit — the internalMutation httpActions call before doing real
// work. Named limits keep the windows in ONE place so every route agrees.
export const NAMED_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  // Coarse per-IP account/auth abuse guards. Generous enough for a real human
  // retrying, tight enough to make a scripted loop pointless.
  "auth-signup-ip": { limit: 20, windowMs: 60 * 60 * 1000 }, // 20 signups/hr/IP
  "auth-login-ip": { limit: 60, windowMs: 10 * 60 * 1000 }, // 60 login tries/10min/IP
  "auth-email-ip": { limit: 10, windowMs: 60 * 60 * 1000 }, // 10 verification emails/hr/IP
  "device-code-ip": { limit: 30, windowMs: 60 * 60 * 1000 }, // 30 headless-auth starts/hr/IP
  "oauth-callback-ip": { limit: 120, windowMs: 60 * 60 * 1000 }, // OAuth round-trips/hr/IP
  // Anonymous landing-page help widget → real OpenRouter $ per call.
  "chat-ip": { limit: 20, windowMs: 10 * 60 * 1000 }, // 20 msgs/10min/IP
  "chat-global": { limit: 400, windowMs: 10 * 60 * 1000 }, // botnet backstop
  // Global backstops: even across many IPs, a route can't run away. Sized far
  // above real aggregate load, so they only trip under a botnet-scale flood.
  "auth-signup-global": { limit: 500, windowMs: 60 * 60 * 1000 },
  "device-code-global": { limit: 2000, windowMs: 60 * 60 * 1000 },
};

export const enforceRateLimit = internalMutation({
  args: { limitName: v.string(), subject: v.string() },
  handler: async (ctx, { limitName, subject }) => {
    const cfg = NAMED_LIMITS[limitName];
    if (!cfg) return { allowed: true, remaining: 0, retryAfterMs: 0 }; // unknown = no limit configured
    return checkAndBumpRateLimit(ctx, `${limitName}:${subject}`, cfg.limit, cfg.windowMs, Date.now());
  },
});
