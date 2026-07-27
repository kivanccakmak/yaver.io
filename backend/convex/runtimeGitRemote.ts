// runtimeGitRemote.ts — sanitize a git remote before it may enter Convex.
// Pure module (no convex/server imports) so node --test can load it directly;
// tested by userSettingsGitRemote.test.mts.
//
// Convex's runtime implements URL parsing but NOT the credential setters —
// assigning to url.username/password/hash throws "Not implemented" and on
// 2026-07-27 killed every runtime catalog sync and the dashboard's "Save
// default". Rebuild the URL from components instead of mutating it:
// credentials and hash are simply never copied over. The companion test
// scans this file to keep the setter pattern out.

export function sanitizeRuntimeGitRemote(value: string | null | undefined): string | undefined {
  const raw = String(value ?? "").trim().slice(0, 300);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`.replace(/\/$/, "");
  } catch {
    // SCP-style SSH remotes (git@github.com:owner/repo.git) are not URLs and
    // contain no bearer credential. If a caller sends a token-like HTTPS remote
    // without a parseable scheme, drop it instead of guessing.
    if (/^https?:/i.test(raw) || /\/\/[^/\s]+@/.test(raw)) return undefined;
    return raw;
  }
}
