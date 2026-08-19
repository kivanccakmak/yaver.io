# tvOS Vibing — runner/model chips click dead + prompt "card inside card" (deep audit, 2026-08-19)

Surface: `tvos/YaverTV/Views/VibeTurnPanel.swift` (large uncommitted WIP against HEAD)
+ its call sites `RemoteRuntimeWebRTCView.swift`, `WebPreviewStreamView.swift`,
`DroidStreamView.swift`. The file compiles into BOTH the tvOS and visionOS targets
(`visionos/project.yml:86`) — any change must keep visionOS compiling.

Status at audit time: **chip click was reported broken ("does nothing"), then fixed
by the owner on-device while this audit was being written.** Findings B and C are
still open. This document is written so an independent evaluator (e.g. Codex) can
verify each claim against the code.

---

## A. Runner/Model chip click → "does nothing" (root cause; owner says fixed)

### What the code did

In the WIP, the runner and model "chips" are `Button`s that flip a Bool and present
a `.sheet` attached to the panel's root `VStack`:

- model: `inlineModelWidget` → `Button { showModelPicker = true }` — `VibeTurnPanel.swift:436-461`
- runner: `Button { showRunnerPicker = true }` — `VibeTurnPanel.swift:400-416`
- sheets: `.sheet(isPresented: $showModelPicker)` — `VibeTurnPanel.swift:205`
  and `.sheet(isPresented: $showRunnerPicker)` — `VibeTurnPanel.swift:230`
- both live inside `contextChip` — `VibeTurnPanel.swift:393-425`

`contextChip` applies `.clipped()` on its `HStack`, and each chip uses
`.buttonStyle(.bordered)` + `@FocusState`-driven `.focused(...)` + `.onMoveCommand`.

### Mechanism (three stacked contributors)

1. **Nested presentation is the unusual one.** Every `.sheet` that demonstrably
   works in this app is attached to a SCREEN ROOT:
   - `TasksView.swift:72` (composer)
   - `TaskComposerView.swift:103` (task settings)
   - `TaskDetailView.swift:92` (task settings)
   - `DashboardView.swift:142` (update agent)
   - `RemoteRuntimeWebRTCView.swift:156` (keyboard)
   There is NO working counter-example of a `.sheet` attached to a deeply-nested
   subview in this app. VibeTurnPanel's sheets are attached to a subview inside
   `RemoteRuntimeWebRTCView`'s `GeometryReader` → `ZStack` → `HStack` → `VStack`
   → `.focusSection()` chain, while that same screen already owns a `.sheet`
   (keyboard) and the panel owns a `.fullScreenCover` (console,
   `VibeTurnPanel.swift:162`). tvOS presentation from a nested subview inside a
   host that already presents is the classic "silently dropped / wrong presenter"
   failure — the action fires, nothing appears.

2. **Hit-testing/clipping.** `contextChip` (`.clipped()` on an `HStack` of small
   chips) can swallow a chip's tap region unless the container exposes a content
   shape. The current tree adds `.contentShape(Rectangle())`,
   `.allowsHitTesting(true)` and `.zIndex(20)` on `contextChip`
   (`VibeTurnPanel.swift:423-426`) — this is believed to be the owner's fix.

3. **Empty-inventory auto-dismiss is STILL LIVE (see C1).** If
   `listRunners()` from the runner box fails or the agent is stale,
   `availableRunners` is empty → `selectedRunner == nil` → the model sheet's
   content is `Text("Select model")` + an empty `ForEach` (`.models ?? []`)
   with **zero focusable rows** (`VibeTurnPanel.swift:211`). An empty tvOS sheet
   cannot establish focus and dismisses itself instantly — the same "does
   nothing" symptom even when presentation itself succeeds.

### Evidence the author already knew the shape

The WIP comment at `VibeTurnPanel.swift:95-97`:

> An explicit focus chain is required on tvOS. A focused TextField keeps
> directional input for editing, so relying on geometric focus made the
> runner/model menus visible but unreachable from the Siri Remote.

The earlier `Menu`-based chips were "visible but unreachable" (geometric focus
lost to the focused TextField); the `@FocusState` chain fixed reachability, and
then the Menus were replaced with `Button` + `.sheet`, reintroducing a dead
control. The proven-working presentation mechanism on this exact surface is
`Menu`:
- control rail "Controls" Menu — `RemoteRuntimeWebRTCView.swift:361`
- the MCP chip in the SAME HStack — `VibeTurnPanel.swift:310`
- TaskComposer settings rows — `TaskComposerView.swift:295`

With the `@FocusState` chain present, `Menu` chips are reachable AND functional.

### What to verify when evaluating

- Reproduce: on tvOS, expand the vibe panel, focus the model chip, press Select;
  observe whether a sheet appears. Then with the runner box's `/runners` endpoint
  failing (or a stale agent), repeat.
- Confirm whether the owner's `.contentShape/.allowsHitTesting/.zIndex` change
  alone resolves the reachable case, and whether the sheets were left in place.

---

## B. Prompt "card inside card" looks ugly (STILL OPEN)

### Current rendering

In the expanded panel the prompt is styled as its own heavy dark card:

```swift
TextField("What should change?", text: $prompt)
    .textFieldStyle(.plain)
    .font(.system(size: 24, weight: .medium))
    .padding(.horizontal, 18)
    .frame(minHeight: 72)
    .background(Color(white: 0.13), in: RoundedRectangle(cornerRadius: 18))
```
— `VibeTurnPanel.swift:114-121`

It sits directly above:
- the `liveRunnerTurn` card (`Color.white.opacity(0.08)`, cornerRadius 12) — `VibeTurnPanel.swift:755-790`
- the conversation bubbles (`Color.blue.opacity(0.22)` / `white.opacity(0.08)`) — `VibeTurnPanel.swift:796-812`

On the browser/droid lanes the panel floats bare over the captured frame
(`WebPreviewStreamView.swift:187`, `DroidStreamView.swift:73`).

### Why it reads as "card inside card"

HEAD wrapped the WHOLE panel in one material card:

```swift
.padding(16)
.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18))
```
— `git show HEAD:tvos/YaverTV/Views/VibeTurnPanel.swift`

The WIP **removed** that outer card and **kept only the inner prompt box**, so
the prompt renders as a lone floating card above a stack of other cards. The app
already has a clean prompt treatment on the adjacent surface:
`SessionView.swift:291` — `.background(.gray.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))`.

### Recommended fix (not yet applied)

1. Drop the heavy `Color(white: 0.13)` prompt card.
2. Use the SessionView light-field treatment for the prompt.
3. Restore ONE subtle material card around the expanded panel (HEAD style) so it
   reads as a single surface, not nested cards.
4. Shrink `minHeight: 72` when there is no active conversation.

---

## C. Other findings (STILL OPEN)

### C1. Empty-inventory honesty

When `availableRunners.isEmpty` (failed `listRunners()` / stale agent / box with
no coding runner), the runner and model chips have nothing to offer and the model
sheet has zero focusable rows. Requirement: render a named state
("No coding runners on the box" + a Check-again / route) instead of a silent
no-op. Current code sets no error, no label, nothing —
`VibeTurnPanel.swift:277-305` (`loadPickerState` swallows the failure with
`try?`).

### C2. UI test identifier mismatch (test cannot pass as written)

`TVWebPreviewLoopTests.swift:213` asserts:

```swift
XCTAssertTrue(app.buttons["vibe.context"].hasFocus, ...)
```

but the WIP identifier on the container is `vibe.context.widgets` on an `HStack`
that is NOT itself a button (`VibeTurnPanel.swift:424`). Focus after `.down` from
the prompt lands on the runner chip (accessibilityLabel "Select runner"). The
test either needs to target `vibe.model-chip` / "Select runner", or the container
identifier must be corrected.

### C3. Dead duplicate implementations

`runnerChip` / `modelChip` (the older `Menu` versions) and `inlineRunnerWidget`
remain in the file beside the active `Button` widgets — `VibeTurnPanel.swift:427-573`.
Two implementations of the same control = the exact cross-surface drift the repo
forbids. Only one should ship.

### C4. Shared tvOS + visionOS target

`VibeTurnPanel.swift` is compiled into both targets (`visionos/project.yml:86`).
The `@FocusState` chain and `.onMoveCommand` handlers must survive any picker
mechanism change, and both targets must be `xcodebuild build`-verified.

---

## Recommendation summary

| Item | Status | Action |
|---|---|---|
| A. Chip click dead | Fixed by owner on-device | Verify the mechanism + leave a regression note |
| A3. Empty inventory → auto-dismiss | OPEN | Named empty state in the pickers |
| B. Prompt "card inside card" | OPEN | Light field + one outer panel card (SessionView pattern) |
| C2. UI-test identifier mismatch | OPEN | Point test at the real focus target / fix identifier |
| C3. Dead duplicate chips | OPEN | Ship one implementation |
| C4. visionOS shared-file | Constraint | Build both targets on every change |
