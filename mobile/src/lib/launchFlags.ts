// HN-LAUNCH-HIDE-PAID: temporarily hide managed-cloud / billing / pricing /
// "buy a box" surfaces so the mobile app reads as pure free + open-source +
// self-hosted for the HN launch. Flip HIDE_PAID_UI to `false` to restore every
// Yaver-billed managed-cloud entry point. (grep this token to find every gated
// surface across web + mobile.)
//
// SCOPE: this flag hides only the MANAGED (Yaver-billed) buy/checkout/credit /
// "Yaver Cloud" purchase surfaces and their nav entry points. It must NOT hide
// BYO / self-host functionality — connecting your own machines, BYO Hetzner-
// token provisioning, self-hosted relay config, claiming your own devices.
// Those are the free self-hosted story and stay visible.
//
// Mirrors the identical `HIDE_PAID_UI` flag in web/app/page.tsx.
//
// 2026-08-11: FLIPPED OFF. Monetization is live (Cloud Workspace $29/mo BYOK +
// Relay Pro $9/mo pooled — docs/audits/hetzner-access-and-monetization-2026-08.md);
// the web flag was already false (commit 901d8106f), this restores mobile to
// match. The flag stays as the single emergency kill switch for the whole paid
// surface.
export const HIDE_PAID_UI = false;

// Guest/share UI is closed for v1. Backend and agent enforcement are already
// fail-closed; this flag keeps mobile from advertising flows that Convex and
// the agent refuse.
export const ENABLE_GUEST_FEATURES = false;
