# visionOS — shared tvOS file WIP: broken build, scope-wall regression, and drift (deep audit, 2026-08-19)

Surface: `visionos/` (YaverVision, xrOS) plus the tvOS files it shares
verbatim. The audit targets the current working tree: HEAD `a7eccabe7`
("align tv surfaces with runner model controls") **plus** uncommitted WIP in
`visionos/project.yml`, `visionos/YaverVision/Views/VisionDashboardView.swift`,
`visionos/YaverVision/Speech.swift`, and the shared
`tvos/YaverTV/{AgentClient,SessionClient,MachineRegistry,Models}.swift`.

Every claim below was **MEASURED on this Mac on 2026-08-19**, not inferred —
the method is shown so an independent evaluator can re-run it. Two findings are
live breakages (A, B); four are drift/gap (C–F).

Status at audit time:

| # | Finding | Severity |
|---|---|---|
| A | visionOS target does not compile (`.onMoveCommand` + missing helpers) | **FIXED** |
| B | `POST /machine/remove` + `POST /projects/refresh` 403 on companion scopes; parity test red at HEAD | **FIXED** |
| C | Shared `previewCapabilities` hardcodes `surface=tv` | **FIXED** |
| D | Two session-driving UIs compile into the headset (`VisionSessionView` + shared `SessionView`) | **FIXED** |
| E | `includeYaverMcp` default flipped `true→false` in shared `SessionClient` | **FIXED / documented** |
| F | Closed loop never exercises the shared Projects/Session/Vibe views on a headset | **PARTIAL** |

## Resolution recorded 2026-08-19

Findings A–E are fixed in the current working tree. The visionOS simulator app
build succeeds with `xcodebuild` after the shared remote-command modifiers were
guarded and the pure helper policy was added to the target. Companion removal
and project-rescan mutations were removed from the shared client path and are
explicitly denied by the parity contract; account removal remains Convex-only.
The headset now reports `surface=vision`, uses the native dictation-capable
session, and starts with MCP authority disabled unless explicitly selected.

Finding F is narrowed rather than overstated: the loop now asserts the shared
VibeTurnPanel is visible and enables its runner-session assertion. The project
list reaches the native vision session route, while the Siri Remote SessionView
is no longer compiled into visionOS. Full interactive headset driving remains a
follow-up for the simulator harness, not a claim of completion.

---

## How each claim was verified

```bash
# A — availability probe (compiles? attempt the operation):
cat > /tmp/moveprobe.swift <<'EOF'
import SwiftUI
struct P: View {
    var body: some View {
        VStack { Button("x") {} .onMoveCommand { dir in _ = dir } }
    }
}
EOF
xcrun swiftc -typecheck -sdk "$(xcrun --sdk xros --show-sdk-path)" \
  -target arm64-apple-xros2.0 /tmp/moveprobe.swift
# → error: 'onMoveCommand(perform:)' is unavailable in visionOS

# A — full target build:
cd visionos && xcodegen generate
xcodebuild -project YaverVision.xcodeproj -scheme YaverVision \
  -configuration Debug -sdk xros -destination "generic/platform=visionOS" \
  -derivedDataPath /tmp/YaverVisionAudit build
# → BUILD FAILED, 11 errors (all in tvos/YaverTV/Views/VibeTurnPanel.swift)

# A — UI test target, same result:
xcodebuild -project YaverVision.xcodeproj -scheme YaverVision \
  -configuration Debug -sdk xrsimulator \
  -destination "platform=visionOS Simulator,name=Apple Vision Pro" \
  -derivedDataPath /tmp/YaverVisionAuditTest build-for-testing
# → BUILD FAILED, same 11 errors

# B — scope parity guard:
cd desktop/agent && go test -run 'TestCompanionScope' .
# → FAIL: "tvOS AgentClient.swift calls "/projects/refresh" but the tv scope
#    forbids it for both GET and POST"; same for "/machine/remove"
```

---

## A. BLOCKER — the visionOS target does not compile

### What breaks

`visionos/project.yml:86` compiles `tvos/YaverTV/Views/VibeTurnPanel.swift`
into the visionOS app. On xrOS that file fails in two independent ways
(reported error lines from the 2026-08-19 build):

```
VibeTurnPanel.swift:123:26  'onMoveCommand(perform:)' is unavailable in visionOS
VibeTurnPanel.swift:359:10  'onMoveCommand(perform:)' is unavailable in visionOS
VibeTurnPanel.swift:524:10  'onMoveCommand(perform:)' is unavailable in visionOS
VibeTurnPanel.swift:555:10  'onMoveCommand(perform:)' is unavailable in visionOS
VibeTurnPanel.swift:589:14  'onMoveCommand(perform:)' is unavailable in visionOS
VibeTurnPanel.swift:616:18  'onMoveCommand(perform:)' is unavailable in visionOS
VibeTurnPanel.swift:683:14  'onMoveCommand(perform:)' is unavailable in visionOS
VibeTurnPanel.swift:707:51  cannot find 'tvTaskIsRunnerCoding' in scope
VibeTurnPanel.swift:746:55  cannot find 'tvTaskIsRunnerCoding' in scope
VibeTurnPanel.swift:912:28  cannot find 'tvChatFollowUpAction' in scope
VibeTurnPanel.swift:1054:27 cannot find 'tvTaskIsRunnerCoding' in scope
```

1. **`.onMoveCommand` is unavailable on visionOS.** 10 call sites in the file
   (123, 359, 524, 555, 589, 616, 683, 717, 734, 771); the compiler reports
   the unavailability on 7 before it stops. Proved by the SDK itself:
   `SwiftUI.View.onMoveCommand` is annotated
   `@available(visionOS, unavailable)` in the XROS 26.5 SDK, and the
   typecheck probe above fails identically.
2. **The helpers it calls are not in the visionOS target.** `tvTaskIsRunnerCoding`
   is defined at `tvos/YaverTV/Views/TaskDetailView.swift:16` and
   `tvChatFollowUpAction` at `tvos/YaverTV/TVChatPlan.swift:15`. Neither file
   is in `visionos/project.yml`'s source list — only tvOS's target includes
   them (`tvos/project.yml` pulls the whole `YaverTV/` directory).

### Why the two surfaces drift

tvOS includes the entire `YaverTV/` directory (`tvos/project.yml:25`
`- path: YaverTV`); visionOS lists files **individually** in `visionos/project.yml`
with a comment that is literally "the compiler named them — not guessed"
(`project.yml:72`). So:

- every tvOS-only API use must be wrapped in `#if os(tvOS)` **or** the helper
  must be compiled into both targets, and
- a new symbol the tvOS target gets for free (new file under `YaverTV/`) is a
  silent visionOS compile break the moment a shared file references it.

The other shared files already follow the guard rule and compile clean:
`WebPreviewStreamView.swift:218` and `:365` (`#if os(tvOS)` around
`onMoveCommand`/`MoveCommandDirection`), `ProjectsView.swift:152`,
`TaskComposerView.swift:106`, `UpdateAgentView.swift:81`, `VibingView.swift:127`
(all `#if os(tvOS)` around the tvOS-only `.card` button style). **`VibeTurnPanel`
is the only shared file that uses tvOS-only API unguarded.**

### This was already called, and not done

`docs/audits/tvos-vibing-runner-model-chips-2026-08-19.md` finding **C4**:
> `VibeTurnPanel.swift` is compiled into both targets
> (`visionos/project.yml:86`). The `@FocusState` chain and `.onMoveCommand`
> handlers must survive any picker mechanism change, and **both targets must be
> `xcodebuild build`-verified.**

The tvOS-side fix landed; the visionOS half of the verification was not
performed. The build has been red on xrOS since the shared view set grew.

### Blast radius (all confirmed red today)

- `scripts/deploy-visionos.sh:148` runs `xcodebuild … -sdk xros … build` → fails.
- `e2e/visionos-sim-loop.mjs:153` builds the app for the simulator and treats a
  build failure as a NAMED failure → the whole closed loop is stuck at step 1.
- `visionos/YaverVisionUITests` (`build-for-testing`) → fails, same errors.

### Fix (recommended)

1. Wrap every `.onMoveCommand` (and any future `MoveCommandDirection`) use in
   `VibeTurnPanel` with `#if os(tvOS)` … `#endif`, exactly as
   `WebPreviewStreamView` already does (`WebPreviewStreamView.swift:218-234`,
   `:365-400`). Note in the guard comment: the headset has no D-pad; focus
   navigation is gaze+pinch and does not need the remote command chain.
2. Decide the two helpers deliberately, not by accident of the tvOS directory
   include:
   - `tvTaskIsRunnerCoding` (`TaskDetailView.swift:16`) and
     `tvChatFollowUpAction` (`TVChatPlan.swift:15`) are pure functions used by
     `VibeTurnPanel`. Either add `TaskDetailView.swift` + `TVChatPlan.swift`
     to `visionos/project.yml`, or (preferred) move both into an already-shared
     file (`VibingPlan.swift` / `TVChatPlan.swift` are both already tvOS-side)
     and add that one file to the vision target.
3. **Guard it.** Re-run the two `xcodebuild` commands above for both targets
   (tvOS + visionOS). This is the "prove the guard works by breaking it" step:
   delete the `#if os(tvOS)` on one call site, watch the visionOS build fail,
   restore.

---

## B. BLOCKER — scope wall on the new shared endpoints; parity guard is red at HEAD

### The regression

Commit `a7eccabe7` added two calls to the **shared** client
(`tvos/YaverTV/AgentClient.swift`, compiled into visionOS):

- `removeMachine()` → `POST /machine/remove` — `AgentClient.swift:52-54`
- project refresh → `POST /projects/refresh` — `AgentClient.swift:679`

The companion scope gate `companionSessionAllowed` (`desktop/agent/httpserver.go:1876`,
`tv|vision|spatial` branch at `:1896`) admits neither. A vision-scoped (or
tv-scoped) token therefore receives the 2026-07-27 wall verbatim
(`httpserver.go:1980`):
> `vision-scoped token cannot access this endpoint`

### The guard already caught it — and is already red

`desktop/agent/companion_scope_parity_test.go:155`
`TestCompanionScopeParityWithSwiftSource` scans `AgentClient.swift` for literal
paths and asserts each is admitted by the scope. Verified 2026-08-19:

```
FAIL: tvOS AgentClient.swift calls "/projects/refresh" but the tv scope forbids it for both GET and POST
FAIL: tvOS AgentClient.swift calls "/machine/remove" but the tv scope forbids it for both GET and POST
```

Both literals are present at HEAD (`git show HEAD:tvos/YaverTV/AgentClient.swift`
grep), so this is a **committed** regression, not just WIP. The guard that
exists to make this impossible is red and the change shipped anyway.

### What the user sees

- The new "Remove from Yaver" button on the headset
  (`visionos/YaverVision/Views/VisionDashboardView.swift:156-162`, new in the
  WIP) calls `removeSelectedMachine()` → `client.removeMachine()` →
  `POST /machine/remove` → 403.
- ProjectsView's refresh affordance
  (`tvos/YaverTV/Views/ProjectsView.swift:110` → `listProjects` →
  `POST /projects/refresh`) 403s on a vision/tv token.

Exactly the shape the 2026-07-27 incident taught:
`docs/audits/tv-vibing-scope-wall-deep-analysis-2026-07.md` — "a surface's
entry screen must not render capabilities its token cannot exercise."

### Fix (recommended)

Two honest options; pick one per endpoint and do not do both:

1. **Widen the allowlist** (`httpserver.go:1896` branch): add
   `POST /machine/remove` and `POST /projects/refresh` **only if** a stolen
   companion token destroying the box's machine row is an accepted blast
   radius. For `/machine/remove` that is a destructive-op verdict the
   repo's own deny-list culture (`companion_scope_parity_test.go:88`
   `companionDeniedEndpoints`) argues **against** — a vision-scoped token
   watching a preview should not be able to unregister the box.
2. **Drop the agent call from the companion path.** The visionOS/tvOS removal
   flow already registers via Convex (`MachineRegistry.removeDevice`, WIP
   `MachineRegistry.swift:273`); the `client.removeMachine()` agent call can
   be gated to non-companion surfaces, and ProjectsView refresh can degrade to
   the plain `GET /projects` list it already falls back to.

Whichever is chosen: the parity test must go green, and
`TestCompanionScopeStaysClosedWhereItMust` must gain `/machine/remove` in the
deny list if option 1 is rejected — so the destructive endpoint stays closed
for every companion scope forever.

---

## C. Drift — shared `previewCapabilities` hardcodes `surface=tv`

`tvos/YaverTV/AgentClient.swift:713`:

```swift
URLQueryItem(name: "surface", value: "tv"),
```

This method is shared into the visionOS target, so the headset asks the agent
to filter preview options as a **TV**. Today that is harmless — the agent's
surface filter (`desktop/agent/preview_surface_filter.go:68`, `surfaceCannotHost`)
drops the same set (`hermes`, `open-native`, `wire-push`) for `PreviewSurfaceTV`
and `PreviewSurfaceVision`. But it is a wrong label with no consumer, and the
whole point of that file ("a surface may only ever REMOVE options" +
`ParsePreviewSurface` handling a distinct `vision` value) is that the caller
names itself honestly. The next time the two rows diverge, the headset silently
inherits the TV's filter.

**Fix:** send `Backend.surface` (which the shared file already knows —
`AgentClient.swift:146` uses it for `X-Yaver-Surface`) instead of the literal
`"tv"`.

---

## D. Drift — two session-driving UIs compile into the headset

The WIP adds `SessionView.swift`, `TaskComposerView.swift`, `BoxLifecycle.swift`
and `WakeProgressView.swift` to the visionOS target (`visionos/project.yml:83-85`).
The headset now contains **two** prompt-to-runner surfaces that do not agree:

| | Dashboard "Open Session" | ProjectsView → "Open in Session" |
|---|---|---|
| View | `VisionSessionView` (native) | shared `SessionView` (tvOS) |
| Entry | `VisionDashboardView.swift:78` `.sheet` | `ProjectsView.swift:179` `NavigationLink` |
| STT | On-device dictation button (`DictationSession`) | none (tvOS copy: "press mic on Siri Remote", `SessionView.swift:287`) |
| Turn surface id | `surfaceId: "vision"` (`VisionSessionView.swift:261`) | default `"tvos"` (`SessionClient.swift:145`) |
| Choice rendering | focusable buttons | focusable buttons (same) |

Same feature, two implementations, two surface labels — the exact
"key off the code, not the copy" class the repo's cross-surface rules forbid.
The tvOS copy ("press mic on Siri Remote") is also physically wrong on a
headset, which has no Siri Remote.

**Fix (decision required):** keep ONE. Either route the dashboard "Open
Session" into the shared `SessionView` (and give it a headset dictation
path), or keep `VisionSessionView` and stop compiling the shared
`SessionView`/`TaskComposerView` into the vision target. Whichever survives,
its `surfaceId` must be `"vision"` on this surface.

---

## E. Drift — `includeYaverMcp` default flipped in the shared client

`tvos/YaverTV/SessionClient.swift:145` (WIP): `sendText` default changed
`includeYaverMcp: Bool = true` → `false`. The file is shared, so this silently
changes every tvOS **and** visionOS turn that does not pass the flag
(`SessionView.swift:417`, `VisionSessionView.swift:261`).

The direction matches the declared product rule — `VibeTurnPanel.swift:20-22`:
"task authority starts at No project / No MCP" — so it is likely intentional,
but it is an unrecorded behavior change with no test. The repo's rule is that
a behavior flip lands with its reason at the call sites that depend on it.

**Fix:** state the intent in the file header (or a comment at the default) and
confirm both surfaces' turn paths still behave (a continue/fork from the
picker passes `includeYaverMcp` explicitly — `VibeTurnPanel.swift:939` — so the
flip only affects the Session views).

---

## F. Gap — the closed loop never exercises the shared views on a headset

- `e2e/visionos-sim-loop.mjs` builds the app first (`:153`) and would have
  caught finding A immediately — it is the missing verification the C4 note
  demanded, and it is red today.
- But the loop asserts only that the **preview** renders (`preview:<project>`,
  `:292`) and a colour turn lands. It never drives `ProjectsView`,
  `SessionView`, `TaskComposerView`, or `VibeTurnPanel` on the headset, and it
  keeps the runner-session assertion disabled (`if (false)` at `:345`).
- `visionos/YaverVisionUITests/VisionDashboardUITests.swift` covers the native
  dashboard + native session sheet only — none of the newly-shared views.

So findings D's duplicated session driver and E's MCP flip would ship
invisible to every existing loop.

**Fix (when the build is green):** extend `visionos-sim-loop.mjs` (or a
UITest) to open ProjectsView → Session on the headset and assert a real turn's
reply reaches a pixel, mirroring the tvOS session coverage. That assertion is
the closed-loop leg of findings A, D and E.

---

## Recommendation summary

| Item | Status | Fix | Verify |
|---|---|---|---|
| A. visionOS build red | **OPEN / BLOCKER** | `#if os(tvOS)` around `VibeTurnPanel` `.onMoveCommand`; share `tvTaskIsRunnerCoding`/`tvChatFollowUpAction` (move to shared file + add to `project.yml`) | `xcodebuild` both targets; delete one guard, watch visionOS fail, restore |
| B. scope wall on `/machine/remove` + `/projects/refresh` | **OPEN / BLOCKER** | Widen allowlist **or** drop the agent call from companion path; add `/machine/remove` to the deny-list test if not widened | `go test -run TestCompanionScope` green |
| C. `surface=tv` hardcode | OPEN | `URLQueryItem(name: "surface", value: Backend.surface)` | typecheck both targets |
| D. two session drivers | OPEN | Pick one per surface; vision label must be `"vision"` | headset run |
| E. `includeYaverMcp` flip | OPEN | Record intent + confirm both call paths | tvOS + visionOS turn |
| F. loop coverage gap | OPEN | Drive shared Session/Vibe views on the headset in `visionos-sim-loop.mjs` | loop PIXELS |
