# TV vibing scope wall — deep analysis (2026-07-27)

> **Status: fix landed same day (uncommitted at time of writing).**
> Agent: `companionSessionAllowed` tv/vision/spatial branch widened (view +
> preview lifecycle + `/install/*` + `/dev/target`), the watch branch gained
> the standalone-smartwatch lane (`POST /watch/turn`, `GET /watch/result`) it
> had been forbidding, and every companion 403 now carries
> `code: auth.session.scope_denied` + scope (`companionScopeDenied`,
> `reason_codes.go ReasonAuthSessionScopeDenied`). Guards:
> `companion_scope_parity_test.go` — a method+path contract per surface plus a
> scan of `AgentClient.swift`'s literal paths — proven by removing the
> `/droid/frame` row and watching both legs fail. tvOS: role drift fixed
> (install/stop/reload → `renderClient()`; SessionView/ProjectsView/
> RuntimeDashboardView → `runnerClient()`), scope denials classified in
> `FailureSignals.isSessionScopeDenied` (code-first, one prose shim for old
> agents) and rendered as "This box needs an agent update" +
> `NavigationLink → UpdateAgentView` instead of Try again, and the web-preview
> poll tightened 700 ms → 300 ms (snapshot answers are hash-only unless the
> frame changed). visionOS: `project.yml` was missing `FailureSignals.swift`
> while compiling `AgentClient.swift` that references it — added. Whole-module
> `swiftc -typecheck` passes for tvOS and visionOS; scoped `go test` green.
> Car + glass ride the RN app's full-scope session, so no wall exists there.
> Also remapped on tvOS: Expo/RN projects now take the **browser lane**
> (`Models.swift kind`: RN → `.web` → WebPreviewStreamView, which already
> boots the Expo web sibling) instead of redroid — matching the agent's own
> `defaultStreamingSurface` (RN → browser, sub-second HMR, no emulator);
> `.android`/redroid stays for native Android/Kotlin projects.

**Symptom (photographed on the living-room Vestel, Apple TV running YaverTV):**
the Projects screen renders perfectly — project list, framework icons, the
"Render as Phone / Tablet / Desktop" picker — and the moment you pick a
project the preview dies with:

> **No Android screen**
> TV-scoped token cannot access this endpoint
> `[Try again]`

`Try again` can never succeed. This is not a transport failure, a relay
problem, or a redroid problem. It is the agent's own companion-scope gate
(`desktop/agent/httpserver.go:1873 companionSessionAllowed`) forbidding the
endpoints that the shipped tvOS app itself calls. The TV app was built for
the runner/render split vibe loop; the scope wall was never widened to match.

**One sentence:** the TV can *code* (`POST /runner/session/turn` is allowed)
but cannot *see* (every pixel-producing endpoint is forbidden) — the exact
inverse of a useful surface, and a textbook "inventory says yes, operation
says no."

---

## 1. The two gates and where they bite

A TV session token carries `sessionScope: "tv"` (`backend/convex/auth.ts:30`,
type `SessionScope = "full" | "machine" | "tv" | "watch" | "vision" |
"spatial"`). On every authenticated request the agent runs:

```
isCompanionSessionScope(scope)            httpserver.go:1864
  → companionSessionAllowed(method, path) httpserver.go:1873
  → 403 companionScopeDeniedMessage       httpserver.go:1905  ← the photographed string
```

enforced at **six call sites** in `httpserver.go` (2496, 2564, 2688, 2719,
2873, 2891) — local token, cached token, and relay-forwarded paths all hit
the same gate, so switching transports cannot route around it (correct: the
relay authorizes nothing).

The `tv` / `vision` / `spatial` allowlist (httpserver.go:1885–1898) is:

| Allowed | Method |
|---|---|
| `/health` `/info` `/agent/status` `/agent/runners` `/tasks` `/projects` `/tmux/sessions` | GET |
| `/tasks/*` | GET |
| `/ops` `/runner/session/turn` | POST |
| `/remote-runtime/sessions*` | GET/POST |

Everything else → the photographed 403.

## 2. What the shipped tvOS app actually calls

Audit of `tvos/YaverTV/AgentClient.swift` + the views that drive it:

| Endpoint | Caller | Feature | TV scope verdict |
|---|---|---|---|
| `GET /projects`, `GET /tasks`, `GET /tasks/*` | ProjectsView, TasksView | browse | ✅ allowed |
| `POST /ops` (incl. `reload`, `git_connect_status`) | several | ops verbs | ✅ allowed |
| `POST /runner/session/turn` | SessionView | **vibe chat turns** | ✅ allowed |
| `GET/POST /remote-runtime/sessions*` | RuntimeDashboardView | runtime lab | ✅ allowed |
| `GET /droid/frame` | DroidStreamView (`Views/DroidStreamView.swift:82`) | **Android/RN preview** | ❌ 403 — *the screenshot* |
| `POST /vibing/preview/start` / `stop` | WebPreviewStreamView:272 | **web preview capture** | ❌ 403 |
| `POST /vibing/preview/snapshot` | WebPreviewStreamView:354 | frame polling | ❌ 403 |
| `GET /vibing/preview/frames/<hash>` | WebPreviewStreamView:356 | frame bytes | ❌ 403 |
| `POST /dev/start` | WebPreviewStreamView:267 | dev server boot | ❌ 403 |
| `POST /dev/web-preview/start` | AgentClient.swift:275 | static web server | ❌ 403 |
| `GET /dev/events` (SSE) | WebPreviewStreamView:291 | compile/status narration | ❌ 403 |
| `POST /install/<tool>` + install stream | WebPreviewStreamView:190 | missing-toolchain route-to-fix | ❌ 403 |
| `GET /capture/frame.jpg` | AppleTVRemoteView | capture card | ❌ 403 |
| `POST /feedback` | FeedbackView | feedback | ❌ 403 |

**Nine of the app's ~15 agent endpoints are forbidden by its own token.**
Both preview kinds are dead ends: an RN/Android project routes to
`DroidStreamView` → `/droid/frame` → 403; a web project routes to
`WebPreviewStreamView` → `/dev/start` → 403 before it even asks for a frame.
Even the *route-to-fix* lane (`/install/<tool>`, the Install-button contract
from CLAUDE.md's missing-toolchain rule) is scope-blocked — on the TV, the
remedy for a failure is itself a 403.

Why the Projects screen looked healthy: `/projects` is allowed. The
inventory said yes; the first operation said no.

## 3. How this shipped: two gates, hand-copied, drifted

There are **two independent scope gates** for spatial-ish surfaces:

- `spatialSDKRequestAllowed` (httpserver.go:1838) — for **SDK tokens** with
  scope `spatial`. It ALREADY allows `/vibing/preview/status`,
  `POST /vibing/preview/snapshot`, `/vibing/preview/frames/*`,
  `/ws/terminal`, `/voice/stream` — someone extended it for the glass HUD.
- `companionSessionAllowed` (httpserver.go:1873) — for **session tokens**
  with scope `tv|watch|vision|spatial`. Never extended.

Same product capability, two switch statements, one got the vibing rows and
one didn't. This is the wake-ladder-percentages failure mode from CLAUDE.md
("a copied classifier drifts by construction") wearing an auth hat. The
existing test (`sdk_token_test.go:607 TestCompanionSessionAllowed`) asserts
only the *intended* allowlist — it encodes the drift instead of catching it,
because nothing ties the allowlist to what the tvOS client actually calls.

Root process failure: **the scope allowlist and the client's endpoint set
are two copies of one fact with no parity guard** — the exact class
`beaconParity.test.ts` exists to kill on the RN side.

## 4. Why the TV is a *perfect* vibing surface (the RN-browser fit)

The user's read is right: everything hard about "vibing as in webui" is
already solved for the TV case — the wall is the only thing in the way.

1. **The TV is pixels-only by construction.** tvOS has no WebKit; AVPlayer
   can't play the agent's MJPEG (`docs/yaver-tvos-surface.md §1.6`). So the
   tvOS views already implement the honest pattern: snapshot-poll
   `/vibing/preview/frames` at ~2 fps and show the latest. No new rendering
   tech is needed — only permission to fetch the bytes.
2. **The RN-browser lane produces exactly what a TV wants.** The 2026-07-26
   browser-lane fix means the REAL RN app runs as RN-web in headless
   Chromium on the render box, at an arbitrary viewport, with PIXELS-grade
   e2e verification (`e2e/remote-vibe-loop.mjs`). The TV's
   "Render as Phone (390×844) / Tablet (820×1180) / Desktop (1280×720)"
   picker (`ProjectsView.swift:16 PreviewForm`) maps 1:1 onto that headless
   viewport — the same thing the web dashboard's runtime lab does.
3. **The runner/render split already reaches tvOS.** `YaverStore` has
   `runnerClient()` / `renderClient()` / `machineSplitActive`
   (`YaverStore.swift:37–96`); DroidStreamView already asks the RENDER box
   for frames. Route editing + per-role test connection landed on web
   (`c8af35677`).
4. **The coding half already works.** `POST /runner/session/turn` is in the
   TV allowlist, so SessionView can drive a full vibe turn today. The loop
   is: prompt from the couch → runner codes on the runner box → render box
   re-renders → TV polls frames. Three of those four legs work; the fourth
   is a 403.
5. **Quiet-render policy is already the TV's native behavior.** Poll-latest-
   frame naturally implements "queue the intent, keep the last good surface,
   refresh on terminal state" — the no-surprise-re-render rule costs nothing
   here.

So webui-parity vibing on the TV is not a feature build; it is a
**permission diff plus a parity guard**.

## 5. The fix, in the four failure-plumbing layers

### A. Detection / capability — widen the companion allowlist (agent)

Add to the `tv`, `vision`, `spatial` branch of `companionSessionAllowed`:

```
GET  /droid/frame
GET  /capture/frame.jpg
POST /vibing/preview/start | stop | snapshot
GET  /vibing/preview/status | events | summaries | clips
GET  /vibing/preview/frames/*   (prefix)
GET  /vibing/preview/clip/*     (prefix, read)
POST /dev/start
POST /dev/web-preview/start
GET  /dev/events
POST /install/*                 (prefix — the route-to-fix lane)
GET  /install/stream/*          (or the actual stream path — verify at edit time)
POST /feedback
```

Deliberately still closed: `/exec`, `/vault/*`, `/settings/*`,
`/agent/shutdown`, task mutation, `/ws/terminal` (couch ≠ shell). `watch`
stays as-is — its narrowness is a choice, not drift. The widened rows are
view + preview-lifecycle + install-remedy only, so the blast radius of a
stolen TV token stays "can watch previews and start dev servers," not "can
run commands." Multi-tenant invariants untouched: same bearer, same gate on
every transport, relay still authorizes nothing.

### The parity guard (the real deliverable)

A Go test, `companion_scope_parity_test.go`, that owns a single literal
list: `tvClientEndpoints = [{method, path}, …]` — every agent endpoint
`tvos/YaverTV/AgentClient.swift` calls (source-of-truth comment pointing at
the Swift file; better: a small parser that greps the Swift source in-repo
the way `beaconParity.test.ts` reads both twins). The test asserts
`companionSessionAllowed(m, p, "tv")` for every row, and the same for the
spatial-SDK gate where the surface overlaps. **Prove it by breaking it:**
remove `/droid/frame` from the allowlist, watch the test fail, restore.
A guard nobody has seen fail is a guess.

### B. Signal — the 403 must be structured

Credit where due: the prose was good enough to diagnose from a *photograph
of a television*. That is the signal layer half-working. But it's still
prose. `companionScopeDeniedMessage` should ride with a reason code
(`reason_codes.go` — e.g. `scope_denied`) plus `{scope, method, path}` in
the JSON body, so clients classify instead of regexing, and so the next
scope gap is measurable in logs.

### C. UI — a scope 403 is not retryable

`DroidStreamView` renders `Try again` for every error. For `scope_denied`
the retry is unfalsifiable — it will 403 forever. On that code the TV
should render the named cause and the real route: *"This box's agent is
older than this TV app — update the agent"* → deep-link to the existing
`UpdateAgentView` (the route already exists on this surface; wire it, don't
describe it). Same classification in the RN views if any share the polling
pattern.

### D. Version-skew reality — the client-side leg is mandatory

The widening lands in the **agent**, so every TV pointed at a not-yet-updated
box still hits the wall. Layer C is therefore not polish; it is the only
thing a user can act on during the skew window. The pairing:
agent widens (A) + TV classifies `scope_denied` and routes to agent update
(C/D). Ship both; either alone leaves a cohort staring at `Try again`.

## 6. Remaining distance to full webui parity on TV (after the wall falls)

| Webui vibing capability | TV status after scope fix |
|---|---|
| Prompt → runner turn | ✅ already allowed + built (SessionView) |
| Watch RN app render (redroid) | ✅ DroidStreamView, unblocked |
| Watch web/RN-web render at form factor | ✅ WebPreviewStreamView + headless viewport, unblocked |
| Compile/status narration | ✅ `/dev/events` SSE, unblocked |
| Missing-toolchain Install button, streamed | ✅ `/install/*`, unblocked |
| Flutter preview | ❌ still "not streamable" (`ProjectsView.swift:110`) — but Flutter web-server + vibe capture is the same pixels path; candidate follow-up, mind the compile-fail-serves-blank trap |
| Voice lane from the couch | ➖ `/voice/stream` is allowed for spatial SDK, not tv session — decide deliberately, don't drift |
| Clips / summaries review | ✅ read endpoints in the widened list |

## 7. Browser rendering on Apple TV — delivery-lane analysis (iframe vs WebRTC)

The webui's primary vibing surface is a **direct iframe of the dev server**
(`RuntimeLabView.tsx:2755 "browser · direct iframe · dev server"`, iframes at
:2970/:2995). The first-order fact that shapes everything on Apple TV:

> **tvOS has no WebKit.** No WKWebView, no SFSafariViewController, nothing.
> The iframe lane is not "hard" on TV — it is structurally impossible. Every
> TV render is pixels produced elsewhere.

So the question is only *which pixel lane*. The agent already ships three,
plus one candidate:

| Lane | Producer | Transport | TV-scope today | fps / latency | tvOS client cost |
|---|---|---|---|---|---|
| **Snapshot poll** (current TV code) | vibe-preview PNG / `/droid/frame` PNG | HTTPS GET loop | ❌ 403 (§1) | ~2 fps, RTT-bound | zero — shipped |
| **MJPEG** | `/rd/stream`, `/capture/stream` | HTTP multipart | ❌ 403 | ~10 fps | AVPlayer can't play MJPEG (`docs/yaver-tvos-surface.md §1.6`); custom parser ≈ snapshot poll with extra steps |
| **WebRTC JPEG-DC** | headless-Chromium CDP screencast → JPEG frames on a DataChannel (`remote_runtime_streamer.go:83 jpegDataChannelStreamer`, transport `webrtc-datachannel-jpeg-v1`) | WebRTC DataChannel | ✅ **signaling `/remote-runtime/sessions*` is already TV-allowed** | ~10–15 fps, sub-second | libwebrtc + `UIImage(data:)` — no video decoder needed |
| **WebRTC H.264 track** | adb screenrecord (redroid) / ScreenCaptureKit (Apple sims) → Pion `TrackLocalStaticSample` (`remote_runtime_video_track.go`, 4 Mbps, ~24 fps) | RTP/DTLS-SRTP | ✅ same signaling | 24 fps, sub-500 ms | libwebrtc + VideoToolbox/`AVSampleBufferDisplayLayer` |
| **LL-HLS** (candidate, not built) | same NAL source → segmenter | HTTPS | would need scope row | 24 fps, 2–6 s latency | zero third-party dep — native AVPlayer |

Key observations:

1. **The WebRTC lane is the one lane the scope wall does NOT block.** The TV
   allowlist already carries GET/POST `/remote-runtime/sessions*` — the
   remote-runtime signaling seam. The 403 in the photo hits only the legacy
   poll endpoints. The most modern lane is also the already-permitted one.
2. **The browser (RN-browser) case is the cheap one, on both ends.** For
   `SurfaceBrowser` (`remote_runtime.go:278` — RN-Web/Flutter-Web in a
   headless Chrome tab via CDP screencast, "fastest + lightest… perfect for
   UI vibing", the default surface for expo/react-native/flutter/next/vite),
   the stream is **JPEG frames over a DataChannel**, not an RTP video track.
   A tvOS client therefore needs libwebrtc only for the
   PeerConnection/DataChannel plumbing — frame display is the same
   `UIImage(data:)` the snapshot poll already does. No H.264 pipeline, no
   sample-buffer layers, for the surface that matters most.
3. **The H.264 track lane covers redroid + Apple sims** — same PeerConnection,
   different payload; add `AVSampleBufferDisplayLayer` decode when extending
   beyond the browser surface.
4. **The loop is already proven end-to-end** — `e2e/remote-vibe-loop.mjs`
   closes runner-turn → render → PIXELS over the relay, and
   `webrtc-proof/webrtc-closed-loop-1719.webm` is a recording of it.
5. **ICE reality check (the honest risk):** signaling rides the relay, but
   WebRTC *media* is peer-to-peer. TV + render box on the same LAN → host
   candidates, trivial. Render box in the cloud → needs srflx/STUN to
   succeed from the living room; audit `doctor_webrtc_ice.go` coverage for
   the TV case before declaring the lane shipped. Fallback when ICE fails
   must be the (scope-unblocked) snapshot poll — never a spinner.

**Recommended sequencing:**

- **Phase 1 — drop the wall (§5).** Pure agent-side permission diff; the
  shipped TV app starts working at ~2 fps everywhere, including over the
  relay, with zero client changes. This is the incident fix.
- **Phase 2 — first-class TV lane = remote-runtime WebRTC, browser surface
  first.** Add libwebrtc (tvOS xcframework), implement
  session-create → offer/answer over the already-allowed signaling, render
  JPEG-DC frames. This gives the webui-grade experience: sub-second HMR of
  the REAL RN app as RN-Web at the chosen Phone/Tablet/Desktop viewport.
- **Phase 3 — H.264 track for redroid/sim surfaces; LL-HLS only if the
  no-third-party-dep constraint ever outweighs latency.**

## 8. Dual-usage slicing — runner box ≠ render box, from the couch

The runner/render split is the TV's natural mode: AI turns on a cheap always-
on Linux box, pixels from whatever box can render. tvOS already has the
spine — and an internal drift that will bite the moment a split is active.

**What exists (verified in `YaverStore.swift:25–103`):**

- Roles come from `userSettings.machineRolesByProject` — the SAME Convex rows
  web + mobile read. Correctly keyed off the config, not a per-surface copy.
- `machineSplitActive`, and a named badge ("AI: ubuntu · Render: mac mini") —
  a split with no badge is two silent sources, and the badge exists.
- `runnerBox()` / `renderBox()`: cross-machine addressing rides the relay
  `/d/<deviceId>` path ONLY, with `host` deliberately cleared so a stale LAN
  address can never hit the wrong machine — and a split with no relay wired
  returns nil so the caller must refuse *by name*. This is the right shape.

**The drift: role-routing inside tvOS is inconsistent per call, not per
feature.** Audit of every client acquisition in `tvos/YaverTV`:

| Call | Client used | Correct role | Verdict |
|---|---|---|---|
| DroidStreamView frame poll | `renderClient()` | render | ✅ |
| WebPreviewStreamView `dev/start` + preview start (:258) | `renderClient()` | render | ✅ |
| WebPreviewStreamView **install tool** (:184) | `store.client()` (selected) | render | ❌ installs Flutter on the wrong box |
| WebPreviewStreamView **stop** (:112) + **reload** (:412) | `store.client()` | render | ❌ stops/reloads nothing when selected ≠ render |
| SessionView agent calls (:367) | `store.client()` | runner | ❌ vibe turns land on whatever box is selected |
| TasksView (:134) | `runnerClient()` | runner | ✅ |
| RuntimeDashboardView (:350–:507) | `store.client()`, one `renderClient() ?? client()` (:530) | render for streams | ❌ mixed |
| ProjectsView list (:133) | `store.client()` | *decide:* runner owns the repo the AI edits | ⚠️ role ambiguity — resolve and encode |

Started-on-render, stopped-on-selected is the worst kind: it *works* in
single-box setups (selected == render == runner) and silently splits state
the day the user configures the split — a dev server left running on the
render box with no surface that will ever stop it.

**Rule to encode (and test):** every `AgentClient` acquisition in a
companion surface must go through a role-named accessor — `runnerClient()`
or `renderClient()` — and `store.client()` becomes the explicit
"selected-box UI" accessor (machine picker, Apple TV remote) only. A grep
test can hold this: no `store.client()` in views whose feature is
runner- or render-owned.

**Split-specific failure plumbing:**

- **The scope wall applies per box.** In a split, BOTH agents run the §1
  gate; the version-skew window (§5D) is squared. The TV must name *which*
  box denied.
- **Per-role probe parity.** Web just landed per-role "Test connection" in
  the Route editor (`c8af35677`) and a shared probe-failure policy
  (`web/lib/runtimeTargetProbeFailure.ts` — classifies
  `relay.device_not_connected` presence vs route failures, with runner-
  fallback flags). tvOS has no probe and would otherwise grow a fourth
  hand-copied relay-error regex (mobile already carries three). Port the
  *policy* keyed off the reason codes, not the regexes; tvOS renders the
  same named causes ("render box not on relay → Fix with runner box?").
- **Relay presence is now a first-class signal** (`relay/proxy_presence_test.go`)
  — the TV's split badge should reflect per-role presence, not just row
  existence: "Render: mac mini (offline)" beats a frozen last frame.
- **ICE across the split:** media flows TV↔render box only; the runner box
  is never in the media path. Probe the render leg, not the runner leg,
  before promising video.

## 9. Postmortem bullets (false greens, stated as such)

- **The Projects screen was a false green**: `/projects` allowed → healthy
  browse UI over a preview that could never start. Bounding rule: a
  surface's entry screen must not render capabilities its token cannot
  exercise — or the gate must admit what the surface ships.
- **`TestCompanionSessionAllowed` was a false green**: it verified the
  allowlist against itself, not against the client. Parity tests key off
  the code, not the copy.
- **Two scope gates for one surface family drifted** (spatial SDK got
  vibing; tv session didn't) — same class as the wake-ladder triplicate.
- **The route-to-fix was itself gated** (`/install/*` 403 on TV): when
  auditing a scope, audit the remedy lanes with the feature lanes.
- **Role routing that "works" on one box is a false green for the split**:
  start-on-render + stop-on-selected passes every single-box test and
  orphans dev servers the day `machineRolesByProject` splits (§8). The
  role-named-accessor rule plus a grep test is the guard.
- **The modern lane was never the blocked lane**: `/remote-runtime/sessions*`
  (WebRTC signaling) was TV-allowed all along; only the legacy poll paths
  403'd. Nobody noticed because the tvOS client never grew a WebRTC leg —
  a permitted capability with no consumer is as invisible as a forbidden one.
