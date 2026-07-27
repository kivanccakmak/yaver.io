package main

const (
	ReasonConnectivityNoViableTransport    = "connectivity.no_viable_transport"
	ReasonConnectivityRelayAuthExpired     = "connectivity.relay.auth_expired"
	ReasonRunnerCodexNotAuthenticated      = "runner.codex.not_authenticated"
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
	// ReasonCapabilityToolchainMissing is the wire contract for "the
	// operation needs a tool this machine does not have". Carried by
	// CapabilityGap.Code on every channel (the /dev/start 412, the
	// /dev/events SSE error frame, /dev/status), and looked up — not
	// regex-matched — by mobile/src/lib/capabilityGap.ts and
	// web/lib/capabilityGap.ts. First client-read reason code in the file.
	ReasonCapabilityToolchainMissing = "capability.toolchain_missing"
)
