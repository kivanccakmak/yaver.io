package main

import "os"

// feature_flags.go — THE one place that turns product surfaces on and off.
//
// Mirrors web/lib/launchFlags.ts (HIDE_PAID_UI): one constant, flipped in one
// file, governs the whole family. Consumers must read THESE constants and never
// keep a per-file shadow copy — a drifted local `const enableGuest = true` is
// the exact parity bug the cross-surface rule exists to prevent.
//
// ─────────────────────────────────────────────────────────────────────────────
// FLIP THIS ONE CONSTANT TO TURN EVERY GUEST FEATURE BACK ON.
// ─────────────────────────────────────────────────────────────────────────────
//
// Launch decision (2026-07-28): the guest/sharing family is the only way a
// request from someone who is NOT the owner is meant to reach this machine, and
// it is the largest single block of attack surface in the agent. It ships OFF
// for stage one and opens later, deliberately, once each finding below is fixed
// and proven by a test that fails without the fix.
//
// Setting this to true enables ALL of it at once: guest sessions, guest scopes,
// delegated-guest SDK tokens, host share, and support sessions.
const ENABLE_GUEST_FEATURES = false

// ENABLE_DEPLOY_WEBHOOK gates POST /deploy/webhook, which is unauthenticated by
// design (GitHub calls it). Off at launch because it took a caller-supplied
// `project` directory and loaded BOTH the HMAC secret and the shell
// `buildCommand` from `<that dir>/.yaver/deploy.yaml` — so the caller satisfies
// its own signature check, and any repo carrying that file is remote code
// execution. Do not flip this until the project directory is constrained to a
// registered root.
const ENABLE_DEPLOY_WEBHOOK = false

// ENABLE_VAULT gates the encrypted local secret store (`yaver vault`).
//
// OFF for v1. The vault is not in the v1 critical path — auth token, relay
// password, device id and device signing keys all live in config.json and
// device.key, and `serve` has always tolerated an unopenable vault — but its
// failures were loud, recurring and misleading, and it has repeatedly wedged
// the product:
//
//   - a v2 vault is master-key encrypted, so a lost master.key is
//     unrecoverable by design, and the error surfaces arbitrarily later as
//     "wrong passphrase or corrupted vault";
//   - every sign-in used to re-key it toward the auth token and destroy it;
//   - every deploy script consulted it first and swallowed the failure, so a
//     locked vault was reported as a missing credential.
//
// The first two are now fixed and the third removed, but the remaining value
// in v1 is nil: its consumers are peripheral cells (Apple TV, robotics,
// circuit, camera, printer, IR, mesh) that are not v1 surfaces. Leaving it
// enabled means shipping a subsystem that can only cost users something.
//
// OFF means: not opened at boot, not migrated, not re-keyed, and never
// consulted by a cell — which degrades to "not configured", the same path it
// already takes when the vault is locked. Turn it back on with
// YAVER_ENABLE_VAULT=1 on a single box, or flip this constant when the
// Keychain-primary redesign lands.
const ENABLE_VAULT = false

// Per-feature env overrides. These let an operator open ONE feature on ONE box
// without a rebuild; the constants above remain the product-wide default. An
// override can only ever turn something ON, never off — so reading the
// constants tells you the floor, and nothing can silently disable a feature the
// build says is enabled.
const (
	envEnableGuestAccess     = "YAVER_ENABLE_GUEST_ACCESS"
	envEnableHostShare       = "YAVER_ENABLE_HOST_SHARE"
	envEnableSupportSessions = "YAVER_ENABLE_SUPPORT_SESSIONS"
	envEnableDeployWebhook   = "YAVER_ENABLE_DEPLOY_WEBHOOK"
	envEnableVault           = "YAVER_ENABLE_VAULT"
)

// featureEnvEnabled reads an override by env-var NAME. It delegates to the
// existing envTruthy (devicecode.go), which is deliberately strict: only
// explicit affirmatives count, so a stray empty or malformed value fails closed
// instead of opening a feature.
func featureEnvEnabled(name string) bool {
	return envTruthy(os.Getenv(name))
}

// GuestAccessEnabled covers guest session tokens, every guest scope, and
// delegated-guest SDK tokens.
func GuestAccessEnabled() bool {
	return ENABLE_GUEST_FEATURES || featureEnvEnabled(envEnableGuestAccess)
}

// HostShareEnabled covers project sharing into this box. Part of the guest
// family, with its own credential path — and its own findings: its trust
// headers were not stripped from caller input, and its project allowlist failed
// open when empty (both fixed 2026-07-28, but the feature stays off at launch).
func HostShareEnabled() bool {
	return ENABLE_GUEST_FEATURES || featureEnvEnabled(envEnableHostShare)
}

// SupportSessionsEnabled covers TeamViewer-style support sessions. A redeemed
// session is a non-owner credential with file read (and shell when the owner
// opted in), reached through an unauthenticated endpoint whose 6-char code has
// no attempt cap — the rate limiter buckets on the caller-supplied
// Authorization header, so rotating a dummy bearer resets it.
func SupportSessionsEnabled() bool {
	return ENABLE_GUEST_FEATURES || featureEnvEnabled(envEnableSupportSessions)
}

// DeployWebhookEnabled gates the unauthenticated deploy webhook. Not part of
// the guest family — it has its own constant because it has its own defect.
func DeployWebhookEnabled() bool {
	return ENABLE_DEPLOY_WEBHOOK || featureEnvEnabled(envEnableDeployWebhook)
}

// featureDisabledMessage is the single user-facing sentence for a refused
// feature. It names the feature, says it is off by policy rather than broken,
// and names the exact switch — a refusal the user cannot act on is the same
// silent wall this codebase keeps trying to eliminate.
func featureDisabledMessage(feature, envVar string) string {
	return feature + " is disabled on this machine (launch default). " +
		"The owner can enable it by starting the agent with " + envVar + "=1."
}

// VaultEnabled reports whether the local encrypted secret store is available.
// See ENABLE_VAULT for why it ships off in v1.
func VaultEnabled() bool {
	return ENABLE_VAULT || featureEnvEnabled(envEnableVault)
}
