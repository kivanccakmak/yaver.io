# Yaver closed-loop test catalog

**One rule underneath all of it: never believe a status line — believe a
ground-truth oracle diffed against the pixels the user would actually see.**
Every test here establishes an independent oracle (the relay `/health` 200, a
pushed color, a known DOM state), drives the *real* surface the user holds, and
ends on one of three verdicts:

| Verdict | Meaning | Passing? |
|---|---|---|
| **PIXELS** | the rendered surface actually shows the expected state | ✅ the only pass |
| **NAMED** | it failed, but the product said *why* in words a user can act on | ⚠️ acceptable degrade |
| **SILENT** | a spinner / blank / green over a fact the system already knew | ❌ the only true failure |

Colors used as controlled inputs are chosen to be **unconfusable with failure
artifacts** — e.g. the WebRTC loop uses magenta+blue, never green, because an
H.264 decoder with no content paints the all-zero-YUV "no-signal" frame
`rgb(0,135,0)` which a green probe would false-match.

Focus order (per product priority): **RN and Flutter WebRTC browser streaming
first**; native/Swift + Mac-device capture lanes come later (they need a Mac —
a Linux/Hetzner box cannot produce an iOS video track: `xcrun recordVideo` is
macOS-only and disabled under Xcode 26).

---

## 1. Transport reality matrix (what can be verified where)

The closed loops are only honest if they respect what each transport can do on
each host. This is the map the test design keys off:

| Guest stack | Lane | Producer | Linux/Hetzner box | Mac | Verified by |
|---|---|---|---|---|---|
| **RN / Expo** | browser-window (Metro web) | headless-browser capture → **JPEG-DataChannel** | ✅ real content | ✅ | §3 RN WebRTC |
| **Flutter** | browser-window (Flutter web) | headless-browser capture → **JPEG-DataChannel** | ✅ real content | ✅ | §3 Flutter WebRTC |
| RN / Flutter | dev-web iframe (HTTP, not WebRTC) | dev server proxy | ✅ | ✅ | §2 vibe loops |
| any | stream source (RTP H.264) | ffmpeg(`-f mjpeg`→`libx264`) | ✅ transport; ⚠️ pushed-source content bug | ✅ | §4 WebRTC RTP |
| iOS / Swift | ios-simulator (RTP H.264) | `xcrun simctl recordVideo` | ❌ macOS-only + Xcode-26-disabled | ✅ (later) | — |
| Android / Kotlin | android-emulator (RTP H.264) | `adb screenrecord` | ❌ AVD needs KVM (won't boot on 4 GB arm) | ✅ | — |
| Android | android-redroid | container screen → **JPEG-DataChannel** | ✅ (RTP not wired) | n/a | designed |

**Takeaway:** on Linux the RN/Flutter browser-streaming path is **JPEG-over-
DataChannel via the browser-window target** — that is the working, product-
priority path and it delivers real content. The RTP H.264 *video-track* path is
real but only trivially reachable on Linux via the decoupled stream lane, which
has a pushed-source content bug (§4, §6).

---

## 2. Vibe closed loops (dev-web iframe transport)

The canonical "change the app, see it change" loop. Login → auto-connect the
primary (Codex runner + renderer) → Vibing → render the guest's web UI →
**issue a vibe that flips the background color → assert the painted color →
revert → assert again**. Terminal signal is the *pixel*, never the chat
"delivered" event.

| # | Test | Surface / driver | Guest | Status |
|---|---|---|---|---|
| 2.1 | `e2e/vibe-e2e/run.mjs web` | Web dashboard, Selenium/Chromium | yaver mobile web UI | ✅ **PIXELS** (real-account login, two tasks black→green→black, recorded) |
| 2.2 | `e2e/vibe-e2e/run.mjs mobile` | Mobile app RN-web, Selenium | yaver-todo-rn (browser lane) | ⚠️ login+connect+preview+pixel-read proven; **blocked** on the fixture's web render (`WebView did not render a frame` — missing native modules) |

Oracle: relay `/d/<id>/health` 200 = reachable+authorized. Real `.click()` is
mandatory — `executeScript` clicks do not fire React/RN-web handlers. Auth
seams: web `localStorage["yaver_auth_token"]`; RN-web
`localStorage["yaver.secure.yaver_auth_token"]`.

Architecture: `docs/architecture/E2E_VIBE_CLOSED_LOOP_ALL_SURFACES.md`.

---

## 3. RN + Flutter WebRTC **browser streaming** (PRIORITY)

The product-priority path: a running RN/Expo or Flutter app streamed to a web
browser over WebRTC. On Linux the producer is the **browser-window** target
(`desktop/agent/remote_runtime_browser.go`) → **JPEG-over-DataChannel**
(`remote_runtime_webrtc.go` `startFramePump` → `frames` channel → `<img
src=blob:>`). This is the lane the user confirmed works end to end.

**Closed-loop design (one guest, controlled by a vibe):**
1. Start a remote-runtime session for the guest on the box
   (`POST /remote-runtime/sessions`, `web/lib/agent-client.ts` `startRemoteRuntimeSession`).
2. Target `browser-window`; the box runs the app's web build in a headless
   browser and captures it.
3. Receiver (Chromium = webui, RN-web = mobile) offers recvonly video +
   `frames` DataChannel; box answers `webrtc-datachannel-jpeg-v1`.
4. Assert the `<img src=blob:>` shows **real content** (non-blank), then issue a
   vibe that flips the app background and assert the received frame's color.

| # | Case | Guest | Receiver | Transport | Status |
|---|---|---|---|---|---|
| 3.1 | RN app streams to web browser | yaver-todo-rn (Expo web) | Chromium (webui) | JPEG-DC | ✅ **PIXELS**; mobile-viewport guard now fails running agents that omit `displaySurface=mobile-web` |
| 3.2 | RN app streams to mobile RN-web | yaver-todo-rn | RN-web (mobile) | JPEG-DC | design ✅; automated TODO |
| 3.3 | Flutter app streams to web browser | yaver-todo-flutter (Flutter web) | Chromium | JPEG-DC | design ✅; note: Flutter web serves index even on compile-fail (`project_flutter_web_compile_fail_serves_blank`) — assert real widgets, not HTTP 200 |
| 3.4 | Vibe-controlled color flip over the stream | either | either | JPEG-DC | design ✅ — reuses §2 vibe command, verifies on the WebRTC frame instead of the iframe |

**Pixel assert on JPEG-DC:** the received frame is an `<img>`, not a `<video>`
— read it by drawing the `<img>` to a canvas and sampling, exactly as the RTP
receiver samples `<video>` in §4. A blank/placeholder `<img>` = SILENT.
`remote-runtime-browser-jpeg.spec.ts` also sends real `/control` input into the
browser-window target and requires the next JPEG frame signature to change, so
the pass proves both initial pixels and a closed input→render→stream loop.
With `E2E_EXPECT_MOBILE_VIEWPORT=1`, it also preflights
`/remote-runtime/capabilities` and requires RN/Flutter `browser-window` to
advertise `displaySurface="mobile-web"` plus a portrait viewport before it will
accept a stream.

Audit: `docs/audits/webrtc-mobile-surface-closed-loop-audit-2026-07-29.md`.

**Mac simulator probes:** `e2e/ios-simulator-loop.mjs` verifies the heavier
iOS simulator build/launch/frame loop without judging pixels while `run-guest`
is still building. `e2e/apple-surface-frame-loop.mjs` probes tvOS/watchOS/
visionOS simulator session create + frame capture and records named capture or
launch refusals instead of manufacturing a silent result.

**Not in scope on Linux (later, on a Mac):** iOS/Swift `native-webrtc`
(RTP H.264 via `xcrun recordVideo`) and Android AVD RTP. Do **not** run these on
Hetzner — they cannot produce a track there and would only manufacture a false
NAMED/SILENT.

---

## 4. WebRTC RTP video-track closed loop (browser lane)

`e2e/webrtc-e2e/run.mjs [webui|mobile|both]` — proves the genuine H.264 RTP
video-track transport that every non-device surface (tvOS/watch/car/AR-VR)
rides, deterministically and Linux-native.

- Push a controlled solid-color MJPEG frame (`POST /stream/push?name=<src>`,
  pushed continuously so the source stays live — `pushedFreshWindow=12s`).
- Browser offers recvonly video; harness relays the offer to
  `POST /stream/webrtc/offer` (no browser CORS); box answers with an RTP track.
- `ontrack` → `<video>` → sample the center pixel → assert the pushed color.
- Colors are **magenta + blue** (never green) so the decoder's no-signal frame
  cannot false-match. On any miss the verdict carries `getStats` evidence
  (decode-vs-receive), never a bare "no pixels".

| # | Case | Status |
|---|---|---|
| 4.1 | signaling + ICE (Tailscale) + RTP flow + frame decode | ✅ **proven** (`packetsReceived`↑, `framesDecoded`↑, `ice=connected`) |
| 4.2 | pushed color decodes to matching pixel | 🔴 **content bug** — frames decode to no-signal green; ffmpeg encodes the same JPEG correctly standalone. §6, `docs/audits/webrtc-stream-lane-green-screen-2026-07.md` |

The test is both the transport proof and the regression gate for 4.2 — it flips
to PIXELS the instant the pushed content decodes.

---

## 5. False-positive "scary label" closed loops

Assert the UI never turns a *healthy* box into a frightening label. Oracle: the
relay says the box is reachable **and** authorized (200 with valid creds);
induce the exact self-healable fault (a stale relay password → real 401 body);
assert the classifier reads it as self-healable "Relay refused…", never the
agent-blaming "Unauthorized".

| # | Test | Kind | Status |
|---|---|---|---|
| 5.1 | `e2e/false-positive-scan.mjs` | live oracle vs classifier (needs creds+box) | ✅ true-green |
| 5.2 | `e2e/false-positive-selenium.mjs` | web device-card render | ✅ |
| 5.3 | `web/lib/connection-error.test.ts` | classifier unit (tsx) | ✅ CI-gated |

Architecture: `docs/architecture/CLOSED_LOOP_FALSE_POSITIVE_TESTING.md`.

---

## 6. Deterministic client guards (CI-gated, no creds/box)

Pure-TS primitives run via `tsx` in CI (`.github/workflows/ci.yml`
`client-unit-tests`, gated on mobile/web changes).

| # | Test | Guards | Status |
|---|---|---|---|
| 6.1 | `mobile/src/lib/connectGuard.test.ts` | no unbounded await; guard releasable by a newer attempt (w/ negative controls) | ✅ |
| 6.2 | `mobile/src/lib/relayAuth.test.ts` | relay deny-code classifier, code-first + prose fallback | ✅ |
| 6.3 | `mobile/src/lib/beaconParity.test.ts` | native vs `.web.ts` drift (invisible to tsc, crashes at runtime) | ✅ |
| 6.4 | `web/lib/connection-error.test.ts` | false-positive "Unauthorized" | ✅ |

---

## 7. Per-surface coverage

| Surface | Vibe (§2) | WebRTC browser-stream (§3) | WebRTC RTP (§4) | False-pos (§5) | Guards (§6) |
|---|---|---|---|---|---|
| Web dashboard | ✅ PIXELS | design | ✅ transport | ✅ | ✅ |
| Mobile (RN-web) | ⚠️ fixture | design | ✅ transport | via shared code | ✅ |
| tvOS / watch / car / AR-VR | — | rides §4 transport | ✅ transport proven | — | port TODO |
| Native iOS/Android (Mac) | — | later (Mac) | later (Mac) | — | — |

---

## 8. Known gaps / findings (each is a snowball item)

1. **Stream-lane RTP content bug (§4.2)** — pushed-source frames decode to
   no-signal green though ffmpeg encodes them correctly standalone. Root cause
   needs live feeder instrumentation; characterization + ruled-out causes in
   `docs/audits/webrtc-stream-lane-green-screen-2026-07.md`. Does **not** affect
   the RN/Flutter browser-stream (JPEG-DC) path (§3), which works.
2. **Mobile vibe fixture render (§2.2)** — `yaver-todo-rn` web build doesn't
   paint in the browser lane (missing native modules). Fix lives in the separate
   `yaver-todo-rn` repo (stub the modules behind `Platform.OS === "web"`).
3. **Native/Mac lanes** — deferred to a Mac device by design.

---

## 9. How to run

```bash
# Vibe (needs real creds in env + a live primary):
YAVER_TEST_EMAIL=… YAVER_TEST_PASSWORD=… node e2e/vibe-e2e/run.mjs web
node e2e/vibe-e2e/run.mjs mobile

# WebRTC RTP video-track (needs a live primary reachable over the tailnet):
YAVER_WEBRTC_BASE=http://<box>:18080 node e2e/webrtc-e2e/run.mjs both

# RN/Flutter browser-window WebRTC JPEG-DataChannel (§3, needs a live primary):
YAVER_BROWSER_JPEG_BASE=http://<box>:18080 E2E_BASE_URL=http://127.0.0.1 \
  E2E_REQUIRE_PIXELS=1 E2E_RECORD_ALL=1 \
  npx --prefix e2e playwright test remote-runtime-browser-jpeg.spec.ts --project=chromium

# False-positive (needs the caller's own box):
node e2e/false-positive-scan.mjs

# Deterministic guards (no creds, runs in CI):
tsx mobile/src/lib/connectGuard.test.ts
tsx mobile/src/lib/relayAuth.test.ts
tsx mobile/src/lib/beaconParity.test.ts
tsx web/lib/connection-error.test.ts
```

Creds are always env-only — never committed (public repo).
