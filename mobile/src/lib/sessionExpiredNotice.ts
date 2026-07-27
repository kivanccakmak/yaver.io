// sessionExpiredNotice.ts — the ONE sentence shown when the phone's own
// Convex session was confirmed invalid and the user was signed out.
//
// Audit gap T6 (2026-07): mobile's logout-on-confirmed-revoke was SILENT —
// AuthContext cleared the token and the user simply found themselves on the
// login screen with no explanation, while web has said "Your session expired —
// sign in again." since the dashboard gained `sessionExpired`
// (web/lib/use-auth.ts). Parity: same event, same sentence, both surfaces.
//
// Only the CONFIRMED-invalid paths set this (mount-restore `invalid` verdict,
// notifyAuthFailure's validate-confirmed revoke). Network errors never do —
// they keep the cached session by design.

export const SESSION_EXPIRED_NOTICE =
  "Your session expired — sign in again to continue.";
