# Making tvOS / visionOS / watch / car vibeable — and closed-loop tested

**Date:** 2026-08-03
**Status:** plan + phase 1 landed
**Scope:** every surface that is NOT web or phone. What is missing, in what
order to build it, and how each step is proven by a test that would fail
without it.

---

## 0. The one-line finding

Every native surface is one small capability away from being vibeable, and it is
the **same** capability on all of them: **no native client can CREATE a task.**

`tvos/YaverTV/AgentClient.swift` exposes `listTasks()` and **zero POST verbs**.
watch and Wear are the same shape. So the surfaces can *watch* work happen and
cannot *start* it — which is why every one of them reads as "untested" when the
truth is "unable".

Everything else people assume is blocking turns out not to be:

| Assumed blocker | Reality |
|---|---|
| "No browser on tvOS, so no pixels" | tvOS already ships `Views/DroidStreamView.swift` — polls `/droid/frame`, renders PNG at ~2 fps. Pixels come from the BOX, not a local browser. |
| "Can't automate a TV" | `xcrun simctl boot` + XCUITest + `simctl io <udid> screenshot` is a complete driver. Playwright can't reach it; that means a second harness, not an impossible one. |
| "Needs `/tasks/{id}/continue`" | No. The web/mobile arcs revert with a **separate new task**. Follow-up is a *nice-to-have*, task creation is the blocker. |
| "visionOS needs its own everything" | visionOS is 1 own file + **12 shared** `../tvos/YaverTV/*.swift`. Fix the shared client once, both surfaces gain it. |

**Genuine platform limits (only these):** `WKWebView` does not exist on tvOS
(irrelevant — see stream above). watchOS and Wear have no practical preview
surface at all, so they need a **non-pixel verdict**.

---

## 1. Phases

### Phase 1 — `createTask` on the shared native client ✅ LANDED
One `func createTask(...)` on `AgentClient`, POSTing the same body the web
funnel builds. visionOS inherits it through the shared-source list.

**Proof:** `web/lib/nativeVibeReach.test.mts` asserts a POST-capable task verb
exists on the shared client and that visionOS's `project.yml` still shares it —
delete either and the guard fails.

### Phase 2 — headless probes, per surface, BEFORE any UI test
Per CLAUDE.md's *headless first, then closed loop*. Each is a plain HTTP
exchange against the agent, no simulator:

| Probe | Asserts |
|---|---|
| `tv-headless` | device-code auth → `createTask` → task reaches a terminal state |
| `vision-headless` | same, through the shared client's endpoints |
| `watch-headless` | task list + a non-pixel terminal verdict (`completed`) |
| `car-headless` | voice intent → task dispatch, no render expectation |

They run on **both** iOS-family and Android-family boxes (Wear OS uses the same
agent API), so the matrix is `surface × platform`, not `surface`.

### Phase 3 — closed loop, per surface, sequential
Only after its headless probe is green:

- **visionOS** — the full pixel loop, identical to web: `WKWebView` preview,
  black → red → black, `classifyVibeColor` on a screenshot.
- **tvOS** — same arc, but the frame comes from `/droid/frame` (or the
  `native-webrtc` track) instead of an iframe. Same classifier, same verdict.
- **watch / Wear / car** — **non-pixel verdict** by design: the task reaches
  `completed` and the surface renders that outcome. Waiting for a preview these
  surfaces will never have is how they stay untested forever.

Driver: XCUITest + `simctl` for Apple, `adb` + espresso/uiautomator for Wear.

### Phase 4 — failure plumbing parity
Every failure code the phone renders must render here too, keyed off the CODE,
not prose (`reason_codes.go`). Tonight's additions are the immediate backlog:
`runner.quota.exhausted` (with its reset time) and
`runner.provider.balance_or_plan_scope` (z.ai 1113). A native surface that shows
"something went wrong" for a quota wall is the same defect the phone just had.

---

## 2. Snowball rules this plan inherits

- **Headless grows a VERB.** If a probe needs ssh plus a shell one-liner, that
  is a missing endpoint (`runner_model_probe` was born exactly this way tonight).
- **The loop grows an ARC.** Every confirmed defect earns an assertion on the
  surface where it broke.
- **Never delete an assertion to go green** — fix the harness, keep the check.
- **Prove every guard by breaking it.**
- **Non-pixel is a legitimate verdict** for surfaces with no preview; a fake
  pixel check on a watch would be a false green wearing a costume.

---

## 3. Known traps for whoever builds phase 3

1. `tvos/` and `watch/` `.xcodeproj` are **gitignored and XcodeGen-generated** —
   run `xcodegen generate` first or you compile a stale file list.
2. Never pass `-sdk` with a scheme that embeds the watch; it overrides
   `SDKROOT=watchos` and collides on `Yaver.app`. Use `-destination`.
3. Duplicate filenames across shared sources break the Swift module outright —
   visionOS's archive failed on two `FailureSignals.swift` (2026-08-03).
4. Simulators left booted cost real CPU; this Mac hit load 270 with five of them
   plus a build. Shut them down in teardown.
