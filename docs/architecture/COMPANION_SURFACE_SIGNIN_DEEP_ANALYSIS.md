# Companion Surface Sign-In Deep Analysis

Date: 2026-07-25

Scope: AR/VR sign-in, watch sign-in, and car sign-in across iOS and Android. This document began as analysis and now records the first implementation pass landed from it.

## Executive Summary

Yaver does not have one "companion sign-in" flow. It has three different custody models:

1. **Phone-inherited auth**: CarPlay, Android Auto, default Apple Watch, and default Wear OS do not sign in independently. They use the already-authenticated phone as the auth holder and command dispatcher.
2. **Device-code standalone auth**: watchOS standalone, Wear OS standalone, tvOS, and part of visionOS use the Convex device-code flow. The companion shows a short code/approval URL and polls until the signed-in phone/browser approves.
3. **Headset-local or phone-assisted auth**: native visionOS adds native Apple sign-in and in-headset OAuth because a headset can sign in itself. Web `/spatial` now prefers `?agent=<url>` plus the same phone-approved device-code flow as TV/watch, while legacy `token=` links are scrubbed from history immediately.

The product direction is coherent: small/safety-sensitive surfaces should avoid password entry and should minimize token custody. The main gaps are not conceptual. They are surface-specific drift and hardening gaps:

- Web `/spatial` no longer requires URL bearer as the normal path. It can still consume legacy `token=` links, but removes the token from browser history immediately and prefers a phone-approved spatial device-code session.
- Android Auto and CarPlay are correctly phone-inherited, but neither should ever grow an independent login screen. If the phone is signed out, the car surface should say "open Yaver on your phone" and stop.
- Standalone watches intentionally store a long-lived token. watchOS now migrates the token to Keychain, and Wear OS now prefers AndroidX encrypted shared preferences with a compatibility fallback.
- Session scope now includes `"watch"`, `"vision"`, and `"spatial"` in addition to `"full"`, `"machine"`, and `"tv"`. Device-code minting classifies watchOS/Wear OS, visionOS/Android XR/Quest, and spatial browser sessions into constrained companion scopes.
- Surface identity exists via `X-Yaver-Surface`, but it is advisory only. That is correct for auth, but it means every constrained-surface safety rule must be enforced by token scope, endpoint permissions, and server-side policy, not by trusting the header.

## Verified Architecture

### Backend Device-Code Flow

The real backend contract is in `backend/convex/deviceCode.ts`:

- `POST /auth/device-code` creates `{ userCode, deviceCode, expiresAt }`.
- `GET /auth/device-code/poll?device_code=...` returns pending, authorized with token, or expired.
- `POST /auth/device-code/authorize` is intentionally internal-backed and derives the approving user from the caller's bearer token.
- Device-code sessions are 1-year sessions.
- Companion device-code sessions are classified by `platform` and `environment`: TV gets `tv`, watchOS/Wear OS get `watch`, native XR/headset fallback gets `vision`, and web spatial gets `spatial`.

This means **watchOS/Wear OS standalone and visionOS/spatial device-code fallback no longer mint full owner sessions** when they send the expected platform/environment fields.

### Mobile Auth Source of Truth

The mobile app persists the primary session token in Expo SecureStore and validates/refreshes it through `mobile/src/lib/auth.ts` and `mobile/src/context/AuthContext.tsx`.

Important implementation details:

- Mobile does not rotate tokens during normal refresh because losing a refresh response can strand the phone on a dead token.
- `AuthProvider` keeps cached sessions on network errors and only logs out after authoritative invalidation.
- `saveToken(...)` also mirrors inherited auth to the native iOS `YaverInfo` module for guest/native bundle use.

This is the right root for phone-inherited companion surfaces: car/watch should borrow the phone's authenticated control plane, not duplicate login.

## Watch Sign-In

### Apple Watch

Default mode is **phone-paired**:

- `watch/YaverWatch/PhoneSession.swift` sends watch requests over `WCSession`.
- `mobile/native-watch/ios/YaverWatchBridge.swift` receives on the iPhone and emits JSON to JS.
- `mobile/src/lib/watchEntry.ts` parses the message and forwards it into `mobile/src/lib/watchBridge.ts`.
- `mobile/src/components/WatchBridgeHost.tsx` wires the bridge to the active device, phone auth token, wake capability, runtime session turn, and car-safe ops.

Auth implication: in this default path the watch holds **no token**, no box host, and no task history. The phone is the brain of record.

Standalone mode is opt-in:

- `watch/YaverWatch/Views/SignInView.swift` runs the device-code flow.
- `watch/YaverWatch/Backend.swift` calls Convex device-code endpoints and refreshes the standalone token on launch.
- `watch/YaverWatch/WatchStore.swift` stores `yaver.watch.token`, box JSON, and `standaloneOptIn`.
- Standalone dispatch uses `SessionClient` against `/runner/session/turn`, not a new-task-only watch endpoint.

Strengths:

- The default custody model is excellent: no sensitive token on the wrist.
- Standalone is explicit opt-in and has clear "use without phone" framing.
- Recent fixes show wait time, expiry, and backend unreachable reasons instead of silent polling.
- Risky commands are confirm-gated in the phone-side bridge.

Remaining gaps:

- Box JSON still lives in `@AppStorage`; the bearer token now lives in Keychain with migration from the legacy value.
- Standalone watch tokens are now scope-classified, but the practical endpoint matrix should keep getting tightened from observed wrist workflows.
- The default phone-paired path depends on `WatchBridgeHost` being mounted in the phone app. Android stores cold-process turns; iOS currently forwards only when listeners exist. That is acceptable for a first cut, but it is not parity.

### Wear OS

Default mode is also **phone-paired**:

- `wear/app/src/main/kotlin/io/yaver/wear/PhoneBridge.kt` sends `WatchProtocol` messages to the paired Android phone over the Wear Data Layer.
- `mobile/native-wear/android/YaverWearListenerService.kt` receives messages on the phone.
- `mobile/native-wear/android/YaverWearBridgeModule.kt` emits to JS and persists pending turns when the React instance is not alive.
- `mobile/src/components/WatchBridgeHost.tsx` reuses the same JS bridge as Apple Watch.

Standalone mode:

- `wear/app/src/main/kotlin/io/yaver/wear/Backend.kt` implements the same Convex device-code contract.
- `wear/app/src/main/kotlin/io/yaver/wear/ui/SignInScreen.kt` renders QR plus short code.
- `wear/app/src/main/kotlin/io/yaver/wear/StandaloneStore.kt` stores token, box URL, opt-in, machine id, relay base URL, and relay password.

Strengths:

- Android has better dead-process handling than iOS watch: pending Wear turns are stored and drained later.
- The standalone backend code explicitly corrected the camelCase Convex response mismatch and treats unknown statuses as failures rather than pending.
- Relay fallback support exists in `StandaloneEndpointConfig`.

Remaining gaps:

- `StandaloneStore` now prefers encrypted shared preferences and migrates the legacy plain store. It still has a plain compatibility fallback for Wear images where AndroidX Security cannot initialize.
- Standalone token scope is constrained at session mint time, but relay password custody on the wrist still increases blast radius.
- Relay password custody on the watch increases blast radius. The phone-paired mode should remain the default, and standalone should be framed as exceptional.

## Car Sign-In

### iOS CarPlay

CarPlay is phone-inherited only:

- `mobile/ios/Yaver/Info.plist` registers a `CPTemplateApplicationScene`.
- `mobile/ios/Yaver/YaverCarPlaySceneDelegate.swift` renders a `CPVoiceControlTemplate`, sets a pending car voice launch flag, and opens `yaver://car-voice-coding?autostart=1`.
- The real loop lives in `mobile/app/car-voice-coding.tsx` and `mobile/src/lib/carVoiceCoding.ts`.
- `YaverInfo.setCarPlayVoiceState(...)` updates the CarPlay template state from JS.

Auth implication: CarPlay does not sign in. It can only work if the iPhone app has a valid Yaver token and selected/available runtime.

This is the correct model. CarPlay should never ask for credentials or display an OAuth/device-code flow. If the phone is signed out, the driver-safe response is a short spoken/visible state: "Open Yaver on your phone to sign in."

Gaps:

- The CarPlay scene only shows states. It relies on the phone screen/deep link for actual recording, permissions, device selection, and auth failure messaging.
- We need explicit tests that signed-out phone state prevents CarPlay autostart from dispatching anything and produces a short actionable message.
- The car surface must keep the "never read code/diffs aloud" rule server-visible or test-covered, not only UI-side.

### Android Auto

Android Auto is also phone-inherited:

- `mobile/android/app/src/main/AndroidManifest.xml` declares Android Auto notification/messaging eligibility.
- `mobile/plugins/withAndroidAutoMessaging.js` injects the manifest metadata and native Kotlin module during prebuild.
- `mobile/native-androidauto/android/YaverCarMessagingModule.kt` posts `NotificationCompat.MessagingStyle` plus `CarExtender.UnreadConversation` and receives `RemoteInput` replies.
- `mobile/src/lib/carMessagingNotification.ts` builds Android Auto conversation payloads.
- `mobile/src/lib/carReplyDispatch.ts` handles replies, including risky-command confirmation.

Auth implication: the car never receives a token. The phone app receives the car reply and uses its existing token/device connection to act.

Strengths:

- The implementation stays in the entitlement-free messaging lane.
- Risky replies are gated before dispatch.
- Cold-process replies are stored and drained, improving reliability.

Gaps:

- Android Auto is still dependent on notification permission and native module availability. The fallback is phone-visible notification, not necessarily head-unit live.
- A signed-out phone must not let pending car replies queue until a later sign-in and then execute stale commands.
- Conversation IDs are device-thread keyed. We should ensure stale replies cannot accidentally target a newly selected box after sign-in/device switch.

## AR/VR Sign-In

### Native visionOS

Native visionOS has the most complete standalone auth story:

- `visionos/project.yml` shares `Backend.swift`, `AppleSignIn.swift`, `OAuthSignIn.swift`, `YaverStore.swift`, and client models from tvOS.
- `visionos/YaverVision/Views/VisionSignInView.swift` correctly avoids QR-first UX because a user cannot scan a virtual QR they are wearing.
- The primary path is native Sign in with Apple through `AuthenticationServices`.
- Secondary paths use in-headset OAuth for Google/Microsoft/GitHub/GitLab through the same web endpoints as the phone.
- Device-code remains as fallback for approving from a phone by typing a short code.

Strengths:

- The headset can sign in by itself, so it should. This is better than TV-style QR.
- Error text names the likely Sign in with Apple failure modes.
- visionOS UI tests explicitly cover signed-out launch and sign-in affordances.

Gaps:

- Shared `Backend.surface` now reads a `YaverNativeSurface` Info.plist value when present; visionOS sets it to `vision` and tvOS keeps the `tv` fallback.
- Device-code fallback now mints `vision` scope for the expected visionOS/XR platform/environment values.
- If the app signs in through native Apple/OAuth, session scope is probably normal full. That may be acceptable for a first-party headset dashboard, but it should be an explicit product decision.

### Web `/spatial`

Web `/spatial` is not account sign-in. It is a direct agent bridge:

- `web/app/spatial/page.tsx` opens with `https://yaver.io/spatial?agent=<url>` for the normal flow.
- `web/app/spatial/useAgentBridge.ts` mints a spatial device code, polls for approval, receives an in-memory scoped token, and still supports legacy `token=` links after scrubbing the URL.
- It calls `/tasks`, `/tmux/sessions`, `/remote-runtime/sessions`, `/voice/stream`, and WebRTC/control endpoints with `Authorization: Bearer <token>`.
- `web/app/spatial/TmuxPane.tsx` also passes token in WebSocket query params because browser WebSocket cannot set custom headers.

This is still pragmatic for "Open in headset", but the normal path is no longer durable bearer-in-URL.

Risks:

- Legacy bearer-in-URL links still exist for compatibility and can leak before the page scrubs them.
- WebSocket auth still needs query-token fallback because browser WebSocket cannot set custom headers.
- The new `spatial` SDK scope is method-aware on the agent, but terminal/voice WebSocket tickets should eventually be narrower than the REST token.

Recommended direction:

- Keep moving legacy launchers from `token=` to `agent=` plus phone-approved device code.
- Bind spatial tokens to target devices where the launcher knows the device id.
- Replace WebSocket query bearer with a single-purpose websocket ticket minted by the agent/web bridge.

### Android XR / Tethered Glasses

Android XR compatibility is currently declared in the shared mobile app manifest:

- `android.software.xr.api.openxr` and `android.hardware.vr.headtracking` are optional.
- The main activity has `com.oculus.intent.category.VR`.
- `mobile/app/glass-workspace.tsx` and web `/spatial` appear to be the main current glass/headset paths.

Auth implication: Android XR/tethered glasses inherit the Android phone app's session if running in the mobile app, or use the web `/spatial` URL token if opened in a headset browser.

Gaps:

- There is no separate Android XR native sign-in flow.
- For phone-driven tethered glasses, this is fine: the phone is already signed in.
- For standalone Android XR browser mode, it has the same URL-token risk as `/spatial`.

## Security Model By Surface

| Surface | Primary auth holder | Standalone token? | Current sign-in UX | Main risk |
|---|---:|---:|---|---|
| Apple Watch default | iPhone | No | none; paired phone required | iOS bridge drops messages if JS listener absent |
| Apple Watch standalone | watch | Yes | device code + short code/QR | Keychain token custody; constrained session scope |
| Wear OS default | Android phone | No | none; paired phone required | phone bridge availability |
| Wear OS standalone | watch | Yes | device code + short code/QR | encrypted prefs primary; relay password custody remains sensitive |
| CarPlay | iPhone | No | none; phone app session required | signed-out/permission failure must be terse and non-dispatching |
| Android Auto | Android phone | No | none; phone app session required | stale RemoteInput after sign-out/device switch |
| visionOS native | headset | Yes | Apple native, OAuth, or device-code fallback | native OAuth session remains full by product choice |
| Web `/spatial` | headset, phone-approved | Yes, in memory | agent URL + device-code approval | legacy URL-token compatibility and WS query-token fallback |
| Android XR mobile | Android phone | No | phone app auth | no separate issue if phone-driven |
| Android XR browser | URL bearer | Yes, via URL | generated link | same as web `/spatial` |

## Product Rules That Should Be Enforced

1. Car surfaces must never present credential entry.
2. Watch default mode must remain tokenless.
3. Watch standalone must be explicit opt-in and use encrypted storage.
4. Headsets that have a browser and biometric identity should sign in locally, not require scanning a QR.
5. QR is valid for TV and optional for watches; QR is wrong as the primary headset UX.
6. URL bearer is acceptable only as a short-lived bootstrap secret, not as the durable session.
7. `X-Yaver-Surface` is useful for UX adaptation but must never authorize.
8. Every companion token should be target-device-bound, surface-scoped, route-limited, and revocable independently.
9. AR/VR can use the phone when that is the pragmatic path. The mistake is making the phone the only possible path when the headset can sign in locally, or making QR scanning the primary headset instruction. A phone can approve, relay, type a code, or act as trackpad/confirm surface.

## Implementation Status And Remaining Plan

### P0: Stop Token Overreach

- Done: session scopes now include `watch`, `vision`, and `spatial`.
- Done: `backend/convex/deviceCode.ts` classifies watchOS, Wear OS, visionOS, Android XR, Quest, TV, and spatial browser flows.
- Done: Convex account-level operations deny non-full scopes through the shared full-scope gate.
- Done: the agent enforces method-aware companion session allowlists and a method-aware `spatial` SDK scope.

### P0: Replace `/spatial` URL Bearer

- Done: `/spatial?agent=<url>` mints a device code with `environment:"spatial"` and polls for a scoped in-memory token.
- Done: legacy `token=` links are scrubbed from browser history via `history.replaceState`.
- Remaining: WebSocket terminal and voice access should use separate short-lived tickets.

### P1: Secure Standalone Watch Storage

- Done: watchOS standalone token storage migrates from `@AppStorage` to Keychain.
- Done: Wear OS standalone storage prefers AndroidX encrypted shared preferences and migrates old values.
- Remaining: decide whether relay password should exist on standalone watches at all.

### P1: Signed-Out / Stale Command Guards

- CarPlay and Android Auto should have explicit signed-out behavior: no dispatch, no queued execution after future sign-in, short actionable message.
- Android Auto pending RemoteInput replies should include timestamp, conversation id, target device id, and auth epoch/session id; drop if stale or mismatched.
- Watch pending turns should similarly bind to current auth/device epoch on the phone side.

### P1: Surface Parity Tests

- Add tests that prove device-code field names stay camelCase and each surface sends the intended platform/environment.
- Add tests that watch standalone tokens are rejected from account-destructive routes.
- Add tests that `/spatial` scoped tokens can do only the routes needed for spatial, not general `/tasks` mutation or vault/admin endpoints.
- Add car signed-out tests for both CarPlay deep-link autostart and Android Auto RemoteInput.

### P2: visionOS Surface Cleanup

- Stop relying on shared `Backend.surface = "tv"` for vision requests. Either make surface an injected value or split a small `VisionBackend`.
- Decide whether native visionOS should receive full account sessions or a constrained `vision` scope. If full, document why.
- Keep no-QR primary UX. It is correct for headset ergonomics.
- Keep phone-assisted sign-in as an explicit pragmatic fallback: show a short code that the user can type into the phone through passthrough, and optionally let the signed-in phone push an approval/launch token to the headset. Do not require photographing a virtual QR.

### P2: Phone-Assisted AR/VR Login

For AR/VR, the practical product rule should be: **the headset can sign in by itself, but the phone may help whenever that reduces friction**.

Useful phone-assisted modes:

- **Approve by short code**: headset displays a large code; signed-in phone enters/approves it.
- **Push launch to headset**: phone generates a scoped spatial launch and sends it through Universal Link, nearby share, QR shown on phone, or local network handoff.
- **Phone as confirm/trackpad**: after headset login, phone remains a low-friction approve/deny and pointer surface for risky actions.
- **Recovery**: if headset OAuth fails or the headset browser is awkward, the phone can complete auth and hand back a one-time scoped token.

Guardrails:

- The phone handoff should mint a headset/scoped token, not copy the phone's durable full session into the headset.
- Any handoff token should be one-time, short-lived, target-device-bound, and cleared from URL/history after redemption.
- The headset UI should say "use your phone" as an option, not as the only route.

## First Concrete PR Shape

The first implementation PR should be narrow:

1. Add companion session scopes to schema/types and device-code classification.
2. Add backend tests for watchOS/Wear OS/visionOS platform classification.
3. Add route allowlist enforcement for `watch`, `vision`, and `spatial` tokens.
4. Update watchOS/Wear OS/visionOS clients to pass exact platform/environment strings consistently.
5. Leave CarPlay/Android Auto tokenless; add signed-out no-dispatch tests.

Do **not** start by building new sign-in screens for car or default watch. That would move the product in the wrong direction. The deeper fix is token custody and scope.

## Files Verified

- `backend/convex/deviceCode.ts`
- `backend/convex/auth.ts`
- `backend/convex/schema.ts`
- `desktop/agent/surface.go`
- `mobile/src/context/AuthContext.tsx`
- `mobile/src/lib/auth.ts`
- `mobile/src/lib/watchEntry.ts`
- `mobile/src/lib/watchBridge.ts`
- `mobile/src/components/WatchBridgeHost.tsx`
- `mobile/native-watch/ios/YaverWatchBridge.swift`
- `mobile/native-wear/android/YaverWearListenerService.kt`
- `mobile/native-wear/android/YaverWearBridgeModule.kt`
- `watch/YaverWatch/Views/SignInView.swift`
- `watch/YaverWatch/WatchStore.swift`
- `watch/YaverWatch/PhoneSession.swift`
- `watch/YaverWatch/Backend.swift`
- `wear/app/src/main/kotlin/io/yaver/wear/Backend.kt`
- `wear/app/src/main/kotlin/io/yaver/wear/StandaloneStore.kt`
- `wear/app/src/main/kotlin/io/yaver/wear/PhoneBridge.kt`
- `wear/app/src/main/kotlin/io/yaver/wear/ui/SignInScreen.kt`
- `mobile/app/car-voice-coding.tsx`
- `mobile/src/lib/carVoiceEntry.ts`
- `mobile/src/lib/carVoiceCoding.ts`
- `mobile/src/lib/carMessagingNotification.ts`
- `mobile/src/lib/carReplyDispatch.ts`
- `mobile/ios/Yaver/YaverCarPlaySceneDelegate.swift`
- `mobile/ios/Yaver/Info.plist`
- `mobile/android/app/src/main/AndroidManifest.xml`
- `mobile/native-androidauto/android/YaverCarMessagingModule.kt`
- `mobile/plugins/withAndroidAutoMessaging.js`
- `visionos/YaverVision/Views/VisionSignInView.swift`
- `visionos/project.yml`
- `visionos/README.md`
- `web/app/spatial/page.tsx`
- `web/app/spatial/useAgentBridge.ts`
- `web/app/spatial/TmuxPane.tsx`
- `docs/xr-spatial-design.md`
