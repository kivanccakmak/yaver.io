// launchFlags.ts — THE one place that turns backend surfaces on and off.
//
// Backend twin of web/lib/launchFlags.ts (HIDE_PAID_UI) and
// desktop/agent/feature_flags.go (ENABLE_GUEST_FEATURES). One constant, flipped
// in one file, governs the whole family. Consumers must import THESE constants
// and never keep a per-file shadow copy — a drifted local `const enabled = true`
// is the exact parity bug the cross-surface rule exists to prevent.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE BACKEND NEEDS ITS OWN SWITCH
// ─────────────────────────────────────────────────────────────────────────────
// The agent's kill switch stops a guest from reaching a MACHINE. It does not
// stop anything from reaching CONVEX — and Convex is a second front door with
// its own public API. A guest invitation can still be created, accepted and
// listed there while every agent refuses the resulting token, which leaves live
// grant rows accumulating against a feature nobody can use, and leaves the
// invite/accept mutations (30-bit codes, unpinned when the invitee has no
// account yet) exposed for no benefit. Gate both ends or you have gated neither.
//
// This is the same lesson as the 2026-07-28 password-reset finding: a guard that
// lives only in an HTTP route handler is bypassable by calling the Convex
// function by name. So these flags are checked INSIDE the mutations, not only
// in http.ts.
//
// ─────────────────────────────────────────────────────────────────────────────
// FLIP ONE CONSTANT TO BRING A FAMILY BACK.
// ─────────────────────────────────────────────────────────────────────────────

// Guest access, guest invitations, host share, project shares, delegated guest
// SDK tokens. OFF for stage-one launch. Mirrors ENABLE_GUEST_FEATURES in
// desktop/agent/feature_flags.go — flip BOTH when reopening, or the phone will
// show an invitation the box then refuses.
export const ENABLE_GUEST_FEATURES = false;

// Teams and team membership. OFF for stage-one launch, and not merely for
// tidiness — as of the 2026-07-28 audit `GET /teams/members` performed no
// membership check at all and returned every member's EMAIL to any signed-in
// caller, and the add-member route checked `isMember` where its own comment
// claimed admin, with an attacker-chosen `role` passed through unvalidated. Do
// not flip this until both are fixed and proven by a test that fails without
// the fix.
export const ENABLE_TEAM_FEATURES = false;

// Thrown by the guards below. A refusal the caller cannot act on is the same
// silent wall the rest of this codebase keeps trying to eliminate, so the
// message names the feature and says it is policy, not breakage.
export function featureDisabledError(feature: string): Error {
  return new Error(
    `${feature} is disabled at launch. It will be re-enabled in a later release — ` +
      `no action is needed on your side.`,
  );
}

/** Throw unless the guest/sharing family is enabled. */
export function requireGuestFeatures(): void {
  if (!ENABLE_GUEST_FEATURES) throw featureDisabledError("Guest and project sharing");
}

/** Throw unless teams are enabled. */
export function requireTeamFeatures(): void {
  if (!ENABLE_TEAM_FEATURES) throw featureDisabledError("Teams");
}

/**
 * Whether an existing grant row should be treated as live.
 *
 * Rows already in the database do not disappear when a flag flips, and a
 * disabled feature whose old rows still authorize is not disabled. Every read
 * path that decides "may this guest reach this thing" must call this, so an
 * invitation accepted last week stops granting access the moment the flag goes
 * off — and starts working again, unchanged, when it comes back on. That is
 * why this cancels rather than deletes: turning the feature off must not
 * destroy the user's data.
 */
export function guestGrantsAreLive(): boolean {
  return ENABLE_GUEST_FEATURES;
}
