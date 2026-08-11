// HN-LAUNCH-HIDE-PAID: master gate for every paid/managed-infra web surface.
//
// 2026-08-11: flipped OFF. The monetization audit
// (docs/audits/hetzner-access-and-monetization-2026-08.md) locked Model A —
// Cloud Workspace $29/mo BYOK + Relay Pro $9/mo pooled — and the public
// pricing page is live. Paid infra is reintroduced; the flag stays as the
// single emergency kill switch for the whole paid surface.
//
// Consumers must read THIS constant (never a per-file shadow copy) so the flag
// is one source of truth — a drifted local `const HIDE_PAID_UI = false` is the
// exact parity bug the cross-surface rule exists to prevent.
export const HIDE_PAID_UI = false;

// Guest/sharing and Teams UI. Twins of ENABLE_GUEST_FEATURES /
// ENABLE_TEAM_FEATURES in backend/convex/launchFlags.ts and
// ENABLE_GUEST_FEATURES in desktop/agent/feature_flags.go. All of them ship OFF
// at stage one and must be flipped TOGETHER — a dashboard that offers to invite
// a guest while Convex refuses the mutation and the agent refuses the token is
// worse than one that simply doesn't offer it.
//
// Hiding UI is presentation, not security: the enforcement lives in the Convex
// mutations and the agent middleware, and holds whatever the browser does.
export const ENABLE_GUEST_FEATURES = false;
export const ENABLE_TEAM_FEATURES = false;
