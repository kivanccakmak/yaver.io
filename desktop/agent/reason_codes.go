package main

const (
	ReasonConnectivityNoViableTransport = "connectivity.no_viable_transport"
	ReasonConnectivityRelayAuthExpired  = "connectivity.relay.auth_expired"
	ReasonRunnerCodexNotAuthenticated   = "runner.codex.not_authenticated"
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
	ReasonRunnerCodexCredentialCorrupt   = "runner.codex.credential_corrupt"
	ReasonRunnerCodexLinuxSandboxBlocked = "runner.codex.linux_sandbox_blocked"
	ReasonRunnerClaudeAuthRequired       = "runner.claude.auth_required"
	ReasonRunnerOpenCodeUnusable         = "runner.opencode.unusable"
	ReasonReloadDevServerUnavailable     = "reload.dev_server_unavailable"
	ReasonReloadNativeRebuildRequired    = "reload.native_rebuild_required"
	ReasonReloadPreviewWorkerOffline     = "reload.preview_worker.offline"
	ReasonBuildHermesFailed              = "build.hermes.failed"
	ReasonBuildNativeFailed              = "build.native.failed"
	// ReasonBuildCompileFailed is "the dev server is up and the project's own
	// source does not compile". Distinct from the build.* codes above, which are
	// about Yaver's build steps: this one is the USER'S code, so there is no
	// deterministic fixer and it is the canonical AIFix case.
	ReasonBuildCompileFailed               = "build.compile_failed"
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
	// ReasonTaskManagerUnavailable is "this agent has no task manager, so
	// nothing that creates a task can succeed here".
	//
	// Named while auditing the 816 ok:true replies for operations that did not
	// happen (handoff #14). feedback_fix answered 200 {"ok":true} when
	// s.taskMgr was nil — a success alert over a no-op, with the user believing
	// a coding agent had picked up their feedback.
	ReasonTaskManagerUnavailable = "task.manager_unavailable"

	// ReasonTaskPromptMissing is "this task carries no instruction".
	//
	// Named because of what happened without it: POST /tasks reads the prompt
	// from `description`/`userPrompt`, and a caller that used a different key
	// got a task that spawned a real runner turn on an EMPTY prompt, watched the
	// model reply "Ready. What would you like me to do?", and then reported
	// `review` — a terminal state every surface polls for as "done" — with the
	// working tree untouched. A metered LLM turn spent on a request the agent
	// could see was empty before it started.
	//
	// Constraint-shaped on purpose: only the caller has the missing text, so
	// there is no route the surface could offer.
	ReasonTaskPromptMissing = "task.prompt_missing"
	// ReasonTaskInterruptedByAgentRestart is "the runner did not choose to
	// stop; the owning Yaver process exited while the task was live". This is
	// deliberately a failed state, not a historical stopped state: after the
	// 2026-08-16 OpenCode stream-parser panic, systemd restarted the agent and
	// every surface saw only `stopped` with no reason even though the task had
	// already edited the project. The in-place route is the task's Retry action.
	ReasonTaskInterruptedByAgentRestart = "task.interrupted_by_agent_restart"
	// ReasonTaskRunnerSeatLost means a persisted task named an exact Yaver-owned
	// tmux seat, but the operation-level startup probe could not find it. This is
	// not completion and not user-requested Stop; partial edits may remain.
	ReasonTaskRunnerSeatLost = "task.runner_seat_lost"
	// ReasonPreviewSessionActive is "a preview of this project is already
	// running on this box, held by another surface". One session per project is
	// a real constraint — one headless Chrome per project, one capture loop —
	// but it is a TAKEOVER, not a dead end: POST /vibing/preview/stop has always
	// existed and every client already wraps it.
	//
	// Named because of what shipped without it. The refusal was a bare
	// fmt.Errorf string; vibe_preview_http.go then prose-matched the agent's own
	// sentence (`strings.Contains(msg, "already active")`) to pick a status code,
	// and the 409 body carried no code and no route. Measured on tvOS AND
	// visionOS in one run on 2026-08-03: both rendered "Preview unavailable ·
	// preview session for project "sfmg" already active; stop it first" over a
	// **"Try again"** button that could not succeed while the lock was held.
	// Never offer an action that cannot succeed — a dead retry turns a one-tap
	// fix into an infinite loop and teaches the user the product is broken
	// rather than busy.
	ReasonPreviewSessionActive = "preview.session_active"
	// ReasonPreviewTargetUnreachable is "the vibe preview cannot reach the
	// targetUrl it was told to capture — nothing is serving there". The
	// DETECTION is Chrome's own navigate failure (net::ERR_CONNECTION_REFUSED),
	// but only when the address refuses to connect; a page that loads and
	// errors is a different class (the user's code, not Yaver's).
	//
	// Named because of what shipped without it (2026-08-10, ubuntu-4gb-hel1-1):
	// the device card said "Connected" while /dev/status answered serving:false,
	// and a vibe start navigated Chrome to a port with no listener. The refusal
	// was the bare chromedp sentence
	//   navigate to http://127.0.0.1:3000: ... net::ERR_CONNECTION_REFUSED
	// with NO code and NO route — the user could not tell "the box is down"
	// from "nothing is serving", and no button existed to start the dev server
	// that /dev/start already knows how to launch. Connect-green + vibe-dead is
	// the false green this codebase keeps paying for: reachability is not
	// serving, and serving is not vibing. The remedy is a route: POST /dev/start
	// with the project's workDir, then re-issue the preview start.
	ReasonPreviewTargetUnreachable = "preview.target_unreachable"
	// ReasonCapabilityInsufficientDisk is "the tool is installable here, and
	// this machine does not have the room". A DIFFERENT code from
	// toolchain_missing on purpose: the remedy is not an install, it is
	// reclaiming space, and a client that renders one for the other sends the
	// user to press a button that cannot help. Carried with
	// CapabilityGap.Resource (the numbers) and CapabilityGap.Reclaim (the
	// route that frees them).
	ReasonCapabilityInsufficientDisk = "capability.insufficient_disk"
	// Browser-window is a real remote-runtime operation, not just "Chrome is
	// on PATH". These reason codes let every surface distinguish "install a
	// browser" from "the browser exists but its profile/runtime directory is
	// unusable".
	ReasonBrowserWindowChromeMissing    = "browser_window.chrome_missing"
	ReasonBrowserWindowChromeProfile    = "browser_window.chrome_profile_lock"
	ReasonBrowserWindowChromeRuntimeDir = "browser_window.chrome_runtime_dir"
	ReasonBrowserWindowChromeLaunch     = "browser_window.chrome_launch_failed"
	// ReasonBrowserWindowChromeSnapConfined is "the browser we found is a snap,
	// and a snap cannot enter the private HOME/TMPDIR this lane hands it".
	//
	// A DISTINCT code from chrome_missing on purpose: a browser IS installed,
	// so "install Chrome" reads as nonsense and an installer button would be a
	// no-op. The remedy is to install the UNCONFINED build (the .deb from
	// Google, or `snap remove chromium` plus the distro package) — a different
	// action with a different button.
	ReasonBrowserWindowChromeSnapConfined = "browser_window.chrome_snap_confined"
	// ReasonDeviceIdentityConflict is "this machine's deviceId is registered to
	// DIFFERENT hardware or a different key". Convex's markBootstrap
	// authenticates a token-dead box on the (deviceId, hardwareId, publicKey)
	// triple — the one proof that survives an expired session — and rejects a
	// mismatch outright. That rejection is correct and must never be relaxed;
	// it is what stops a stranger toggling someone else's device row.
	//
	// The consequence is what needs a name. A box that fails this check has NO
	// channel left to say "I am alive and need signing in": needsAuth is never
	// set, so every surface can only render "unreachable", and the user is
	// told to check a network that is fine. Seen live on ubuntu-4gb-hel1-1
	// (2026-07-31), where a second daemon (yaver-sim, a separate service
	// account) ran from a COPIED config carrying the same deviceId, so
	// whichever registered last owned the row and locked the other one out.
	ReasonDeviceIdentityConflict = "device.identity_conflict"
	// Remote-box repair codes. Each names a fault that took a real box down on
	// 2026-07-31/08-01 and that remote_repair can diagnose over SSH.
	//
	// ReasonAgentBinaryUnrunnable is "the ExecStart target cannot be exec'd".
	// The 08-01 instance was ELOOP: an update left the binary as a symlink to
	// its own path, so systemd reported status 203 and parked the unit in
	// 'activating' forever. Distinct from not-serving because the remedy is a
	// file restore, not a restart.
	ReasonAgentBinaryUnrunnable = "agent.binary_unrunnable"
	// ReasonAgentNotServing is "the supervisor calls it active and /health
	// answers nothing" — the false green this codebase keeps re-learning.
	ReasonAgentNotServing = "agent.not_serving"
	// ReasonRelayPinStale is "this box pins a relay identity the control plane
	// no longer publishes". The handshake is refused before any credential is
	// sent, and the refusal reads as a possible MITM, so it must never be
	// reported as an auth problem.
	ReasonRelayPinStale = "connectivity.relay.pin_stale"
)
