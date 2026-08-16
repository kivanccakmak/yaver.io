# End-to-end vibe closed-loop test — every client surface, one scenario

## The thesis

Yaver's core promise is: *from any device you hold, sign in → reach your box →
describe a change → watch it render.* This harness proves that whole loop, end
to end, against the **real** stack (live web, real relay, real ubuntu-4gb, real
Codex), from **every client surface** — and it proves it the only way that
counts: **the pixels actually changed.**

The design principle is **one scenario, many client adapters, one shared
render oracle.** The remote box that runs the runner and renders the preview is
the SAME for every surface (ubuntu-4gb, Codex primary). Only the *client code*
differs — web dashboard, mobile app, tvOS, watchOS, CarPlay, voice. So any
difference the harness observes is the CLIENT, never the scenario or the box.
This is the closed loop the CLAUDE.md "Browser transport contract" calls PIXELS
/ NAMED / SILENT, generalized to every surface.

## The canonical scenario (surface-agnostic)

The same ordered steps run on every adapter. Each step is an assertion.

| # | Step | Assertion / oracle |
|---|---|---|
| 1 | **AUTH** — sign in with the user's own creds | reaches the signed-in shell; creds via env, NEVER logged/committed |
| 2 | **CONNECT** — auto-connect to the PRIMARY box | connected to ubuntu-4gb; primary runner = **Codex**; renderer = ubuntu-4gb. Oracle: relay `/d/<id>/health` 200 == the box is truly reachable+authorized (the false-positive harness) |
| 3 | **OPEN VIBE** — go to Vibing, select `yaver / mobile`, render its **web-UI path** | the preview surface mounts and the initial bundle delivers (transport `delivered`) |
| 4 | **BASELINE** — read the rendered login background | == black (`readPreviewBackground()` — the shared oracle) |
| 5 | **VIBE →** send in chat: *"change the login page background from black to green"* | the message appears in the chat transcript; the turn reaches a terminal state (Codex run → completed) |
| 6 | **RENDER →** wait for the preview to re-render | the auto-render fires (per-turn dedupe-key fix); transport re-`delivered` |
| 7 | **ASSERT GREEN** | `readPreviewBackground()` == green |
| 8 | **VIBE ←** send: *"revert the login page background back to black"* | message in chat; turn completed |
| 9 | **RENDER ←** wait for re-render | re-`delivered` |
| 10 | **ASSERT BLACK** | `readPreviewBackground()` == black (reverted) |
| — | **RECORD** | the whole run → mp4 |
| — | **VERDICT** | **PIXELS** (both transitions observed) · **NAMED** (a named failure the user could act on) · **SILENT** (stuck/blank — the ONLY truly-failing verdict) |

## The shared render oracle — `readPreviewBackground()`

The one measurement every adapter shares. Two methods, most-robust first:

1. **Computed style through the preview frame.** The preview is served from the
   relay proxy `/d/<id>/dev/web-bundle/` — SAME origin as the dashboard — so the
   driver can reach into the iframe's document and read
   `getComputedStyle(root).backgroundColor` of the login container. Exact,
   immune to anti-aliasing.
2. **Pixel sample from a screenshot.** Screenshot the preview region, sample the
   background pixel(s), classify to {black, green, other}. Works even when the
   frame is cross-origin or native (tvOS capture, MJPEG). The classifier is a
   tolerance ball around #000 and a green hue band, not an exact match.

`assertColor(sample, "green")` passes on any clearly-green background; the point
is the *transition* black→green→black, not a specific hex.

## Per-surface adapters (the `SurfaceAdapter` interface)

Each adapter implements the same methods; the scenario runner calls them:
`login()`, `ensureConnectedToPrimary()`, `openVibing()`, `selectProject("yaver/mobile")`,
`renderPreview("web")`, `readPreviewBackground()`, `sendChat(text)`,
`waitForTurnComplete()`, `waitForRender()`, `screenshot()`.

| Surface | Driver | Client under test | Notes |
|---|---|---|---|
| **Web dashboard** | Selenium + Chromium → live `yaver.io` | Next.js `web/` | seed OR email/password login; DevicesView + RuntimeLabView selectors |
| **Mobile app** | Selenium + Chromium → RN-web (`expo start` :8081) | `mobile/` RN code | SAME remote box renders; the client is the phone app's code driven in a browser (the only way to automate the REAL app). iPhone viewport. |
| **CarPlay / Glass (AR/VR)** | Selenium + Chromium → RN-web | shared RN (`app/car-voice-coding.tsx`, `app/glass-*.tsx`) | consume the same `DeviceContext`; adapter overrides only navigation |
| **tvOS / watchOS / Wear** | simulator (`xcrun simctl` / emulator) + Maestro/XCUITest | native Swift/Kotlin | browser can't drive native; the E2E is simulator-driven, the *unit* layer tests each surface's label-derivation + the shared render oracle against a captured frame |
| **Voice STT/TTS** | RN-web voice path + a scripted utterance | `mobile/src/lib/voice/` core | inject the utterance text at the STT boundary ("change background to green"), assert runner dispatch + a TTS response + the same render transition. Core is surface-agnostic → unit-testable without audio. |

## Robustness rules (a vibe turn is SLOW and must not flake)

- **Never assert on a fixed sleep.** Poll for the real terminal signal: chat
  status → `completed`/`review`; transport → `delivered`; background color
  reaching the target. Bounded by a generous deadline (a Codex turn can take
  minutes), and on timeout the verdict is **NAMED** with the last known state,
  never a bare fail.
- **The render is atomic.** Wait for exactly one settled render per turn (the
  dashboard's "queue → quiet status → one final render" policy). Do not sample
  the background mid-reload.
- **Distinguish "runner didn't run" from "render didn't update" from "color
  wrong."** Each is a different NAMED verdict pointing at a different layer
  (runner auth / auto-render dedupe / the edit itself).
- **Creds are env-only.** `YAVER_TEST_EMAIL` / `YAVER_TEST_PASSWORD`; never
  written to a file, log, screenshot region, or commit. The recording trims the
  login keystrokes.

## Files

- `e2e/vibe-e2e/scenario.mjs` — the surface-agnostic scenario + assertions +
  the color oracle + the verdict model.
- `e2e/vibe-e2e/adapters/web.mjs` — Selenium web-dashboard adapter.
- `e2e/vibe-e2e/adapters/mobile.mjs` — Selenium RN-web mobile adapter.
- `e2e/vibe-e2e/run.mjs <surface>` — pick an adapter, run the scenario, record.
- Native + voice adapters land as the later phases; their unit layer
  (`*_test`) asserts the same oracle shapes for cross-surface parity.

## Order of delivery

1. **Web adapter, perfected** — the exact scenario the user described, green ⇄
   black, messages in chat, recorded, PIXELS. (This phase.)
2. **Mobile adapter** — same scenario, RN-web client, same box. Prove parity.
3. **Car/Glass** — trivial once mobile works (shared RN).
4. **tvOS/watch/Wear** — simulator-driven E2E + unit parity.
5. **Voice STT/TTS** — utterance-injected loop.

Each phase ends with a recording and a PIXELS verdict, or a NAMED reason it
can't yet — never a silent pass.
