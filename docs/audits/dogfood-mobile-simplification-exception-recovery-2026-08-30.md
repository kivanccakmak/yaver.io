# Dogfood Mobile Simplification and Exception Recovery — 2026-08-30

> Snapshot only. Markdown drifts; current code and executable tests are the
> source of truth. This audit covers the shared preview-control change at
> `fa1845202` plus the framework-aware setup/runtime follow-up in the current
> tree.

## Requested product outcome

The contributor-facing **Develop Yaver** screen should have one short ordered
setup with four clear configuration choices:

1. **Remote box**
2. **Runner**
3. **Checkout**
4. **Runtime lane**

Each choice owns its setup flow. Missing configuration should lead directly to
the real pairing, runner, authentication, installation, checkout-discovery, or
Git repair plumbing. App registration, trusted-account management, install
approvals, QR handoff, and other developer administration should not crowd this
surface.

Dogfood browser exceptions should also stop exposing Metro's raw red error wall
as the only answer. The host should preserve **Fast Reload** and **Y**, show a
contextual **Fix exception** action, and give the selected coding runner the
captured failure evidence.

## Resulting mobile information architecture

### Develop Yaver

`mobile/app/(tabs)/dogfood.tsx` now renders the compact
`AttachModeSection` by default. The default screen does not render developer
registry or approval inventory.

`mobile/src/components/AttachModeSection.tsx` renders exactly four top-level
rows with distinct icons and whole-row actions:

- Remote box — desktop icon
- Runner — sparkles icon
- Checkout — folder icon
- Runtime lane — layers icon

The action is **Change** when ready and **Set up** when incomplete. Detailed
inventory appears only after the corresponding row is opened. The final
**Enter Dogfood mode** action appears only when the three operational checks
and the selected runtime lane are ready; incomplete setup does not leave a
dead disabled primary button. Runtime selection follows those checks and is
not buried inside Runner.

### Framework-aware lane policy

`sdk/feedback/react-native/src/DogfoodRuntime.ts` is the source of truth for
Yaver-on-Yaver and embedded apps such as SFMG:

- Expo, React Native, Flutter, and browser projects default to Browser during
  onboarding.
- Hermes is offered only to Expo/React Native projects.
- WebRTC is offered only when the selected box reports a real enabled native
  target.
- If the user explicitly prefers Hermes or WebRTC and the project supports a
  browser build, Browser becomes the automatic second attempt.
- Native-only Swift/Kotlin projects never advertise a browser fallback.
- The preferred lane is persisted per Dogfood app and remains changeable from
  Dogfood settings.

Fallback is operational, not decorative. The preferred lane's resources are
cleaned up, its stable failure code remains visible in the console, and only
then does the shared controller start Browser. The shared picker labels both
the preferred lane and the automatic fallback.

### Logs-first start

Starting Dogfood transitions immediately to `DogfoodLiveConsole`. The Yaver
launch screen no longer repeats a second truncated startup-log widget above the
real console. An explicit SDK Dogfood shortcut opens on the Dogfood setup tab
instead of authenticated Chat, so SFMG users see machine/runner/checkout/lane
setup and then the same live compiler/runtime stream as Yaver-on-Yaver.

### Developer administration

The previous registry and approval surface remains available as
`DeveloperManagementScreen`, selected by `management=1`.

`mobile/app/(tabs)/settings.tsx` now exposes one focused route:

**Settings → Developer → App testing & approvals**

That deeper screen owns apps, trusted accounts, control-device registration,
install approvals, and secure handoff. These inventories no longer compete
with Remote box, Runner, and Checkout on the contributor entry screen.

## Setup and plumbing behavior

### Remote box

- Existing same-account devices remain selectable through `DeviceContext`.
- If no box exists, **Pair remote box** opens the canonical Pair Machine sheet
  in `mobile/app/(tabs)/more.tsx`.
- Pairing still requires explicit confirmation and uses the existing secure
  pairing implementation.
- A successful pairing refreshes the real device registry and returns to
  Develop Yaver.
- The focused return target is captured and cleared so a later ordinary pair
  action cannot accidentally redirect back to Dogfood.

### Runner

- Runner readiness comes from the selected box's real `/agent/runners` result.
- If no per-device runner has ever been selected, the app adopts the box's
  proved-ready default, or the first proved-ready runner.
- An explicit existing runner preference is never overwritten.
- Runner configuration is independent of checkout configuration; a user can
  repair or authenticate the runner before choosing the source checkout.
- Existing runner install, browser authentication, and OpenCode configuration
  surfaces are reused.

### Checkout and Git

- Checkout truth remains agent-owned through `/dogfood/source/status`.
- The phone does not infer repository validity from a path string.
- Existing checkouts are discovered and deduplicated from the box.
- Missing source uses the existing clone/install flow.
- Missing Git, Git authentication, embedded credentials, invalid origin, and
  upstream failures retain their deterministic fix routes.
- Git onboarding opens the existing Settings wizard for the selected box.

## Split-bundle 404 root cause

The captured failure was:

```text
Failed to load split bundle from URL:
https://public.yaver.io/src/lib/auth.bundle?... 404 page not found
```

This was not caused by the coding runner. The runner had already produced and
served the application. The failure happened in the phone-facing browser
transport after the initial HTML loaded.

The causal chain was:

1. The public `/d/<device>/...` web proxy injected an early
   `history.replaceState` path rebase.
2. The current Go agent also injected `yaver-preview-auth-shim`. That shim must
   capture the original scoped path `/d/<device>/dev/` before making `/`
   visible to the guest router.
3. Because the outer proxy rebased first, the agent shim captured `/` instead
   of the scoped transport path.
4. Metro's lazy `auth.bundle` request consequently escaped to
   `https://public.yaver.io/src/...` instead of staying below
   `https://public.yaver.io/d/<device>/dev/src/...`.
5. The public root correctly returned 404.

`web/app/d/[deviceId]/[[...path]]/route.ts` now delegates the compatibility
decision to `web/lib/previewRebase.ts`:

- If `yaver-preview-auth-shim` is present, the current agent owns rebasing and
  the outer proxy does not inject another path rewrite.
- If the marker is absent, the legacy-agent compatibility rebase remains.

This fixes the current route without silently dropping older-agent support.

## Graceful exception recovery

`mobile/src/lib/dogfoodExceptionBridge.ts` adds a bounded bridge between guest
JavaScript and the native Dogfood host. It is injected before guest content and
captures:

- `window.error`
- `unhandledrejection`
- failed script loads
- failed stylesheet loads

Image failures are deliberately ignored because they are not normally fatal
and would make the recovery surface noisy.

Captured failures receive stable codes:

- `DOGFOOD_SPLIT_BUNDLE_LOAD_FAILED`
- `DOGFOOD_RESOURCE_LOAD_FAILED`
- `DOGFOOD_GUEST_EXCEPTION`

The host behavior in `mobile/app/attach.tsx` is:

1. Stop the loading state and retain the last rendered WebView underneath.
2. Cover Metro's raw error wall with a compact native exception card.
3. Keep the native **Fast Reload**, **Fix exception**, and **Y** controls above
   that card.
4. Fast Reload clears the captured exception and retries the surface.
5. Fix exception starts a real task on the selected box, runner, and checkout.
6. Navigate to Tasks and open the new task's live chat/console.

The fix prompt carries:

- stable failure code and failure kind
- exception message
- source URL and line/column when available
- current guest URL
- scoped phone-facing preview URL
- selected render-machine name
- captured stack trace
- instructions to fix the product path and add a regression test

Evidence is bounded before crossing the bridge. Query parameters whose names
look like tokens, authentication, secrets, passwords, sessions, codes, or keys
are redacted. The captured stack is explicitly marked as untrusted runtime
evidence so text inside an exception is not treated as user instruction.

## Main implementation files

- `mobile/app/(tabs)/dogfood.tsx`
- `mobile/src/components/AttachModeSection.tsx`
- `mobile/src/lib/attachMode.ts`
- `mobile/app/(tabs)/more.tsx`
- `mobile/app/(tabs)/settings.tsx`
- `mobile/app/attach.tsx`
- `mobile/src/components/BrowserVibeBubble.tsx`
- `mobile/src/lib/dogfoodExceptionBridge.ts`
- `web/app/d/[deviceId]/[[...path]]/route.ts`
- `web/lib/previewRebase.ts`

## Regression coverage

Updated or added coverage includes:

- `mobile/src/lib/attachMode.test.mts`
  - exact Remote box / Runner / Checkout readiness order
  - runner setup independent from checkout
  - blocked and pending setup behavior
- `mobile/src/lib/dogfoodSourcePlumbing.test.mts`
  - compact readiness rows
  - icons, focused disclosure, pairing, and deterministic Git routes
- `mobile/src/lib/dogfoodSurfaceContract.test.mjs`
  - nested developer administration
  - exception capture, fix-task handoff, and shared controls
  - lane follows checkout, uses the shared plan, and persists preference
- `sdk/feedback/react-native/src/__tests__/DogfoodRuntime.test.ts`
  - framework lane matrix and browser defaults
  - explicit native/Hermes preference followed by real Browser recovery
  - cleanup and visible stable-code fallback logging
- `sdk/feedback/react-native/src/__tests__/FeedbackModalContract.test.ts`
  - explicit Dogfood opens setup rather than Chat
  - runtime console is the first live Dogfood surface
- `mobile/src/components/BrowserVibeBubble.test.mts`
  - contextual Fix exception action remains in the draggable control dock
- `mobile/src/lib/dogfoodExceptionBridge.test.mts`
  - split-bundle classification
  - URL/stack evidence
  - secret-query redaction
  - pre-content error hooks
- `web/lib/previewRebase.test.ts`
  - current-agent negative control: no outer rebase
  - legacy-agent compatibility rebase
- `e2e/tests/dogfood-mobile-live.spec.ts`
  - genuine mobile device context
  - only the compact ordered choices visible by default
  - inventories remain collapsed until tapped

Validation completed during implementation:

- The feedback SDK's full build and test lane passed: 23 suites and 205 tests.
- The mobile Dogfood source and surface contracts passed: 36 tests.
- The relay package test suite passed after the continuity/version change.
- `git diff --check` passed.

The real RN-web pixel arc remains environment-gated by `MOBILE_WEB_URL`; release
validation therefore includes the native TestFlight build rather than claiming
a desktop-width browser as mobile proof. Release and remote rollout results are
recorded by their executable deployment lanes, not assumed by this snapshot.
