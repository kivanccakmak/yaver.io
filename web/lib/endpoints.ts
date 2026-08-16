/**
 * endpoints.ts — THE ONE predicate for "is this published device endpoint
 * worth probing from a browser?".
 *
 * This codebase's defining bug is the duplicated derive: the same filter
 * hand-copied into DevicesView, page.tsx, and agent-client.ts, each copy
 * drifting on its own. This module is the single source; every union of
 * `device.publicEndpoints ∪ device.tunnelUrl` must go through it (the
 * endpoints.test.ts structural checks pin the call sites).
 *
 * Two classes of endpoint are known-dead before we even dial:
 *
 *  1. `<id>.dev.yaver.io` (any label depth under dev.yaver.io) — Cloudflare
 *     universal SSL covers *.yaver.io ONE level deep only, so the wildcard
 *     cert for *.dev.yaver.io does not exist. Probing fails at TLS handshake
 *     and floods the console with "access control checks" errors. A seed
 *     mutation populated 839 devices with these ahead of cert provisioning.
 *
 *  2. `<36-char-uuid>.yaver.io` — there is NO wildcard *.yaver.io DNS record.
 *     These stale rows (pre path-style `public.yaver.io/d/<id>` migration)
 *     can never resolve; probing them spams NXDOMAIN / CORS console errors
 *     on every Devices-tab open (live incident 2026-07-28).
 *
 * Anything else — `public.yaver.io`, path-style `public.yaver.io/d/<id>`,
 * custom tunnels, self-hosted relay domains, private-network serve URLs —
 * is fine and stays.
 */

/** `<uuid>.yaver.io` and `<uuid>.dev.yaver.io` — device-id subdomains that
 *  have no DNS (no wildcard *.yaver.io) and can never work. */
const DEAD_UUID_SUBDOMAIN_RE =
  /^https?:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(dev\.)?yaver\.io(\/|$)/i;

/** Any-label endpoints under dev.yaver.io — wildcard cert not provisioned. */
const DEAD_DEV_SUBDOMAIN_RE = /^https?:\/\/[^/]+\.dev\.yaver\.io(\/|$)/i;

/** True when a published endpoint is worth dialing from a browser; false for
 *  endpoint shapes that are known-dead before the first packet. */
export function isUsablePublicEndpoint(endpoint: string): boolean {
  const ep = String(endpoint || "").trim();
  if (!ep) return false;
  if (DEAD_UUID_SUBDOMAIN_RE.test(ep)) return false;
  if (DEAD_DEV_SUBDOMAIN_RE.test(ep)) return false;
  return true;
}

/** Canonical `publicEndpoints ∪ tunnelUrl` union: trimmed, deduped, and
 *  filtered through isUsablePublicEndpoint. Use this instead of hand-rolling
 *  the union at each call site. */
export function usableTunnelUrls(
  publicEndpoints: unknown,
  tunnelUrl?: string | null,
): string[] {
  const raw = [
    ...(Array.isArray(publicEndpoints) ? publicEndpoints : []),
    ...(tunnelUrl ? [tunnelUrl] : []),
  ];
  return Array.from(
    new Set(raw.map((url) => String(url || "").trim()).filter(Boolean)),
  ).filter(isUsablePublicEndpoint);
}
