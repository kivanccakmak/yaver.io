# Handoff — remaining development + test work (session 2026-08-03)

Everything below is **open**. Landed work is in the four commits listed at the
bottom; this file is only what is NOT done.

Two audits written this session are the evidence base for most of it:
* `docs/audits/reason-code-wiring-audit-2026-08-03.md` — **CORRECTED.** Its first
  version was wrong on 29 of 31 rows; the measurement is now a ratchet test
  (`desktop/agent/reason_code_wiring_test.go`): **31 codes · 10 wired · 20
  emitted-into-silence · 0 never-emitted · 1 dead.**
* `docs/audits/failure-plumbing-measured-2026-08-03.md` — layer D exists once in 1764 error replies

---

## P0 — in the user's way right now

### 1. ~~Preview session is a singleton with no takeover route~~ — **DONE 2026-08-04**
Typed `PreviewSessionActiveError` → 409 carrying `code: preview.session_active`
plus a `CapabilityGap` whose fix is `POST /vibing/preview/stop` with the body
pre-filled, `instant`, `retry`. The `strings.Contains` switch is gone (guarded by
`TestPreviewStartHandler_DoesNotProseMatch`). Consumers landed on tvOS/visionOS
(generic route invocation, "Try again" suppressed), mobile + web capabilityGap
twins (`instant`/`body` parsed), and the web preview panel. The 503 "no browser"
sibling now routes through the same producer, so it gets a streamed Install
button. Test invokes the advertised route against real Chrome and takes over.

*Original report, kept for context:*
### 1. Preview session is a singleton with no takeover route
**Measured:** after one surface opens a project, every other surface gets
`Preview unavailable · preview session for project "sfmg" already active; stop
it first` — with a **`Try again`** button that can never succeed while the lock
is held. Observed on tvOS AND visionOS in the same run. It also blocks the
all-surfaces loop (worked around in the runner, not in the product).

**Why it is a four-layer failure, precisely:**
- `desktop/agent/vibe_preview.go:349` — throws a bare `fmt.Errorf` string
- `desktop/agent/vibe_preview_http.go:50` — re-derives its own category with
  `strings.Contains(msg, "already active")`; the agent prose-matches itself
- the 409 body is `jsonError(w, 409, msg)` — **no `code`, no `remedy`**
- `POST /vibing/preview/stop` **already exists**, and every client already
  wraps it: `mobile/src/lib/vibePreview.ts:153`,
  `web/lib/agent-client.ts:5281`, `tvos/YaverTV/AgentClient.swift:354`

**Fix:** typed error with `code: "PREVIEW_SESSION_ACTIVE"` + `remedy:
"stop-preview"` + the owning project/surface; emit those fields and delete the
`strings.Contains` switch; surfaces render **"Stop it and take over"** wired to
the existing `stopPreview()`, and **suppress "Try again"**.

> **General rule this session kept re-deriving: never offer an action that
> cannot succeed.** A dead retry button converts a one-tap fix into an infinite
> loop and teaches the user the product is broken rather than busy.

### 2. ~~Emit `capability.toolchain_missing`~~ — **VOID. It was already emitted.**
**Measured, not inferred:** `capability_gap.go:362` has set this code on every
missing-toolchain gap since **2026-07-27** (`7b9e42c66`), six days before the
audit that called it never-emitted, and `capability.insufficient_disk` since the
same commit series (`:418`). Both are WIRED — emitter plus consumers on mobile,
web and tvOS. There is nothing to build here.

**What the corrected measurement found instead:** 20 codes the agent *does*
emit that **no surface reads** — `/capabilities/snapshot`, `ops remote_repair`,
the reload/build lanes, all five `browser_window.chrome_*`, and
`device.identity_conflict`. That inverts the fix order: emitting is done,
consuming is the whole job. See P3 #11–13, now correctly scoped, and the
ratchet test that will fail if any of it regresses.

---

## P1 — unblocks all automated surface testing

### 3. ~~Code-based sign-in on the phone~~ — **DONE 2026-08-04, proven against the real backend**
`mobile/src/lib/deviceCodeSignIn.ts` + a "Sign in with a code" path in
`app/login.tsx`. THIS DEVICE creates the code (poll/claim key off the 40-hex
secret, so a screen that merely accepts a typed code could never complete) and
shows the short one for an approver.
Every call aborts on a deadline, and the poll loop is wall-clock bounded —
proven by removing the bound and watching the test hang forever.
An unreachable server is reported as such, never as "waiting for approval".
**Headless proof against the live deployment** (`scratchpad/devicecode_proof.mjs`):
create → 200 · poll before approval → `pending`, no token leak · authorize with a
session bearer → 200 · poll → `authorized` + 64-char token · that token against
`/auth/validate` (the exact call the app makes next) → 200 · replay poll →
`expired`, no second token.
This unblocks #5 and #6.

*Original report:*
### 3. Code-based sign-in on the phone  *(blocks #5, #6)*
`backend/convex/deviceCode.ts` ships the whole flow and **six** live HTTP
routes: `/auth/device-code/{authorize,broker,poll,claim,events,pending}`.
`mobile/app/login.tsx` has **no code-entry path** — OAuth/passkey/email only.

Consequences: no way to hand a session to a new phone or simulator without an
interactive browser round-trip; every automated iOS/Android arc dies at
sign-in; and a real user moving to a new phone hits the same wall with a
working mechanism sitting unused behind it.

Contracts: `POST /auth/device-code/broker` (authenticated, mints a
pre-authorized code) → `GET /auth/device-code/poll?device_code=<secret>` →
`saveToken()`/`saveUser()` at `mobile/src/lib/auth.ts:61,91`.
Note `poll`/`claim` key off the **secret** `deviceCode`, not the short user
code — so the phone must create and hold it, not just accept a typed code.

Once built, the loop closes with no human in it: the simulator shows the short
code, the Vision oracle OCRs it, the agent's session authorizes it.

### 4. ~~Make `remedy` a typed route~~ — **DONE 2026-08-04**
`GapFix` gained `Body` (the arguments a route requires — without them
`/vibing/preview/stop` answers 400, i.e. another action that cannot succeed) and
`Instant` (synchronous fix, nothing to stream; without the flag the renderers'
no-stream guard DROPPED such a button). `jsonErrorWithGap` gives every handler a
one-line way to emit `code` + `capabilityGap`. `runner_model_probe`'s missing-codex
remedy now carries the real install route. Permanent guard:
`remedy_is_a_route_test.go` — a ratchet that fails when a remedy NAMES an
invocable action without a typed route beside it, and when its allowlist goes
stale or contains keys that match nothing.

*Original report:*
### 4. Make `remedy` a typed route, not a string
Only **1** of 4 current uses is invocable (`stream-over-webrtc`); the other
three are English prose in a field whose name promises a route. Prose in
`remedy` is worse than none — it looks structured, so layer D gets ticked off
in review while the surface still has nothing to render as a button.

---

## P2 — closed-loop tests still owed

### 5. iOS simulator arc → a real verdict
`e2e/ios-sim-preview-narration.mjs` drives the compiled app and reads text off
the simulator screen. Blocked only by sign-out (task 3). App is built and
installed on `iPhone 17 Pro` (`24B591E9-B94A-40CC-8C08-8CCD8EFB1EA2`).

### 6. Android emulator arc → a real verdict
`e2e/android-emu-vibe-loop.mjs`. Same blocker. Launch-frame triage is in, so it
now skips in ~20s instead of burning a 10-minute budget on a sign-in screen.

### 7. ~~RN-web arc cannot open the fullscreen preview~~ — **DETERMINED + FIXED 2026-08-04**
**Measured, not guessed.** RN-web's `Modal` CAN present (`react-native-web@0.21`
ships it; `presentationStyle` is iOS-only and simply ignored). The blocker is the
WebView *inside* it: `react-native-webview@13.15.0` has no web build — no
`.web.js`, no `browser` field — so the platform-neutral `lib/WebView.js` is
picked and it renders the literal string *"React Native WebView does not support
this platform."*
**The product already had the fix and it had drifted:** `WebViewCompat.tsx` /
`.web.tsx` (an `<iframe>` wearing the WebView API) existed and `apps.tsx` used
it, while `DevPreview.tsx` and `app/(tabs)/project.tsx` still imported the raw
library — the "one of two browser-preview implementations" drift by name. Both
migrated; `webViewCompatParity.test.ts` now also asserts that the preview
surfaces import the shim, proven by breaking it.

*Original report:*
### 7. RN-web arc cannot open the fullscreen preview
`e2e/tests/sfmg-preview-narration.spec.ts` signs in against the box fine, but
"Open in Yaver" does not leave the Tasks tab. Unresolved whether
`<Modal presentationStyle="fullScreen">` + `react-native-webview` can present
under RN-web at all. **Determine which** — do not guess; if it cannot, mark the
arc native-only in the file.

### 8. ~~`releasePreview()` ends in a 4-second sleep~~ — **DONE 2026-08-04**
`GET /vibing/preview/release?project=X` + ops verb `vibe_preview_release` answer
"could a new session be claimed right now?" with NAMED blockers. It probes the
operation: the session entry AND the capture goroutine, which is the part still
holding the browser target after `Stop()` has already returned — the race the
sleep was hiding. The e2e loop now polls it (15 s cap, warns instead of silently
proceeding). Negative control:
`TestPreviewRelease_CountsTheCaptureLoopNotJustTheMap`.

*Original report:*
### 8. `releasePreview()` ends in a 4-second sleep
`e2e/all-surfaces-sfmg-loop.mjs` — there is no verb answering "is the preview
released yet?". A question you can only answer by waiting is a missing
endpoint. Add an ops verb; the sleep is a placeholder.

### 9. Finish the all-surfaces run
Never completed end-to-end. Confirmed so far: `yaver/hermes-refusal` → PIXELS
(`code=YAVER_SELF_DEVELOPMENT_RECURSION · remedy=stream-over-webrtc`), and sfmg
genuinely loads (oracle read "Choose Your Language · Türkçe · English").
Budget must be ≥7 min/surface — 150s is not enough for a runner turn + rebuild.

### 10. Verify the four shipped UI fixes on a real screen
Build **501** carries them; they are unit-proven (30 checks) and **have never
been seen rendering**. Check, in order: sfmg preview shows
`Starting Metro Bundler · 1:24 elapsed · last output 3s ago` instead of black;
tapping `mobile` gives "Preview Yaver a Different Way" + a **Stream over
WebRTC** button; the mic overlays the running app instead of replacing it.

---

## Landed 2026-08-04 beyond the numbered list

* **`auth.sdk.scope_denied` wired** (#12) — was the ONE code with neither
  producer nor consumer. Now emitted by `sdkScopeDenied` from **all four** SDK
  scope-denial sites in `httpserver.go`. The duplication is the finding: the
  scope check exists four times, so wiring one site would have left three
  surfaces still guessing.
* **QUIC honesty** (`quic_listen_state.go`) — `ubuntu-4gb-hel1-1` has had NO
  QUIC listener since 2026-07-27 because a co-located `yaver-relay.service` owns
  UDP 4433, and the agent kept heartbeating a `quicHost` for a socket that does
  not exist. A failed bind is now recorded, the address is suppressed (empty is
  already a supported state), and the startup log names the holder + the probe,
  warning that the holder is a Yaver relay which must **not** be killed.
* **The wiring ratchet learned that a log line is not a wire.** Its first
  version counted any non-test mention as an emitter, so it reported
  `device.identity_conflict` as "emitted with no consumer" when in truth its only
  uses are `log.Printf` — no surface could consume it even in principle. LOG-ONLY
  is now its own reported state. Same class of error as the audit it replaced,
  one level subtler: counting the appearance of a string instead of the behaviour.

## Incident found while working — worth not rediscovering

A Fast Reload failed with `HTTP 502: tunnel read error`, and the web UI called it
a network fault (*"device not connected to relay… a power-cycle would not address
this"*). It was a **lifecycle** event: the agent was SIGTERM'd three seconds into
`expo export`, restarted, and re-registered — so it looked online again while the
in-flight build and the SSE stream were gone. Not OOM, not a crash, not an update
(auto-update had said "already up-to-date" nine minutes earlier). **Who issued
the stop is unresolved** — systemd does not record the requester. Full detail in
the memory `project_agent_restart_midbuild_and_quic_conflict`.

Open product gaps from it, none yet built:
1. A restart must ANNOUNCE itself to subscribed surfaces; today it surfaces as a
   502 the client blames on the network.
2. The restart orphaned `adb`, `tmux: server` and the vibe-preview Chromes into
   the new unit ("a context kill does not free you while a grandchild holds the
   pipe").
3. `Fix with opencode` on that error panel itself failed — *"placement selected a
   Cloud Workspace that is not ready on this agent"* — so the one button offered
   was also a dead route.

## P3 — from the audits, in dependency order

11. **Consume the 20 emitted-but-unread codes** (not 7 — measured). A code sent
    into silence is indistinguishable from prose. Highest blast radius first:
    `device.identity_conflict` (a live box in this state can *only* render as
    "unreachable" — `needsAuth` is never set, so the user is sent to check a
    network that is fine), then the five `browser_window.chrome_*`, then
    `connectivity.relay.pin_stale` (must never be reported as an auth problem).
    Land each consumer with a test that fails when it is removed; the ratchet in
    `reason_code_wiring_test.go` fails if the allowlist is not updated with it.

    **Half the work is already done and nobody noticed** (measured 2026-08-04):
    BOTH mobile (`src/lib/quic.ts:4848`) and web (`lib/agent-client.ts:6894`)
    already fetch `/capabilities/snapshot`, and BOTH already carry a
    `reasonCode?: string` field in their parsed types (`quic.ts:885`,
    `agent-client.ts:1598`). They parse it and never switch on it. So the
    remaining work for that family is a shared classifier — code → sentence +
    route — not new plumbing.

    **And check the wire first:** `device.identity_conflict` reaches only a
    `log.Printf`, so it has no consumer *by construction*. Codes in that state
    are now reported as LOG-ONLY by the ratchet; putting them on a payload comes
    before writing any client for them.
12. **Decide `auth.sdk.scope_denied`** — the *one* genuinely dead code. Wire it
    into the SDK-token 403 or delete the constant.
13. **Then** remove the client prose matchers. **Not before** — deleting a regex
    whose replacement code no surface reads trades a wrong diagnosis for none.
14. **Audit the 814 `ok:true` replies** for operations that did not happen.
    Highest-risk pass in the repo: a false green is invisible by construction.
    CLAUDE.md already names two (`feedback_fix` with no task manager,
    `launch-feedback` with no DataChannel).

---

## P4 — carried from earlier, still open

15. **STT for developing third-party apps** inside Yaver (tvOS has none).
16. **Feedback SDK + dogfood-mode coverage** in the loops.
17. **Feedback SDK letting third-party apps develop themselves** via dogfood
    mode + browser lane (WebRTC or browser streaming).
18. **Relay / Relay Pro lane untested** from TV and AR/VR — every arc uses the
    tailnet address only.
19. **Runner edit strength varies run-to-run** — 1 red container vs 3.

---

## Environment traps worth not rediscovering

* **Seeding a token does not sign the app in.** `clearKeychainIfFreshInstall`
  treats a fresh browser profile as a fresh install and wipes it — the
  `yaver_installed` flag must go in with the token. This cost a debugging pass
  that wrongly concluded Convex had rejected the token.
* **`rg` mangles its own output in this environment** (`/dev/build-native`
  renders as `/dev/n`). It produced two confident, wrong audit claims before
  `grep` caught them. **Verify with `grep`.**
* **The mobile disk preflight is a stub on this Mac** —
  `~/.local/bin/mobile-cache-cleanup.sh` is three lines that exit 0 ("the real
  shared script lives on the Mac mini"). It passed at 10 GB free against a
  documented 20 GB minimum. Clear `~/Library/Developer/Xcode/DerivedData` by
  hand (~7.6 GB).
* **`expo run:ios` picks the `YaverWatch` scheme** unless you pass
  `--scheme Yaver`, then fails with "no available devices matched" because the
  watch scheme only offers watchOS destinations.
* **e2e arcs must run under `tsx`**, not bare `node` — they import
  `web/lib/*.ts` deliberately, so the shipping classifier is the one that
  judges. Bare `node` dies with `ERR_UNKNOWN_FILE_EXTENSION`.
* **The default e2e `global-setup` provisions a Convex dummy user that cannot
  be created** ("Email/password sign-in is not enabled for this email"), which
  killed every device arc before its first line. Use
  `e2e/playwright.device.config.ts`.

---

## Standing discipline (earned twice this session)

**Both arcs lied before they worked**, and the fixes are the real output:
* the web arc failed with "the surface said NOTHING — this is the build-500
  defect" while sitting on the Tasks tab, having never opened a preview;
* the native arc called a signed-out app "silent".

Both now require **positive proof of the state they are judging** and skip with
a named cause otherwise. **A false red is exactly as corrosive as a false
green.** Any new arc inherits that rule.

---

## Landed this session

| commit | |
|---|---|
| `bdaf1803a` | mobile: the 4 UI defects from build-500 screenshots |
| `4439cfda2` | tvOS: a client-side refusal is not a sleeping box |
| `6e30d7555` | security: a real machine address in 12 tracked files + measured guard |
| `32c44766a` | e2e: load and vibe a real project on every surface, sequentially |

**Build 501** uploaded to TestFlight carrying the four UI fixes.

**Not done, needs a decision:** the infra addresses scrubbed in `6e30d7555`
are still in already-pushed history. Not rewritten — public objects, and
rewriting shared history is its own hazard.
