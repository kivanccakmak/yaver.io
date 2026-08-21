# iPad Vibe Studio handoff

## Goal

Make Yaver’s iPad experience work in horizontal orientation like a compact desktop web UI:

- left side: a persistent mobile-app/device frame, even while the project is still starting or the preview has not rendered;
- right side: Vibing chat plus live runner/console logs;
- the project list should use the wider tablet canvas efficiently;
- “Open in Yaver” should enter this split experience, not open the old full-screen preview modal over the Projects screen;
- phone/portrait behavior and real iPhone, iPad, tvOS, watchOS, Wear OS, Android, car, and AR/VR flows must not be broken.

The user explicitly does not want “horizontal” to mean a huge full-width button. Controls should remain compact and proportional.

## Current user-visible failure

Opening:

`http://localhost:8081/vibe-studio?project=sfmg`

currently breaks/crashes or does not render correctly in Chrome. The URL responds from Expo with HTTP 200, but the RN-web route has a runtime/rendering problem that still needs diagnosis. Do not assume HTTP 200 means the screen rendered.

The user also reported that the old “Open in Yaver” behavior showed an unwanted mixed Projects/Devices/preview/logs screen. The intended behavior is the split Vibe Studio described above.

## Resolution (2026-08-21)

The route was rendered in a real browser for the first time — `e2e/tests/tablet-vibe-studio.spec.ts` had **never been run** before this session (last E2E run predated the route commit). Findings:

- **The route does not crash.** Both the landscape split and the portrait peek render correctly on RN-web. The “HTTP 200 but doesn’t render” report was never reproduced; a static audit of the route’s full transitive closure found no web-safety defect. The App Error boundary in `mobile/app/_layout.tsx:50` was never triggered.
- **The E2E failure was a harness bug, not a product bug:** the spec’s viewport guard measured `window.innerWidth` on `about:blank`, where Chromium’s mobile emulation reports the 980px default layout viewport for every iPad/Android tablet descriptor (iPad gen 7 → 980x1307 inner vs 810x1080 screen). Fixed by measuring `screen.width`/`screen.height` (true device CSS geometry; still catches a narrowed desktop). See `e2e/tests/tablet-vibe-studio.spec.ts`.
- **Three product defects were found and fixed** (all in the uncommitted worktree):
  1. **Blank phone frame** in the default browser lane when the box has no dev server — `DevPreview` returns `null` before any `/dev/status` exists (`DevPreview.tsx:834`), so the frame rendered an empty box. The studio now paints a persistent “The mobile frame is ready…” pane beneath every lane (`vibe-studio.tsx` `emptyPaneFill`), satisfying the “frame must render even while the project is still starting” requirement.
  2. **Full-screen modal over the split** — inside the frame, `DevPreview`’s “Open in Yaver” presented a full-screen `<Modal>` on top of the split (the exact old behavior the goal forbids). Added a `paneMode` prop (`DevPreview.tsx`): no card, no Modal, WebView fills the host frame. Existing `hostedInModal` and default paths unchanged.
  3. **Silent project fallback** — `?project=<missing>` silently selected the first mobile project via `mapped[0]`. Now it shows “Project `<x>` isn’t on the connected box — pick one below.” (gated on `connected`, since the box’s project list is only known after connect).
- **New regression guard:** “tablet vibe studio keeps the phone frame while the box has no dev server” — proved by removing fix 1 and watching it fail, then restoring.

## Work already made

### Null crash fix

In `mobile/app/(tabs)/tasks.tsx`, guarded the selected task access:

```ts
selectedTask?.runnerId
```

and added `selectedTask?.runnerId` to the effect dependencies. This fixed:

`Cannot read properties of null (reading 'runnerId')`

This is shared mobile/RN-web code. Do not remove the guard or alter native transport behavior.

### Landscape navigation

In `mobile/app/(tabs)/_layout.tsx`:

- landscape rail was reduced to the compact 88px icon rail;
- landscape labels are stacked below icons;
- landscape tab items are sized for the compact rail.

Portrait and phone layouts should remain unchanged.

### Project list/layout

In `mobile/src/theme/tokens.ts`:

- phone projects: 1 column;
- portrait tablet projects: 2 columns;
- landscape tablet projects: 3 columns;
- repositories already use 4 columns in landscape.

In `mobile/app/(tabs)/apps.tsx`, project-card sizing was corrected to use:

```ts
layout.gridCols("projects")
```

instead of incorrectly using the repository grid token.

### Main actions cleanup

In `mobile/app/(tabs)/apps.tsx`:

- removed the oversized active-project “Ship It” and “Screenshots” quick-action row;
- kept only “Open in Yaver” and “Stop” for the active project;
- tablet “Open in Yaver” is constrained to roughly 168–210px instead of flexing across the row.

In `mobile/app/(tabs)/tasks.tsx`:

- removed the visible Ship It toolbar action and its one-tap deploy handler.

Do not delete the underlying deployment MCP/API capability. The deployment workflow should be invoked through Vibing/MCP and still support TestFlight, tvOS, Android/Play, Wear OS, watchOS, visionOS, Android TV/Auto, etc.

Dedicated screenshot pages/tools were not deleted. They are separate workflows and should only be changed if the intended product decision is to remove those entirely.

### Vibe Studio route

`mobile/app/vibe-studio.tsx` already exists and was intended as the tablet split route:

- landscape: left preview, right `StudioChatPane`;
- portrait: chat with a preview peek;
- Browser/Live lane switcher;
- project picker;
- `StudioChatPane` streams raw task output and renders the shared ANSI live console.

`mobile/src/components/studio/StudioChatPane.tsx` contains:

- Vibing composer;
- task history;
- raw runner stdout streaming;
- foldable “Live console” with `AnsiConsoleText`;
- task status updates.

The route was recently changed to wrap the left side in a persistent phone-shaped frame. That change is the most likely area to inspect first for the current runtime failure, along with `DevPreview` inside the new route.

### Open-in-Yaver routing

`mobile/app/(tabs)/apps.tsx` function `openRunningPreview()` was changed so tablet landscape navigates immediately to:

```ts
router.push({
  pathname: "/vibe-studio",
  params: { project: runningProject || fresh?.workDir || "" },
});
```

It intentionally navigates even when the dev server is not ready, so the frame and chat remain visible while loading. Phone/portrait paths retain the old behavior.

## Important debugging direction

The first investigation should establish the real browser runtime exception, not rely on the Expo HTTP status:

1. Open the actual RN-web route in a real mobile/device browser context or headed Chromium.
2. Capture browser console/runtime errors and Metro output.
3. Temporarily replace the left `DevPreview` with a static placeholder and confirm whether the route renders. If it does, the crash is in `DevPreview` or one of its web-only dependencies.
4. Temporarily replace `StudioChatPane` with a static right pane and repeat.
5. Keep the phone frame visible in all loading/error states.
6. Add a named error state with a route-to-fix, not a blank screen or spinner.

Potential suspects:

- `DevPreview` was designed primarily around the existing Apps/Tasks preview flow and may assume a modal or active dev status;
- RN-web may be hitting a native-only path in `DevPreview`;
- the new phone-frame dimensions may create an invalid flex/min-height combination;
- `StudioChatPane` may be mounting a task stream or device context that is not safe before a project/task exists;
- the URL’s `project=sfmg` value must match the project returned by `quicClient.listProjects(true)`.

The right pane must render even if the left preview fails. The left frame must render even if the dev server is loading.

## Verification constraints

- Use headless checks first, then verify the real RN-web surface in a genuine device context.
- Do not call a narrowed desktop Chrome window an iPad test. Use the project’s mobile E2E device context utilities.
- Preserve native behavior: no native file changes unless required and explicitly validated.
- Do not commit or push.
- Keep unrelated dirty worktree changes, including `tests/fixtures/native-android-kotlin/.gradle/`.
- Do not delete the Talos repository. Talos generated artifacts were intentionally moved to Trash earlier; the repository remains.

## Current checks

- `http://localhost:8081/` responds HTTP 200 (Metro was restarted 2026-08-21 for verification; the handoff’s original claim was stale at audit time).
- Expo/Metro is running on port 8081.
- `e2e/tests/tablet-vibe-studio.spec.ts` — 3/3 green (landscape split, portrait peek, persistent-frame guard). The route renders.
- TypeScript still has four pre-existing unrelated errors:
  - `mobile/app/(tabs)/tasks.tsx:4489`
  - `mobile/app/(tabs)/tasks.tsx:5150`
  - `mobile/app/repo-coding.tsx:253`
  - `mobile/src/lib/codingSession.ts:138`

Do not treat those four existing errors as proof that the Vibe Studio route is healthy; the route needs a real browser render check. — Resolved 2026-08-21: the route now has one (see Resolution above).

## Relevant files

- `mobile/app/vibe-studio.tsx`
- `mobile/src/components/studio/StudioChatPane.tsx`
- `mobile/src/components/studio/LivePreviewPane.tsx`
- `mobile/src/components/DevPreview.tsx`
- `mobile/app/(tabs)/apps.tsx`
- `mobile/app/(tabs)/tasks.tsx`
- `mobile/app/(tabs)/_layout.tsx`
- `mobile/src/hooks/useResponsiveLayout.ts`
- `mobile/src/theme/tokens.ts`
- `e2e/tests/tablet-vibe-studio.spec.ts` (was missing here — the closed-loop test for this route; now includes the persistent-frame regression guard)
- `e2e/tests/mobile-app-lane-matrix.spec.ts`

