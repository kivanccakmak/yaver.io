# Tablet Vibe Studio — Deep Audit & Implementation

**Date:** 2026-08-21 · **Status:** Phases 1–5 IMPLEMENTED + DEPLOYED (2026-08-21 second session)
**Target:** Samsung ~10" tablet, native Yaver Android app, vibe-coding SFMG (React Native / Expo)
**Remote box:** Ubuntu 4 GB — runs the coding agent AND renders via headless Chrome
**Goal:** landscape = left live app view (browser lane) / right chat, portrait = chat + preview peek — mirroring the tvOS and web split interfaces.

> Golden rule: every `.md` in this repo drifts. The code is the source of truth — grep before acting on any claim below. File:line citations were verified on disk at write time.

---

## 2c. Deploy status (2026-08-21, second session)

| Surface | Status | Detail |
|---|---|---|
| iOS TestFlight | ✅ uploaded | build 202608181336 (Delivery `ef975f4d`) |
| tvOS | ✅ uploaded | build 296 accepted |
| visionOS (AR/VR) | ✅ uploaded | Delivery `de18046a` (after fixing a pre-existing broken visionOS build — see below) |
| CarPlay | ✅ | ships inside the iOS app; gate preflight passed |
| watchOS | ✅ builds | embedded in iOS (no separate record) |
| macOS desktop (TestFlight) | ✅ uploaded | build 20260821024152 (Delivery `68654092`) |
| Convex backend | ✅ success | release-backend workflow |
| Web (Cloudflare) | ⏳ CI in progress | release-web workflow (needs CF token, only in GH secrets) |
| npm CLI (yaver-cli) | ⏳ CI in progress | release-cli workflow with publish_npm=true — ships the viewer registry + TV-scoped `POST /tasks` allowlist (`6a70b7e3f`) |
| Android Play internal | ⏳ CI in progress | release-mobile workflow (uses `PLAY_STORE_SERVICE_ACCOUNT_JSON` secret) |
| Wear OS / AndroidTV / Android Auto | ⛔ blocked locally | no Play service-account key / release keystore in the deploy clone; these need the user's key (`keys/google-play-service-account.json`) or a CI lane |

**Pre-existing broken surface fixed during deploy:** `6a70b7e3f` (TV-login) deleted `tvos/YaverTV/AppleSignIn.swift` + `OAuthSignIn.swift` when it consolidated tvOS sign-in, but left `visionos/project.yml` referencing them + the visionOS `VisionSignInView` still using `OAuthSignIn`/`AppleNativeAuth` — so visionOS had not compiled since that commit. Restored both files (gated `#if !os(tvOS)`), added the two missing `TaskComposerView` deps (`YaverDictationField.swift`, `TVInputStatus.swift`) to `visionos/project.yml`. Committed as `811106a79`.

**Deploy-machine notes for the next session:**
- `~/Workspace/yaver-deploy-runner` is the deploy clone (created 2026-08-21). Gitignored generated `mobile/ios/` + `visionos/YaverVision.xcodeproj` + RNAudioAPI `iphoneos` binaries must be synced from the main working repo into the clone (they don't exist in a fresh clone).
- Missing local secrets: `~/.yaver/local-secrets.env`, `~/.npmrc`, `~/.cloudflare/yaver.env`, `keys/google-play-service-account.json`. The Apple surfaces worked via `~/.appstoreconnect/yaver.env` + GUI-unlocked keychain; everything else went through GitHub Actions secrets.
- A stale TestFlight deploy-lease (dead same-host pid) blocked a re-run; clear with the store's crash-reclaim (`sqlite3 ~/.yaver/autoruns.db "DELETE FROM deploy_leases WHERE target='testflight' AND holder LIKE '<host>/pid<pid>'"`).
- Known pre-existing flake: full `go test .` main-package times out on `TestCustodianAbandonsAHangingWarden` (passes in isolation; present on clean HEAD).

---

## 0. Ground truth — what already exists

### The tablet is already a first-class shape in the mobile app
Single source of truth: `useResponsiveLayout` — `mobile/src/hooks/useResponsiveLayout.ts:31-85`.
- short-edge ≥ `breakpoints.tablet` (600) → `tablet-portrait`; landscape or width ≥ 900 → `tablet-landscape` (`:45`).
- A 10" Samsung in landscape (~1280×800dp) classifies as `tablet-landscape`, `paneCount=3` at width ≥1100 (`:53`).
- `layoutTokens` in `mobile/src/theme/tokens.ts:17-72`: `breakpoints = { tablet:600, tabletLandscape:900, desktop:1200 }`, `pane = { minListWidth:320, maxListWidth:420, detailMinWidth:480, threeColMinWidth:1100 }`, `rail = { width:88, expandedWidth:240 }`.

Wired everywhere:
- **Landscape = left nav rail** instead of bottom tabs: `mobile/app/(tabs)/_layout.tsx:148` (`useLeftRail`), `tabBarPosition:"left"` at `:402`, rail width `layout.rail.expandedWidth` at `:428`. Portrait gets a taller 76pt bottom bar (`:155-158`).
- **Landscape = true split cockpit in Tasks**: `mobile/app/(tabs)/tasks.tsx:1903` (`tabletDualPane`); left = live task list (`:7793-7857`), right = chat modal at `max(560, width*0.58)` (`:7866-7874`). This is already the right-side "chat/vibe" pane.
- **Reusable `SplitPane`**: `mobile/src/components/layout/SplitPane.tsx:19-114` — modes `list-detail | rail-detail | three`; true split on landscape, collapses to 1–2 panes on phone/portrait.
- **Orientation unlocked on tablets** (phones locked portrait): `mobile/app/_layout.tsx:142-157`.
- **Master-detail on landscape**: `mobile/app/(tabs)/devices.tsx:1043` (`useMasterDetail`, 380pt list + inline detail).

### The browser lane already exists and is embedded
`DevPreview` (`mobile/src/components/DevPreview.tsx:177`) — full ready-probe/log-overlay/failure-panel WebView lane, used **twice** in Tasks:
- banner above the task list: `tasks.tsx:6366`
- inside the chat-detail modal (`hostedInModal`, iOS can't stack native Modals): `tasks.tsx:8173`

`WebViewCompat` (`mobile/src/components/WebViewCompat.tsx` + `.web.tsx`) — native WebView on iOS/Android, `<iframe>` on RN-web.

### The exact split already exists in two other surfaces (the reference shapes)
- **tvOS**: `tvos/YaverTV/Views/RemoteRuntimeWebRTCView.swift:158-216` — `GeometryReader` + `HStack`: **40% live stream / 58% chat rail**, each its own `.focusSection()`. `VibeTurnPanel.swift` is the chat console; `ProjectsView.swift:16-22` already defines a `.tablet = 820×1180` preview viewport.
- **Web**: `web/components/dashboard/VibeCodingView.tsx:2426-2434` — **left preview rail `w-[46vw] min-w-[380px] max-w-[760px]` + right chat/console at all widths**. Drag-divider reference: `WebReloadView.tsx:186-207` and `RuntimeLabView.tsx:1851-1877` (pointer-capture + CSS var + localStorage persistence).

### Preview lanes available to the mobile app
| Lane | Mechanism | Use when |
|---|---|---|
| **Browser lane (WebView)** | `DevPreview` → `${baseUrl}/dev/` or `/dev-web/` via relay proxy (`devserver_http.go:2651-2802`, cookie scope `relay/webview_cookie.go:11-41`) | Interactive preview; box only runs Metro — **zero extra load on the 4GB box** |
| **Frame lane (modern)** | `/vibing/preview/start` → `/vibing/preview/events` SSE → content-addressed `/vibing/preview/frames/{hash}` `<Image>`; profiles `live-direct`/`live-relay-wifi`/`live-relay-cell` (`desktop/agent/vibe_preview.go:53-77`) | "Watch the agent change it" — headless Chrome on the box |
| **Legacy frame poll** | `(tabs)/vibing.tsx:296-342` polls `/vibing/frame` every 2.5s | ⚠️ Old; to be retired |
| **Remote-runtime WebRTC** | `remote-runtime.tsx` — H.264 RTP direct / ~1fps JPEG-poll over relay (`remote-runtime.tsx:132-145`) | Native/emulator surfaces |

### The chat/console that goes on the right (all already built)
- Chat bubbles: `tasks.tsx:8193-8209` (FlatList), `ChatBubbleImpl` `:1029`, `MessageBubble`.
- **`LiveConsoleSection`** — foldable ANSI console rendering raw runner stdout via `AnsiConsoleText` + `summarizeRawConsole` (`tasks.tsx:1717`, `:681`, `:1775`), `● live / ○ idle` dot + byte counter (`:1756-1767`).
- Composer with follow-up; SSE consumption via XHR streaming `quicClient.streamTaskOutput` (`mobile/src/lib/quic.ts:3153-3220`), raw lane capped 512KB (`tasks.tsx:3501`).
- **`VibePreviewModal.tsx` (orphaned)** — the modern frame lane as a component, built but mounted nowhere (`mobile/src/components/VibePreviewModal.tsx:48-325`).

### Transport / surface identity
- Mobile reaches the box via `baseUrl` = relay `https://<relay>/d/<deviceId>` (`quic.ts:1926`); auth headers + `X-Relay-Password`.
- Surface identity seam exists: `viewportHeaders()` sets `X-Yaver-Surface` / `X-Yaver-Interaction` (`mobile/src/lib/runtimeSurfaceTypes.ts:246-258`); `RuntimeSurface` includes `"mobile-tablet"` (`:3`).
- **Not yet sent by the tablet studio** — no `X-Yaver-Surface: mobile-tablet` on normal tasks/preview requests yet.

---

## 1. The gaps (why the audit matters)

1. **No mobile landscape surface with preview-LEFT / chat-RIGHT.** The cockpit is *list*|chat; the preview only appears as a banner or a full-screen modal. The pieces exist (`DevPreview` + chat pane + `SplitPane`) but nobody assembles a studio.
2. **The modern frame lane is orphaned.** `VibePreviewModal` is built but not mounted; the Vibing tab still polls the legacy `/vibing/frame`.
3. **No tablet e2e lane** — `surfaceViewports.ts` has a tablet profile but tests only drive iPhone.
4. **No `X-Yaver-Surface: mobile-tablet`** on tablet requests, so the box can't tune the frame profile for a tablet-over-relay client.

---

## 2. What was implemented (2026-08-21)

| Phase | Status | What landed |
|---|---|---|
| 1 | ✅ | `mobile/app/vibe-studio.tsx` — landscape split (LEFT ≈55% `DevPreview` browser lane / `LivePreviewPane` frame lane, RIGHT ≈45% `StudioChatPane`), lane switcher, project picker, `X-Yaver-Surface: mobile-tablet` set on mount + cleared on unmount. Entry point: More menu → "Vibe Studio" (tablet-only card, `more.tsx`). |
| 2 | ✅ | `mobile/src/components/studio/LivePreviewPane.tsx` — the modern `/vibing/preview/*` frame lane extracted from `VibePreviewModal` into an EMBEDDED pane (auto-start, SSE subscribe, content-addressed `<Image>`, stop-on-unmount so Chrome isn't left eating RAM on the 4 GB box). |
| 3 | ✅ | Portrait (`tablet-portrait`) renders single-pane chat + a "Preview" peek tab (expandable ~280pt `LivePreviewPane` above the chat). |
| 4 | ✅ | `quicClient.setSurfaceMarker("mobile-tablet")` / `clearSurfaceMarker()` → `X-Yaver-Surface` on every authed request from the studio (`quic.ts:authHeaders`); the box can now tune the frame profile for a tablet-over-relay client. Net-mode already flows via `X-Yaver-NetMode` (`vibePreview.ts:101-147`). |
| 5 | ✅ | `web/lib/surfaceViewports.ts` gained a `tabletLandscape` surface (Playwright `Galaxy Tab S9 landscape`, 1024×640 @2.5x) + unit tests; `e2e/tests/tablet-vibe-studio.spec.ts` asserts landscape split (lane switcher + composer) and portrait peek (no switcher + peek tab) in real device contexts. |
| 6 | ⏳ | Docs — this file updated; `VIBING_STATUS.md` / CLAUDE.md cross-surface note pending commit. |

### What was deliberately NOT touched (the "don't pollute" boundary)
- **No third preview implementation.** The studio reuses `DevPreview` (browser lane), `AnsiConsoleText`, `summarizeRawConsole`, `MessageBubble`, `streamTaskOutput`, `executeVibingSuggestion` — the studio's chat pane is a *host* for the shared primitives, not a re-derivation. AGENTS.md parity rule preserved.
- **No edit to the 9.5k-line `tasks.tsx`.** The studio is a separate screen; the existing Tasks cockpit is untouched.
- **No native connect path weakened.** The surface marker is opt-in (set only by the studio) and additive.
- **Phone UI unchanged.** The More-menu card is gated on `layout.isTablet`; phones never see it.

## 2b. Android vs iOS platform-difference audit (deep)

The same studio surface runs on both platforms, but the **preview lanes available differ**, and the studio should expose honest options per platform. Verified on disk:

| Capability | Android (Samsung tablet) | iOS | Source of truth |
|---|---|---|---|
| **Browser lane (WebView → `/dev/`, `/dev-web/`)** | ✅ System WebView, full XHR streaming | ✅ WKWebView | `WebViewCompat.tsx` |
| **RN fetch vs XHR SSE streaming** | RN-Android `fetch` **buffers** the whole body → SSE must use XHR `onprogress` (the exact Samsung-tablet workaround noted in `quic.ts:3194-3200`); the studio + Tasks already use XHR (`streamTaskOutput`) | RN-iOS `fetch` streams live via NSURLSession | `quic.ts:3193-3200` |
| **Frame lane (headless Chrome on the box, `/vibing/preview/*`)** | ✅ identical on both | ✅ identical | `vibePreview.ts` |
| **Box rendering (Chrome capture on the 4 GB Ubuntu box)** | ✅ — the box runs Metro **and** Chrome capture; profiles `live-relay-wifi`/`cell` | ✅ same | `vibe_preview.go:53-77` |
| **WebRTC remote-runtime video** | ✅ H.264 RTP **direct**; JPEG-poll (~1fps) over relay | ✅ same lane | `remote-runtime.tsx:132-145` |
| **MJPEG single-frame vs stream** | Android can use `captureStreamUrl` (MJPEG) | iOS **cannot** render multipart MJPEG in WKWebView → must poll `captureFrameUrl` | `quic.ts:1954-1970` |
| **Native screen recorder for clips** | ✅ MediaProjection (system bottom-sheet on **every** call — framework doesn't persist the grant) | ✅ ReplayKit (one "allow" per session) | `screenRecorder.ts:34-43` |
| **Hermes bundle guest-app mount** | ✅ native bridge | ✅ native bridge (iOS can't stack two native Modals → `DevPreview hostedInModal` in the cockpit) | `DevPreview.tsx:8169-8173` |
| **Orientation** | ✅ tablets unlocked via `ScreenOrientation.unlockAsync()` | ✅ same (phones locked portrait) | `_layout.tsx:142-157` |
| **Remoteless / local-first options** | The tablet itself can hold DeepSeek keys (`settings.tsx:4698` phone-side vibe) and — with the in-progress `docs/architecture/REMOTELESS_AI.md` — fix a runnerless box. Android's extra rope is the **box-rendering** frame lane + MediaProjection clips both available natively | Same remoteless lanes, but **fewer box-side render options** in practice (no Android-emulator capture via `adb` from iOS; the box's Chrome frame lane is the primary render) | `REMOTELESS_AI.md`, `vibe_preview_clip.go` |

**Bottom line for the studio:** keep both lane buttons (`Browser` / `Live`) on **both** platforms — both lanes work everywhere. The platform split is at the *edges*: iOS gets the honest "preview frames over relay" default (lower FPS, single-frame poll, no MJPEG); Android additionally gets box-side frame capture and MediaProjection clips. The studio already degrades honestly via the shared libs (`getNetMode` picks `live-relay-cell` on cellular; `LivePreviewPane` stops Chrome on unmount for the 4 GB box).

---

## 3. Remaining follow-ups (after the implemented phases)

- **Retire the legacy `/vibing/frame` poll** in `mobile/app/(tabs)/vibing.tsx:296-342` in favour of the modern `/vibing/preview/*` lane (the shipped Vibing tab still uses the old route; `VIBING_STATUS.md:35` says native surfaces moved to the modern lane).
- **Drag-divider** between the studio's panes (the web's `WebReloadView.tsx:186-207` / `RuntimeLabView.tsx:1851-1877` pointer-capture pattern) — currently a fixed 55/45 split.
- **`VibePreviewModal` clipping of clips** stays for full-screen/clips use; the studio pane is intentionally clip-free to keep the split clean.
- `VIBING_STATUS.md` + CLAUDE.md cross-surface note.

## 4. File-touch list (implemented)

| File | Change |
|---|---|
| `mobile/app/vibe-studio.tsx` | **new** — landscape split studio (preview left / chat right), lane switcher, project picker, portrait peek, surface marker |
| `mobile/src/components/studio/StudioChatPane.tsx` | **new** — chat/composer/live-console pane, reusing shared primitives |
| `mobile/src/components/studio/LivePreviewPane.tsx` | **new** — `/vibing/preview/*` frame lane as an embedded pane |
| `mobile/src/lib/quic.ts` | `setSurfaceMarker` / `clearSurfaceMarker` → `X-Yaver-Surface` on authed requests |
| `mobile/app/(tabs)/more.tsx` | "Vibe Studio" card (tablet-only) + `handleVibeStudio` + `useResponsiveLayout` import |
| `web/lib/surfaceViewports.ts` | new `tabletLandscape` surface (Galaxy Tab S9 landscape) |
| `web/lib/surfaceViewports.test.ts` | tabletLandscape profile tests |
| `e2e/tests/tablet-vibe-studio.spec.ts` | **new** — landscape split + portrait peek in real device contexts |
| `TABLET_VIBE_STUDIO_PLAN.md` | this doc |

No native-side changes. Everything additive; no native connect path is weakened.
