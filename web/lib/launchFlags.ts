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

export const ENABLE_TEAM_FEATURES = false;
