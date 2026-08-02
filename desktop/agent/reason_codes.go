package main

const (
	ReasonConnectivityNoViableTransport    = "connectivity.no_viable_transport"
	ReasonConnectivityRelayAuthExpired     = "connectivity.relay.auth_expired"
	ReasonRunnerCodexNotAuthenticated      = "runner.codex.not_authenticated"
	// ReasonRunnerCodexRefreshLineageLost is `invalid_grant` on the refresh
	// exchange: the refresh token this machine holds has been consumed or
	// revoked. A DISTINCT code from not_authenticated on purpose — the remedy
	// differs and so does the cause. It means either the credential was copied
	// to a second machine (each refresh rotates the token, so only one copy
	// survives) or Codex was signed out elsewhere. Retrying cannot help; only a
	// fresh device-auth sign-in on THIS box does. A surface that renders "Try
	// again" over this sends the user into a loop that can never succeed.
	ReasonRunnerCodexRefreshLineageLost = "runner.codex.refresh_lineage_lost"
	// ReasonRunnerCodexRefreshFailed is a TRANSIENT renewal failure — network,
	// 5xx, unparseable body. Distinct from lineage_lost because it IS
	// retryable, and because the credential on disk is untouched and still
	// valid until its own expiry.
	ReasonRunnerCodexRefreshFailed = "runner.codex.refresh_failed"
	// ReasonRunnerCodexCredentialExpired means a credential IS present on this
	// machine and its access token is past `exp` — measured from the JWT on
	// disk, not guessed. Distinct from not_authenticated because the sentence
	// differs even though the remedy does not: telling someone who signed in
	// last week that they are "not signed in" sends them looking for a mistake
	// they did not make.
	ReasonRunnerCodexCredentialExpired = "runner.codex.credential_expired"
	// ReasonRunnerCodexCredentialIsCopy means this machine's Codex credential
	// was mirrored from another machine, so renewing it here would consume the
	// refresh token that machine still holds and sign IT out. The remedy is a
	// device-auth sign-in on this box — not a retry, and not a re-mirror.
	ReasonRunnerCodexCredentialIsCopy = "runner.codex.credential_is_copy"
	// ReasonRunnerCodexCredentialCorrupt is an auth.json that is empty or not
	// parseable — the fingerprint of a process killed mid-write (the OOM shape
	// on a small box). Named separately so the remedy can say "a write was
	// interrupted" instead of sending the reader after a parser bug.
	ReasonRunnerCodexCredentialCorrupt = "runner.codex.credential_corrupt"
	ReasonRunnerCodexLinuxSandboxBlocked   = "runner.codex.linux_sandbox_blocked"
	ReasonRunnerClaudeAuthRequired         = "runner.claude.auth_required"
	ReasonRunnerOpenCodeUnusable           = "runner.opencode.unusable"
	ReasonReloadDevServerUnavailable       = "reload.dev_server_unavailable"
	ReasonReloadNativeRebuildRequired      = "reload.native_rebuild_required"
	ReasonReloadPreviewWorkerOffline       = "reload.preview_worker.offline"
	ReasonBuildHermesFailed                = "build.hermes.failed"
	ReasonBuildNativeFailed                = "build.native.failed"
	ReasonDeployTestFlightXcodeMissing     = "deploy.testflight.xcode_missing"
	ReasonDeployPlaystoreAndroidSDKMissing = "deploy.play.android_sdk_missing"
	ReasonAuthSDKScopeDenied               = "auth.sdk.scope_denied"
	// ReasonAuthSessionScopeDenied is the wire contract for "this session
	// token's companion scope (tv/watch/vision/spatial) forbids this
	// endpoint". Emitted by companionScopeDenied on every scope 403 so
	// surfaces classify by code, not prose. A scope denial is NOT retryable —
	// the client-side remedy is updating the agent on the denying box (the
	// allowlist lives server-side, so skew shows up as this code), never a
	// Try again loop. Seen live 2026-07-27: the TV rendered "Try again" over
	// a 403 that could not ever succeed.
	ReasonAuthSessionScopeDenied = "auth.session.scope_denied"
	// ReasonCapabilityToolchainMissing is the wire contract for "the
	// operation needs a tool this machine does not have". Carried by
	// CapabilityGap.Code on every channel (the /dev/start 412, the
	// /dev/events SSE error frame, /dev/status), and looked up — not
	// regex-matched — by mobile/src/lib/capabilityGap.ts and
	// web/lib/capabilityGap.ts. First client-read reason code in the file.
	ReasonCapabilityToolchainMissing = "capability.toolchain_missing"
	// ReasonCapabilityInsufficientDisk is "the tool is installable here, and
	// this machine does not have the room". A DIFFERENT code from
	// toolchain_missing on purpose: the remedy is not an install, it is
	// reclaiming space, and a client that renders one for the other sends the
	// user to press a button that cannot help. Carried with
	// CapabilityGap.Resource (the numbers) and CapabilityGap.Reclaim (the
	// route that frees them).
	ReasonCapabilityInsufficientDisk = "capability.insufficient_disk"
)
