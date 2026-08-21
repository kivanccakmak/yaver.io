# iPad Vibe Studio — Deep Audit

**Date:** 2026-08-21 · **Audited doc:** [`docs/IPAD_VIBE_STUDIO_HANDOFF.md`](IPAD_VIBE_STUDIO_HANDOFF.md)
**Method:** every claim in the handoff was verified against the working tree on disk and, where possible, against `tsc`, `git diff`, and live process checks. File:line citations were verified at audit time.

> Golden rule (AGENTS.md): this `.md` will drift. The code is the source of truth. Re-grep before acting on any citation below.

---

## Executive summary

1. **Every "Work already made" claim in the handoff is accurate.** The null-guard, landscape rail, grid tokens, quick-action removals, route, and Open-in-Yaver routing all match the code exactly.
2. **The four pre-existing TypeScript errors are real and current** — a live `tsc --noEmit` reproduces exactly those four, and the uncommitted Vibe Studio work introduces **no new** type errors.
3. **The claimed "runtime/rendering failure" of `/vibe-studio` is unconfirmed.** A full static web-safety audit of the route's entire transitive closure found **no module-scope native access and no first-render throw**. The dedicated closed-loop test `e2e/tests/tablet-vibe-studio.spec.ts` **has never been run** (last E2E run `e2e/test-results/.last-run.json` = 2026-08-19, predates the route commit). Nobody has actually rendered this route in a browser yet.
4. **The audit surfaced three genuine product defects** that match the handoff's "does not render correctly" symptom without needing a crash:
   - Blank phone frame in the default browser lane when no dev server is running (violates the handoff's own requirement #5).
   - `DevPreview` can still open its full-screen `<Modal>` over the split (the exact "old full-screen preview modal" the goal forbids).
   - `?project=sfmg` can silently select the wrong project via fallback heuristics.
5. **The handoff's "Current checks" are stale** — Metro is not running on 8081 right now.

## Resolution (2026-08-21, same session)

The plan below was executed. Outcome:

- **The route renders.** `e2e/tests/tablet-vibe-studio.spec.ts` ran for the first time: landscape split and portrait peek both pass. The "crash" was never reproduced; the closure audit above held.
- **The one E2E failure was a harness proxy bug:** the spec's viewport guard measured `window.innerWidth` on `about:blank`, where Chromium mobile emulation reports the 980px default layout viewport for every tablet descriptor (iPad gen 7 → 980x1307 inner vs 810x1080 screen). Fixed by measuring `screen.width`/`screen.height` (device geometry — stable, and still catches a narrowed desktop).
- **All three defects fixed:** persistent phone frame beneath every lane (`vibe-studio.tsx` `emptyPaneFill`); `DevPreview` `paneMode` prop (no card, no full-screen Modal over the split); `?project=` no-match now surfaces a named message instead of silently picking `mapped[0]`.
- **Guard proven by breaking it:** the new "keeps the phone frame while the box has no dev server" spec failed when the fix was removed, then passed on restore.
- Mobile `tsc --noEmit`: still exactly the same four pre-existing errors, no new ones.

---

## Verified claims (accurate)

| # | Handoff claim | Evidence (verified on disk) |
|---|---|---|
| 1 | Null crash fix `selectedTask?.runnerId` + effect dep | `mobile/app/(tabs)/tasks.tsx:3097` (`selectedTask?.runnerId !== "yaver-phone"`), dep added at `:3117` |
| 2 | Landscape rail reduced to compact 88px icon rail, labels stacked, items sized for rail | `mobile/app/(tabs)/_layout.tsx` diff: `width: layout.rail.width` (88), `tabIconWrapRail` → `flexDirection: "column"`, `tabLabelRail` 10pt, `tabBarItemStyle` height 64 |
| 3 | Projects grid: phone 1 / portrait 2 / landscape 3; repos already 4 in landscape | `mobile/src/theme/tokens.ts:67` (`projects: { phone: 1, tabletPortrait: 2, tabletLandscape: 3 }`), `:63` (`repos … tabletLandscape: 4`) |
| 4 | Project-card sizing uses `layout.gridCols("projects")` not `"repos"` | `mobile/app/(tabs)/apps.tsx:2760` |
| 5 | Ship It / Screenshots quick-action row removed; only Open in Yaver + Stop remain; tablet Open in Yaver ≈168–210px | `apps.tsx` diff: `quickActions` block fully removed; `style={[s.actionBtn, s.openBtn, layout.isTablet ? { flex: 0, minWidth: 168, maxWidth: 210 } : { flex: 1 }, …]}` |
| 6 | tasks.tsx Ship It toolbar action + one-tap handler removed; deploy capability kept | `handleShipIt` deleted (`tasks.tsx` diff); `quicClient.deploy` / `getDeployTargets` untouched |
| 7 | Vibe Studio route exists: landscape left preview / right `StudioChatPane`, portrait chat + peek, lane switcher, project picker, raw stdout streaming | `mobile/app/vibe-studio.tsx`, `mobile/src/components/studio/StudioChatPane.tsx` |
| 8 | Route wraps left side in a persistent phone-shaped frame | `vibe-studio.tsx` diff: `deviceStage` / `deviceFrame` / `deviceScreen` (maxWidth 430, maxHeight 760) |
| 9 | `openRunningPreview()` navigates immediately to `/vibe-studio` on tablet landscape, even when the server is not ready | `apps.tsx:1177-1189`: `router.push({ pathname: "/vibe-studio", params: { project: runningProject || fresh?.workDir || "" } })` |
| 10 | Four pre-existing TS errors at the exact listed lines | `tsc --noEmit` reproduced **only** those four: `tasks.tsx:4489,9` (TS2322), `tasks.tsx:5150,11` (TS2322), `repo-coding.tsx:253,9` (TS2322), `codingSession.ts:138,48` (TS2366). No new errors from the uncommitted work. |

Supporting structure also confirmed:
- More-menu tablet-only entry: `mobile/app/(tabs)/more.tsx:2013` (`handleVibeStudio` → `router.navigate("/vibe-studio")`), card gated on `layout.isTablet` at `:2400`.
- Surface marker on authed requests: `mobile/src/lib/quic.ts:7360-7383` (`setSurfaceMarker` / `clearSurfaceMarker` → `X-Yaver-Surface`).
- `?project=` matching logic: `vibe-studio.tsx:79-83` (name, path, or path-suffix match).

---

## Stale / unverifiable

- **"Metro is running on port 8081, `/` returns HTTP 200."** False at audit time: port 8081 is free (`lsof -iTCP:8081 -sTCP:LISTEN` → empty), no Metro process, `curl localhost:8081` → 000. The handoff's "Current checks" are a snapshot from when it was written.
- **The "current runtime failure" of `/vibe-studio`** is an open diagnosis, not a confirmed defect. See next section.

---

## Web-safety audit of the route closure (the "crash" question)

Static audit of the **entire** render closure of `mobile/app/vibe-studio.tsx` — `DevPreview`, `StudioChatPane`, `LivePreviewPane`, `AppScreenHeader`, `useDevice`/`DeviceContext`, `useColors`/`ThemeContext`, `useResponsiveLayout`, `quicClient`, plus every module-scope import:

- **No module-scope `new NativeEventEmitter`** is reachable with an `undefined` native module. The only module-scope occurrence is `bundleLoader.ts:6-8`, guarded by a ternary (`YaverBundleLoader ? new NativeEventEmitter(…) : null`) — `emitter` is `null` on web.
- **No unguarded `NativeModules.X` dereference at module scope.** `bundleLoader.ts:3-4` and `sandboxControl.ts:24` read but never dereference at import time; all calls are `?.` / `if (!X)` guarded inside functions.
- **Every package in the closure has a web build or a `.web` twin**: `react-native-webview` → `WebViewCompat.web.tsx` (iframe); `expo-sensors` → web build; `react-native-udp` → `beacon.web.ts` stub; `expo-secure-store` → web stub; AsyncStorage/netinfo → web builds.
- **No first-render throw** in any listed file. `DevPreview` returns `null` when `status === null` (`DevPreview.tsx:834`) **after** all hooks — no hooks-order violation.

**Conclusion:** the route's closure is web-safe by static analysis. If the route shows "App Error" in a real browser, the root cause is a race/effect-time throw or an out-of-closure module — which is why the handoff's own debugging direction (bisect by static placeholder + capture the console stack) is still the right procedure, and why the **never-run E2E spec is the single highest-value next step**.

---

## Genuine defects the audit surfaced

### 1. Blank phone frame in the default lane (violates handoff requirement #5)
- Default lane is `"browser"`. With no dev server, `DevPreview` renders `null` (`DevPreview.tsx:834`), so the phone frame (`deviceScreen`) shows an **empty dark box**.
- The "The mobile frame is ready. Pick a project or wait…" emptyPane only renders when `lane !== "browser"` and no project is selected (`vibe-studio.tsx:205-210`).
- Handoff requirement: *"The left frame must render even if the dev server is loading"* — currently unmet in the browser lane.

### 2. DevPreview is a card + full-screen `<Modal>` component, not a pane
- Inside the frame, `DevPreview` renders its status card with **Open in Yaver**; tapping it calls `handleOpen` → `setShowPreview(true)` → a full-screen `<Modal>` (`DevPreview.tsx:1522-1526`) presents **over the split**.
- On RN-web that Modal is a full-page overlay. This resurrects exactly the "old full-screen preview modal" the handoff's Goal and the Open-in-Yaver routing were changed to avoid.
- Fix shape: a "pane mode" for `DevPreview` (like the existing `hostedInModal` mode) that suppresses the card chrome and the Modal path inside the studio.

### 3. `?project=sfmg` can silently select the wrong project
- `apps.tsx:1186` sends `project: runningProject || fresh?.workDir || ""`.
- `vibe-studio.tsx:79-85` matches name / path / path-suffix, then falls back to "first mobile/web project" and finally `mapped[0]` — **no signal when the URL param matches nothing**.
- A display-name mismatch silently opens the wrong project in the pane and picker.

---

## Reproduction / verification commands

```sh
# Boot the RN-web app (Metro on 8081)
cd mobile && npx expo start --web            # or: npm run web

# The dedicated closed-loop spec — NEVER RUN yet. Real tablet device contexts.
cd e2e && MOBILE_WEB_URL=http://localhost:8081 npx playwright test tablet-vibe-studio.spec.ts

# Ground truth for the crash claim — assert viewport + capture console:
#   e2e/tests/tablet-vibe-studio.spec.ts asserts the tabletLandscape viewport
#   (viewportMatchesSurface) BEFORE touching the DOM.

# Type errors (read-only)
cd mobile && ./node_modules/.bin/tsc --noEmit --incremental false
```

---

## Plan (proposed order)

**Phase 0 — reproduce (headless-first):** boot Metro web; run `tablet-vibe-studio.spec.ts` with `MOBILE_WEB_URL`; drive `/vibe-studio?project=sfmg` in the `tabletLandscape` device context and capture the real console error. Establish ground truth before changing code.

**Phase 1 — fix what the audit already proves:**
1. Render the persistent phone-frame emptyPane in the **browser** lane when no dev-server status exists (currently blank).
2. Give the studio a "pane mode" so `DevPreview` cannot open its full-screen Modal over the split; add a named error state with a route-to-fix (handoff requirement #6).
3. Honor the URL `project=` param strictly, or surface the no-match state instead of silently picking `mapped[0]`.

**Phase 2 — prove it (closed loop):** re-run `tablet-vibe-studio.spec.ts` green; **add an assertion** that the left frame still renders with no dev server + `project=` in the URL (the guard that would have caught defect #1).

**Phase 3 — hygiene:** update `IPAD_VIBE_STUDIO_HANDOFF.md` + `TABLET_VIBE_STUDIO_PLAN.md` — add `e2e/tests/tablet-vibe-studio.spec.ts` to Relevant files, correct the stale Metro status, record these verdicts.

---

## Relevant files

- `mobile/app/vibe-studio.tsx`
- `mobile/src/components/studio/StudioChatPane.tsx`
- `mobile/src/components/studio/LivePreviewPane.tsx`
- `mobile/src/components/DevPreview.tsx`
- `mobile/src/components/WebViewCompat.tsx` / `WebViewCompat.web.tsx`
- `mobile/app/(tabs)/apps.tsx`
- `mobile/app/(tabs)/tasks.tsx`
- `mobile/app/(tabs)/_layout.tsx`
- `mobile/app/(tabs)/more.tsx`
- `mobile/src/hooks/useResponsiveLayout.ts`
- `mobile/src/theme/tokens.ts`
- `mobile/src/lib/quic.ts`
- `mobile/src/lib/previewBundlePath.ts`
- `mobile/src/lib/devLane.ts`
- `mobile/src/lib/bundleLoader.ts`
- `e2e/tests/tablet-vibe-studio.spec.ts` (⚠️ absent from the handoff's Relevant files — this is the test surface for the route)
- `e2e/tests/mobile-app-lane-matrix.spec.ts`
- `TABLET_VIBE_STUDIO_PLAN.md`
