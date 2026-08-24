// ownerAllowlist.ts — single source of truth for "is this email a
// Yaver owner / private-preview account?".
//
// The allowlist is a Convex ENV VAR (comma-separated emails), never a
// hardcoded literal in source: the repo is public and Yaver ships to
// every user, so owner identity must be runtime config, not code
// (see memory feedback_yaver_is_for_everyone). Unset env → returns
// false for everyone → the managed-cloud LemonSqueezy gate stays
// fully fail-closed by default. The owner opts themselves in by
// setting the env var in the Convex dashboard / `convex env set`.
//
// Used by: http.ts isCloudPreviewUser (dev-activate route) and the
// managed-provision billing gate (subscriptions.canProvisionManaged)
// so an owner can develop the full Hetzner create/remove flow without
// a LemonSqueezy subscription.

type OwnerEnv = Record<string, string | undefined>;

// Keep every historically-supported spelling additive. Production has used
// both CLOUD_PREVIEW_OWNER_EMAIL (singular) and CLOUD_PREVIEW_OWNER_EMAILS
// (plural), while browser-preview deployments use the YAVER-prefixed names.
// Picking the first truthy variable made a stale singular value shadow a valid
// plural list, and omitting the plural spelling made the mobile /auth/validate
// response report isOwner=false for a correctly configured owner account.
export function ownerEmails(env: OwnerEnv = process.env): string[] {
  const values = [
    env.CLOUD_PREVIEW_OWNER_EMAIL,
    env.CLOUD_PREVIEW_OWNER_EMAILS,
    env.YAVER_CLOUD_PREVIEW_EMAILS,
    env.NEXT_PUBLIC_YAVER_CLOUD_PREVIEW_EMAILS,
  ];
  return [...new Set(values
    .flatMap((raw) => String(raw || "").split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean))];
}

export function isOwnerEmail(email?: string | null, env: OwnerEnv = process.env): boolean {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const allowed = ownerEmails(env);
  if (allowed.length === 0) return false;
  return allowed.includes(normalized);
}

// Owner by Convex userId — same env-config principle (never a
// hardcoded id). REQUIRED in practice because OAuth accounts
// (Apple/GitHub/GitLab) often have NO email, so an email-only
// allowlist can never match the owner's primary login. Set
// CLOUD_PREVIEW_OWNER_USER_IDS to comma-separated user _id values.
// Unset ⇒ false for everyone (stays fail-closed by default).
export function isOwnerUserId(userId?: string | null, env: OwnerEnv = process.env): boolean {
  const id = (userId ?? "").trim();
  if (!id) return false;
  const raw = env.CLOUD_PREVIEW_OWNER_USER_IDS || "";
  const allowed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(id);
}

// Combined owner check — email OR userId. Use everywhere the
// cloud-preview gate is applied so an emailless owner account works.
export function isOwner(
  email?: string | null,
  userId?: string | null,
  env: OwnerEnv = process.env,
): boolean {
  return isOwnerEmail(email, env) || isOwnerUserId(userId, env);
}
