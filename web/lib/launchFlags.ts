// HN-LAUNCH-HIDE-PAID: master gate for every paid/managed-infra web surface.
//
// Launch decision (2026-07-28): Yaver ships as a FREE open-source project on
// the shared public relay — no checkout, no tiers, no billing anywhere in the
// product at launch. Relay Pro, Cloud Workspace, metered CI runners and the
// managed-cloud panels are all gated OFF behind this single flag so there is
// exactly one switch to flip when paid infra is reintroduced later.
//
// Consumers must read THIS constant (never a per-file shadow copy) so the flag
// is one source of truth — a drifted local `const HIDE_PAID_UI = false` is the
// exact parity bug the cross-surface rule exists to prevent.
export const HIDE_PAID_UI = true;
