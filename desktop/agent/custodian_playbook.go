package main

// custodian_playbook.go — the SEMI-DETERMINISTIC middle of automatic healing.
//
// ── The three lanes ──────────────────────────────────────────────────────────
//
//	DETERMINISTIC   a warden watching real state on a cadence (custodian.go).
//	                Instant, free, no model involved.
//	SEMI-DETERMINISTIC   ← this file. A failure whose TEXT we recognise from a
//	                past incident, mapped to a remedy we already know, expressed
//	                as an existing Yaver verb. Still no model: a lookup.
//	RUNNER          no table entry matched — hand the evidence to a coding runner
//	                with a composed prompt and let it act (custodian_runner.go).
//
// Yaver has an unusual advantage here: after months of incidents, MOST failures
// a user hits are ones we have already diagnosed once. Every one of those is a
// table row, not a model call. `errSecInternalComponent` does not need an LLM to
// work out that two keychains need unlocking — it needs the sentence somebody
// already paid a whole session to learn (2026-07-19).
//
// ── Why remedies are Yaver verbs, not shell strings ─────────────────────────
//
// Each row's remedy names an existing MCP/ops verb (`ops` grand-tool, `yaver`
// CLI, or an agent HTTP route). That is the cross-surface parity rule doing real
// work: the SAME row heals from the web dashboard, the phone, the TV, a runner,
// or the CLI, because they all already know how to call a verb. A row holding a
// bespoke shell pipeline would only work where somebody wired that pipeline.
//
// ── The rule for AutoApply ───────────────────────────────────────────────────
//
// AutoApply is true ONLY when the remedy is unambiguous AND idempotent AND
// scoped to the user's own machine. Unlocking a keychain the operator configured:
// yes. Re-probing a port: yes. Deleting a volume, rotating a token, guessing a
// password, mutating account state: never — those become needs-human with the
// exact next step named, because a wrong guess there costs more than the outage.
//
// Every row is a real incident. Do not add speculative rows: an untested remedy
// that fires automatically is a new outage with our name on it.

import (
	"regexp"
	"strings"
)

// PlaybookEntry maps a recognised failure to a known remedy.
type PlaybookEntry struct {
	// ID is stable and greppable; it appears in the UI and in audit rows.
	ID string `json:"id"`
	// Match recognises the failure from its text (error string, log tail).
	Match *regexp.Regexp `json:"-"`
	// Because is what we learned the LAST time this happened — the part that
	// makes the remedy make sense instead of looking like a magic incantation.
	Because string `json:"because"`
	// Verb is the Yaver verb that fixes it, so every surface can apply it.
	Verb string `json:"verb"`
	// Args are the verb's arguments, human-readable.
	Args string `json:"args,omitempty"`
	// AutoApply: safe to do unattended (unambiguous + idempotent + local).
	AutoApply bool `json:"autoApply"`
	// Remedy is the sentence shown when AutoApply is false. Names the specific
	// next step — never "check your configuration".
	Remedy string `json:"remedy,omitempty"`
}

// playbook is the table. Ordered: first match wins, so put specific patterns
// above general ones.
var playbook = []PlaybookEntry{
	{
		ID:    "port-busy-orphan",
		Match: regexp.MustCompile(`(?i)address already in use|EADDRINUSE|port \d+ is (already )?in use`),
		Because: "a dev child from a previous agent is almost always still holding it — " +
			"setProcGroup detaches children, so an agent restart orphans them and the port drifts one number per restart (2026-07-25)",
		Verb: "dev_children_reap", Args: "", AutoApply: true,
	},
	{
		ID:    "simulator-all-claimed",
		Match: regexp.MustCompile(`(?i)already claimed by another session|every (ios-simulator|android-emulator) .* claimed`),
		Because: "a claim outlives the tab that made it: a closed browser, a slept phone or a timed-out " +
			"Playwright run leaves the simulator locked with nobody watching (2026-07-25)",
		Verb: "runtime_sessions_reap", Args: "", AutoApply: true,
	},
	{
		ID:    "avd-system-image-missing",
		Match: regexp.MustCompile(`(?i)no adb device online|system image .* (not installed|missing)|avd .* cannot be started`),
		Because: "the AVD exists but its system image was never downloaded — `emulator` fails instantly and " +
			"the honest-looking 'no adb device after 2m0s' blames adb for a missing package (2026-07-25)",
		Verb: "android_avd_repair", Args: "",
		Remedy: "install the AVD's system image: sdkmanager \"system-images;android-35;google_apis;arm64-v8a\" then recreate the AVD",
	},
	{
		ID:    "npm-enoent-wrong-workdir",
		Match: regexp.MustCompile(`(?i)Could not read package\.json.*ENOENT|npm error enoent`),
		Because: "the workDir points at a monorepo root that has no package.json of its own; the runnable " +
			"app is in a sub-project (2026-07-25)",
		Verb: "dev_start", Args: "workDir=<sub-project>", AutoApply: false,
		Remedy: "start the sub-project directly — the agent lists the runnable apps in its refusal; pick one",
	},
	{
		ID:    "keychain-cannot-sign",
		Match: regexp.MustCompile(`errSecInternalComponent|The specified item could not be found in the keychain`),
		Because: "NOT a missing certificate — the signing PRIVATE KEY sits in a locked keychain, and BOTH " +
			"yaver-ci and login keychains must be unlocked AND have their partition list set, or an " +
			"App Store archive dies on the appex re-sign (2026-07-19, cost a whole session)",
		Verb: "doctor_build_signing", Args: "--unlock", AutoApply: true,
	},
	{
		ID:    "agent-bootstrap-needs-auth",
		Match: regexp.MustCompile(`(?i)bootstrap|needs-auth|not serving|auth_token .* (missing|left)`),
		Because: "the agent is up but in bootstrap mode, so it is NOT serving — the phone sees a box that " +
			"looks online and answers nothing (2026-07-24)",
		Verb: "yaver auth fix", Args: "", AutoApply: true,
	},
	{
		ID:    "relay-502",
		Match: regexp.MustCompile(`(?i)relay .*(502|bad gateway)|relay credentials (stale|rejected)`),
		Because: "relay creds went stale; re-pulling them and retrying once fixes it, and the box otherwise " +
			"stays 'online' while every request 502s",
		Verb: "settings_repair_relay", Args: "", AutoApply: true,
	},
	{
		ID:    "runner-oauth-expired",
		Match: regexp.MustCompile(`(?i)OAuth token (has )?expired|QUIC .*401|please run /login`),
		Because: "a QUIC 401 from a runner means the RUNNER is logged out, not Yaver — headless `-p` mode " +
			"fakes this same message even when auth is fine, so the runner must be driven through a TUI",
		Verb: "runner_auth_status", Args: "", AutoApply: false,
		Remedy: "re-auth the coding runner in a tmux TUI (never `-p` headless): yaver runner auth",
	},
	{
		ID:    "dev-server-stale-bundle",
		Match: regexp.MustCompile(`(?i)served bundle unchanged|stale bundle|edit did not reach`),
		Because: "the process serving the preview is an orphan from an earlier agent watching a different " +
			"cache dir, so source edits genuinely cannot reach it (2026-07-25)",
		Verb: "dev_restart", Args: "", AutoApply: true,
	},
	// ── npm ──────────────────────────────────────────────────────────────────
	{
		ID:    "npm-eresolve-peer-deps",
		Match: regexp.MustCompile(`(?i)ERESOLVE (unable to resolve|could not resolve)|conflicting peer dependency`),
		Because: "RN/Expo dependency trees routinely fail strict peer resolution; --legacy-peer-deps is the " +
			"standard install for this stack (mobile/ has needed it since SDK 50)",
		Verb: "npm_install", Args: "--legacy-peer-deps", AutoApply: true,
	},
	{
		ID:    "npm-eacces-permissions",
		Match: regexp.MustCompile(`(?i)npm (ERR!|error) code EACCES|EACCES: permission denied.*node_modules`),
		Because: "a global/system Node install owned by root — the agent-managed Node in ~/.yaver/runtimes " +
			"avoids this class entirely instead of fighting it with sudo",
		Verb: "", AutoApply: false,
		Remedy: "install with the agent-managed Node (yaver runtime use node) or chown -R $(whoami) the project's node_modules — never sudo npm install",
	},
	{
		ID:    "npm-cannot-find-module",
		Match: regexp.MustCompile(`(?i)Cannot find module '(?:[^']+)'|Error: Cannot find module`),
		Because: "a half-finished or interrupted install leaves node_modules present but incomplete, so the " +
			"inventory (a node_modules dir exists) says yes while the operation says no",
		Verb: "npm_install", Args: "--legacy-peer-deps", AutoApply: true,
	},
	{
		ID:    "npm-lockfile-out-of-sync",
		Match: regexp.MustCompile(`(?i)npm ci can only install packages when your package(-lock)?\.json`),
		Because: "`npm ci` refuses a lockfile that disagrees with package.json — on a dev box the fix is a " +
			"plain install, not deleting the lockfile",
		Verb: "npm_install", Args: "--legacy-peer-deps", AutoApply: true,
	},

	// ── React Native / Metro / Hermes ────────────────────────────────────────
	{
		ID:    "metro-unable-to-resolve-module",
		Match: regexp.MustCompile(`(?i)Unable to resolve module|Metro has encountered an error.*resolve`),
		Because: "Metro caches its resolution graph; after a dependency change the cache is stale and no amount " +
			"of reloading fixes it — the bundler must restart with a reset cache",
		Verb: "dev_restart", Args: "--reset-cache", AutoApply: true,
	},
	{
		ID:    "metro-emfile-watch-limit",
		Match: regexp.MustCompile(`(?i)EMFILE: too many open files|watch ENOSPC|System limit for number of file watchers`),
		Because: "Metro's fallback watcher opens one descriptor per file. On the Mac mini watchman was simply " +
			"NOT INSTALLED (verified 2026-07-25), which is also why edits could look like they never landed",
		Verb: "", AutoApply: false,
		Remedy: "install watchman so Metro stops walking the tree by hand: brew install watchman (Linux: raise fs.inotify.max_user_watches)",
	},
	{
		ID:    "metro-port-8081-taken",
		Match: regexp.MustCompile(`(?i)port 8081|Metro.*already running|another (packager|Metro) is running`),
		Because: "multiple RN projects fight over 8081 — the honest fix is a brokered port per project, not " +
			"killing whichever Metro the user needed",
		Verb: "dev_children_reap", Args: "", AutoApply: true,
	},
	{
		ID:    "hermes-bytecode-version-mismatch",
		Match: regexp.MustCompile(`(?i)(HBC|bytecode) version (mismatch|\d+ .*expected)|Bundle format is unsupported`),
		Because: "the Hermes bundle was compiled by a different RN version than the container ships; the bundle " +
			"must be recompiled, never patched (magic 0x1F1903C1 + BC version live at offsets 4 and 8)",
		Verb: "dev_build_native", Args: "", AutoApply: true,
	},
	{
		ID:    "rn-sdk-version-drift",
		Match: regexp.MustCompile(`(?i)expected version: [\d.]+|Some dependencies are incompatible with the installed expo`),
		Because: "an RN/Expo native module compiled against a different core version — it may run for a while " +
			"and then crash inside JSI, so drift is reported even when the app boots (seen: react-native-worklets 0.7.4 vs expected 0.5.1)",
		Verb: "", AutoApply: false,
		Remedy: "align the package to the version Expo names: npx expo install --fix (then rebuild the native app, not just the bundle)",
	},

	// ── Flutter ──────────────────────────────────────────────────────────────
	{
		ID:    "flutter-startup-lock",
		Match: regexp.MustCompile(`(?i)Waiting for another flutter command to release the startup lock`),
		Because: "a previous flutter process died holding bin/cache/lockfile; every later command then waits " +
			"forever with no stated reason — the classic silent hang",
		Verb: "flutter_unlock", Args: "", AutoApply: true,
	},
	{
		ID:    "flutter-no-web-device",
		Match: regexp.MustCompile(`(?i)No supported devices|no web target|Unable to find a target device.*web`),
		Because: "web support is off, or the browser lane asked for a device instead of web-server — Flutter " +
			"is classed DevServerKindWeb in Yaver and never takes the Hermes path",
		Verb: "flutter_enable_web", Args: "config --enable-web", AutoApply: true,
	},
	{
		ID:    "flutter-pub-get-failed",
		Match: regexp.MustCompile(`(?i)pub get failed|Because .* depends on .* version solving failed`),
		Because: "a transitive constraint conflict; retrying pub get after a cache repair resolves the common " +
			"corrupt-cache case, and a genuine conflict then still fails honestly",
		Verb: "flutter_pub_repair", Args: "pub cache repair && pub get", AutoApply: true,
	},
	{
		ID:    "cocoapods-incompatible-versions",
		Match: regexp.MustCompile(`(?i)CocoaPods could not find compatible versions|pod install.*failed|\[!\] Unable to find a specification`),
		Because: "the local pod spec repo is behind what the Podfile asks for; a repo update is idempotent and " +
			"fixes most of these without touching the Podfile",
		Verb: "pod_install", Args: "--repo-update", AutoApply: true,
	},
	{
		ID:    "gradle-build-failed",
		Match: regexp.MustCompile(`(?i)Gradle task assemble\w* failed|Execution failed for task ':`),
		Because: "Gradle failures are too varied to table-drive — the cause is in the task output, which is " +
			"exactly the evidence a runner needs",
		Verb: "", AutoApply: false,
		Remedy: "", // intentionally empty: this row exists to route to the runner lane with evidence
	},

	// ── iOS simulator ────────────────────────────────────────────────────────
	{
		ID:    "simctl-already-booted",
		Match: regexp.MustCompile(`(?i)Unable to boot device in current state: Booted`),
		Because: "not a failure at all — the device is already in the state we asked for. Treating it as an " +
			"error made attach report a fault while the simulator sat there working",
		Verb: "", Args: "", AutoApply: true,
	},
	{
		ID:    "simctl-invalid-device",
		Match: regexp.MustCompile(`(?i)Invalid device|Unable to find a (device|destination) matching|device (not found|has been deleted)`),
		Because: "the simulator was RENAMED or deleted, and ranking by display name then finds nothing — " +
			"ranking must key on deviceTypeIdentifier from simctl --json (2026-07-25: a sim renamed to " +
			"'wrtc-test' made the mini look like it had no iPhone at all)",
		Verb: "runtime_devices_rescan", Args: "", AutoApply: true,
	},
	{
		ID:    "simctl-runtime-not-installed",
		Match: regexp.MustCompile(`(?i)runtime (is )?not installed|no runtime matching|Incompatible device`),
		Because: "usually a FALSE NEGATIVE: `simctl list` takes ~17 s on a loaded Mac mini, so a 4 s probe " +
			"reported iOS 26.4 missing while it was installed. Runtimes must be read from disk " +
			"(mounted volumes + images.plist) with a determined/undetermined distinction (2026-07-25)",
		Verb: "runtime_families_rescan", Args: "--from-disk", AutoApply: true,
	},
	{
		ID:    "simctl-app-launch-failed",
		Match: regexp.MustCompile(`(?i)FBSOpenApplicationServiceErrorDomain|failed to launch application|The request was denied by service delegate`),
		Because: "the installed bundle and the simulator's install DB disagree; reinstalling the app fixes it, " +
			"whereas erasing the simulator would also destroy any state the user was testing",
		Verb: "ios_app_reinstall", Args: "", AutoApply: true,
	},

	// ── adb / Android emulator ───────────────────────────────────────────────
	{
		ID:    "adb-device-offline-or-unauthorized",
		Match: regexp.MustCompile(`(?i)device (offline|unauthorized)|adb server version .* doesn't match|error: closed`),
		Because: "the adb server is wedged or a second adb (Android Studio's) took the socket; a server " +
			"restart is idempotent and does not touch the device",
		Verb: "adb_restart", Args: "kill-server && start-server", AutoApply: true,
	},
	{
		ID:    "adb-install-signature-mismatch",
		Match: regexp.MustCompile(`(?i)INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match`),
		Because: "a debug build is replacing a differently-signed one. The remedy uninstalls first, which " +
			"DELETES that app's data — not something to do to a user's device unasked",
		Verb: "", AutoApply: false,
		Remedy: "uninstall the existing app, then reinstall: adb uninstall <package> (this erases that app's local data)",
	},
	{
		ID:    "emulator-no-hardware-accel",
		Match: regexp.MustCompile(`(?i)requires hardware acceleration|HAXM|KVM is not installed|/dev/kvm.*permission`),
		Because: "an x86 AVD on a host without KVM/HAXM, or an arm64 Linux box with no working Android " +
			"emulator at all — on ARM cloud hosts the honest answer is 'use a physical device or redroid'",
		Verb: "", AutoApply: false,
		Remedy: "on Linux x86: install KVM and add yourself to the kvm group; on arm64 hosts use a physical device over adb, or redroid",
	},
	{
		ID:      "emulator-insufficient-storage",
		Match:   regexp.MustCompile(`(?i)INSTALL_FAILED_INSUFFICIENT_STORAGE|No space left on device.*(emulator|avd)`),
		Because: "the AVD's userdata partition is full — clearing it is data loss, so the user chooses",
		Verb:    "", AutoApply: false,
		Remedy: "free space on the AVD (adb shell pm clear <package>) or recreate it with a larger -partition-size",
	},
	{
		ID:    "android-sdk-not-found",
		Match: regexp.MustCompile(`(?i)ANDROID_(HOME|SDK_ROOT).*(not set|missing)|SDK location not found|Android SDK not found`),
		Because: "the SDK is present but not on the daemon's PATH/env — a launchd agent inherits almost no " +
			"environment, so tools that work in the operator's shell are invisible to the agent (2026-07-25)",
		Verb: "android_sdk_rediscover", Args: "", AutoApply: true,
	},

	// ── redroid (containerised Android) ──────────────────────────────────────
	{
		ID:    "redroid-missing-kernel-modules",
		Match: regexp.MustCompile(`(?i)redroid.*(exited|failed to start)|binder.*not found|ashmem.*(missing|not found)`),
		Because: "redroid needs binder/ashmem on the HOST kernel — it cannot ship them in the container, so a " +
			"box without them can never run it no matter how the image is configured",
		Verb: "", AutoApply: false,
		Remedy: "load the host modules (modprobe binder_linux ashmem_linux) — requires root on a Linux host; macOS cannot run redroid at all",
	},

	{
		ID:    "convex-privacy-violation",
		Match: regexp.MustCompile(`(?i)forbidden (key|field) in convex payload|absolute path in convex`),
		Because: "a sync path added a field that leaks paths/tokens — the privacy contract is enforced by test " +
			"for exactly this reason and must not be relaxed to make a deploy pass",
		Verb: "", Args: "", AutoApply: false,
		Remedy: "remove the field from the payload (or hash it) and add it to fieldsWeForbidInAnyConvexPayload — never widen the allowlist",
	},
}

// MatchPlaybook returns the first entry whose pattern recognises text.
func MatchPlaybook(text string) (PlaybookEntry, bool) {
	t := strings.TrimSpace(text)
	if t == "" {
		return PlaybookEntry{}, false
	}
	for _, e := range playbook {
		if e.Match != nil && e.Match.MatchString(t) {
			return e, true
		}
	}
	return PlaybookEntry{}, false
}

// PlaybookFinding turns a recognised failure into a custodian finding, so a
// table hit reaches the user through the same feed as a warden sweep. The
// caller applies the verb when AutoApply is set; this only decides the words and
// the outcome, which keeps "what we say" in one place.
func PlaybookFinding(warden, subject, text string) (CustodianFinding, bool) {
	e, ok := MatchPlaybook(text)
	if !ok {
		// Unrecognised: this is precisely the case the runner lane exists for.
		return CustodianFinding{
			Warden: warden, Subject: subject, Outcome: OutcomeNeedsRunner,
			Problem:  playbookFirstLine(text),
			Action:   "no playbook entry recognises this — escalating to a coding runner with the evidence",
			Evidence: []string{text},
		}, false
	}
	f := CustodianFinding{
		Warden: warden, Subject: subject,
		Problem: playbookFirstLine(text) + " — " + e.Because,
	}
	if e.AutoApply {
		f.Outcome = OutcomeFixed
		f.Action = "applying known remedy: " + e.Verb
		if e.Args != "" {
			f.Action += " " + e.Args
		}
	} else {
		f.Outcome = OutcomeNeedsHuman
		f.Action = "recognised, but this remedy is not safe to apply unattended"
		f.Remedy = e.Remedy
	}
	return f, true
}

// PlaybookCatalog exposes the table so every surface can render "what Yaver
// already knows how to fix" — and so a reader can audit it without reading Go.
func PlaybookCatalog() []PlaybookEntry {
	out := make([]PlaybookEntry, 0, len(playbook))
	for _, e := range playbook {
		e.Match = nil // not serialisable, and the pattern is an implementation detail
		out = append(out, e)
	}
	return out
}

func playbookFirstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return s
}
