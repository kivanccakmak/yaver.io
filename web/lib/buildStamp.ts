/**
 * Which build of the dashboard is this browser actually running?
 *
 * ── The incident this exists to prevent (2026-07-28) ────────────────────────
 *
 * A relay-401 misattribution fix was built, deployed to Cloudflare, and
 * verified present in the served JS — while the user's open tab kept rendering
 * the OLD copy from a cached bundle. Both of us then argued about a bug that
 * was already fixed, because the only version the UI showed was
 * `web/package.json`'s hand-maintained semver, which the deploy does not touch.
 * Two different states — "the fix was never shipped" and "the fix shipped and
 * your tab is stale" — collapsed into the same pixels, and the product offered
 * no way to tell them apart. That is the same unfalsifiable-state defect as a
 * silent `serve`: the inventory (a semver someone types) was reported instead
 * of the operation (the bytes this page was built from).
 *
 * So the stamp is derived from the BUILD, not from a file a human edits:
 * `NEXT_PUBLIC_BUILD_ID` is injected by `scripts/deploy-web.sh` (and by CI) from
 * the git SHA being deployed. If it is absent we say `dev`, never a plausible
 * lie.
 *
 * Rule to keep: whatever a surface prints as its version must be something the
 * deploy sets, so "am I on the new build?" is answered by reading it — never by
 * guessing from behaviour.
 */

/** Short git SHA of the deployed tree, or "dev" for a local/unstamped build. */
export const BUILD_ID: string = (process.env.NEXT_PUBLIC_BUILD_ID || "").trim() || "dev";

/** True when this bundle carries no deploy stamp (local dev, or a build that skipped the env). */
export const BUILD_IS_UNSTAMPED = BUILD_ID === "dev";

/**
 * What to render next to the semver, e.g. "v1.1.162 · a826c3c".
 * Kept as one function so every surface prints the identical shape — a second
 * hand-rolled format string is how the two drift apart.
 */
export function buildLabel(semver: string): string {
  return `v${semver} · ${BUILD_ID}`;
}
