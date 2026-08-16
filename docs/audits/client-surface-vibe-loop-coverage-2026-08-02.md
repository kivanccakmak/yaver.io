# Which client surfaces can be closed-loop tested — and which cannot

**Date:** 2026-08-02
**Context:** the colour vibe loop (black → red → black, pixel verdict) runs on **web**
and **mobile (RN-web at phone viewport)** against `ubuntu-4gb-hel1-1`, which is both
the render target and the runner (codex). This audit covers the surfaces we
deliberately do **not** test — TV, car, AR/VR glass, watch, Wear OS — and says, per
surface, whether a closed loop is even *possible* today.

The point is to distinguish three very different things that all look like "untested":

- **CAN'T DRIVE** — the surface cannot start or continue a coding turn at all.
- **CAN DRIVE, CAN'T VERIFY** — it can vibe, but renders no pixels to read back, so
  the loop has no terminal signal.
- **COULD BE TESTED, ISN'T** — both halves exist; only harness work is missing.

---

## The matrix

| Surface | Code | Create a task? | **Continue** (follow-up)? | Preview to read pixels from? | Verdict |
|---|---|---|---|---|---|
| **Web** | `web/` | yes | yes | yes (iframe) | **TESTED** — pixel loop |
| **Mobile / tablet** | `mobile/` RN | yes | yes | yes | **TESTED** — RN-web, phone viewport |
| **Car** | `mobile/app/car-voice-coding.tsx` (RN) | voice → task | **no** | **none** (0 preview refs) | CAN'T VERIFY |
| **Glass / AR-VR** | `mobile/app/glass-*.tsx` (RN) | yes | **no** | **yes** — `WebView` preview pane | COULD BE TESTED |
| **tvOS** | `tvos/YaverTV/*.swift` | reads `/tasks` (10 files) | **no** | partial | CAN'T DRIVE the loop |
| **watchOS** | `watch/YaverWatch/*.swift` | reads `/tasks` (7 files) | **no** | no | CAN'T DRIVE |
| **Wear OS** | `wear/.../*.kt` | reads `/tasks` (5 files) | **no** | no | CAN'T DRIVE |

**Measured, not assumed:** grepping every native surface for a `/tasks/{id}/continue`
caller returns **zero** on tvOS, watchOS and Wear OS. Car and glass are React-Native
screens that share `mobile/src`, and the only `continueTask` caller in the whole mobile
tree is `app/(tabs)/tasks.tsx`.

---

## What this means for the credential work

Two consequences, and they cut in opposite directions:

1. **The parked-turn path is unreachable from TV, watch, Wear, car and glass** — not
   because it was skipped, but because none of them can send a follow-up. There is
   nothing to plumb there. That is why the parked-turn change touched exactly three
   surfaces (mobile, web, CLI) and claiming "all surfaces" would have been false
   coverage.
2. **The keep-alive DOES reach all of them.** It lives at `startProcess`, the single
   seam every dispatch crosses, so a task started by voice from a car or a glance from
   a watch gets the same credential renewal as one typed on the phone. That is the
   argument for putting it there rather than at the `continueTask` call site.

---

## The honest gap: glass could be tested and isn't

Glass is the one surface in the "not tested" list that has **both halves**: it drives
tasks, and `glass-workspace.tsx` renders a live preview through a `WebView`
(`react-native-webview`, pane `webPreviewPane`). Since glass is RN, it serves as RN-web
under the same Chromium lane the mobile arc already uses — so the colour loop would
work there with a viewport/route change and no new transport.

It is left out today because the value is low relative to cost: glass shares
`mobile/src`'s transport ladder, auth storage and render path with the mobile arc, so a
green glass run would mostly re-prove what the mobile arc already proves. Worth adding
only if glass grows a render path of its own.

**Car is different and worth stating plainly:** it has *no* preview at all (zero
matches for `WebView|iframe|Preview` in `car-voice-coding.tsx`). A colour loop there is
not "untested", it is **impossible** — there is nothing to read back. Any future car
verification has to assert on the task/turn outcome, never on pixels.

---

## Why we do not fake the missing surfaces

A shrunk desktop viewport called "mobile" is the exact false equivalence this suite
already caught in its own first draft — the dashboard and the RN app share neither
transport ladder, auth storage key (`yaver_auth_token` vs
`yaver.secure.yaver_auth_token`), nor render path, so a green there says nothing about
the app the user holds. The same reasoning forbids simulating a TV by pointing the web
dashboard at a large viewport, or "testing" the watch by calling the HTTP API directly:
what would be proven is the API, which the agent's own tests already cover.

**A surface is genuinely covered only when the client code the user runs is the client
code under test.** For the five surfaces above, that client either cannot drive a turn
or cannot show a result — so the honest status is the matrix, not a green tick.

---

## Recommended next steps, in order

1. **Nothing for TV / watch / Wear** until they gain a follow-up path. If they do, the
   parked-turn contract (`reason_codes.go` + the `parked`/`code` fields) is the thing to
   port, and it must key off the code, not prose.
2. **Car** — if verification is wanted, define a non-pixel verdict (task reached
   `completed`, spoken confirmation emitted). Do not wait for a preview that is not in
   the product's design.
3. **Glass** — cheapest real addition: reuse the mobile arc with the glass route and a
   glass viewport profile. Only worth it once glass diverges from mobile.

---

## Addendum (2026-08-03): tvOS and visionOS, measured

Asked directly: can the black → red → black colour loop run on tvOS or visionOS?

**Today: no. But that is NOT-IMPLEMENTED, not impossible — and the distinction
matters, because "impossible" is how a surface stays untested forever.** Exactly
one item below is a genuine platform limit; everything else is missing product
code we could write.

- **The driver is not the problem.** Both simulators exist and are scriptable
  right now: `xcrun simctl boot`, XCUITest for interaction, and
  `xcrun simctl io <udid> screenshot` for PIXELS — the same verdict the web and
  mobile arcs use. (This Mac had `YaverTV-AppStore-1080p` and
  `Apple Vision Pro` simulators booted earlier today.) Playwright cannot reach
  them, but that only means a second harness, not an impossible one.
- **The product is the problem**, in two places, and both are ours to fix.
- **`WKWebView` does not exist on tvOS** — Apple ships no WebKit UI control
  there. **visionOS has full WKWebView.**
- **…but tvOS does not need one, and this correction matters.** A first pass of
  this addendum called tvOS's missing WebView a blocker. It is not: pixels can
  come from the BOX as a stream, and **tvOS already ships a viewer** —
  `tvos/YaverTV/Views/DroidStreamView.swift` polls `GET /droid/frame` and
  renders the returned PNG (AVPlayer cannot play the agent's MJPEG, so it polls
  frames at ~2 fps). The agent side already exists too
  (`remote_runtime*.go`, the `native-webrtc` reach). So the terminal signal for
  a tvOS colour loop is a streamed FRAME from ubuntu-4gb, sampled with the same
  `classifyVibeColor` the browser arcs use — no browser required on the TV at
  all. Reading a colour out of a 2 fps PNG poll is strictly easier than reading
  it out of an iframe.

Evidence for the two missing capabilities:

| Check | tvOS | visionOS |
|---|---|---|
| A verb that CREATES a task | **none** — `AgentClient.swift` exposes `listTasks()` and **zero POST verbs** | **none** — inherits the same client |
| A surface that renders pixels to read back | **YES** — `Views/DroidStreamView.swift` polls `/droid/frame` and renders PNG | not yet, but `WKWebView` is available AND the same stream view can be shared |
| Own client code | full client layer | **1 file** (`YaverVisionApp.swift`) + **12 shared** `../tvos/YaverTV/*.swift` |

So there is exactly **ONE** missing capability, not two: the loop's step one —
send "change the login background to red" — has no caller on either surface.
The terminal signal is already solved on tvOS and solvable two ways on visionOS.

That single gap is a small, well-scoped change: one `func createTask` on the
shared `AgentClient`, which both surfaces inherit.

**The revert leg is NOT the blocker.** Worth stating because it is the
intuitive guess: the web/mobile arcs revert with a **separate new task**, not a
follow-up, so the missing `/tasks/{id}/continue` caller on native surfaces does
not by itself prevent the colour loop. Task CREATION does.

### What it would take, in order

1. **`createTask` on the tvOS `AgentClient`** — visionOS gets it free through the
   12 shared sources, which is the same reason the shared layer exists.
2. **A render surface.** tvOS has no browser and `WKWebView` on tvOS is not a
   supported control, so tvOS realistically needs a different verdict (task
   reached `completed`, or a streamed frame) rather than pixels. visionOS DOES
   have a full browser engine available, so a `WKWebView` preview there could
   read pixels exactly like the mobile arc.
3. **A driver.** Playwright cannot reach either. These are XCUITest targets on
   the tvOS/visionOS simulators — a different harness from `e2e/`, which is why
   this is a project, not a spec file.

**Recommendation:** visionOS is the one worth doing — it can host a real preview
and shares its client with tvOS, so `createTask` + a WebView pane buys a genuine
pixel loop on a headset. tvOS should get a non-pixel verdict instead; waiting
for a preview it cannot render is how a surface stays "untested" forever.

Related build note found while deploying this: `visionos/YaverVision/` carried a
stale 87-line copy of `FailureSignals.swift` while `project.yml` ALSO shares the
666-line tvOS original. Two `enum FailureSignals` in one module — the visionOS
archive failed outright (`filename "FailureSignals.swift" used twice`). The
copy was exactly the drift the project's own comment forbids, and was removed.
