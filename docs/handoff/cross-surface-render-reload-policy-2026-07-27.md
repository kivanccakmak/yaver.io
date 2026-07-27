# Cross-Surface Render / Reload Policy — 2026-07-27

## User-Visible Problem

The Vibing/runtime surface was distracting during real development:

- Runner output could trigger repeated preview reloads while the task was still running.
- The preview showed Yaver loading placeholders during re-render instead of keeping the last working iframe visible.
- Safari microphone permission prompts could block the whole page from a normal chat composer path.
- Multiple render triggers could overlap: MCP `runtime_render_requested`, user text mentioning reload/re-render, manual Fast/Full Reload, and task-completion logic.

The product rule from the incident: **coding and rendering are separate phases**. If the runner is still coding, Yaver should let it code. Render/reload only happens after the task fully completes, or when the user explicitly reloads while no task is coding.

## Policy Now Documented

Updated:

- `CLAUDE.md`
- `AGENTS.md`

Rule of thumb now documented:

- `queued` / `running` task status means the runner is coding.
- `runtime_render_requested`, "reload"/"re-render" text, and output lines are render intents while coding.
- Render intents queue while coding and flush once at `completed` / `review`.
- Reload is atomic: do not start another reload while one is in flight.
- Do not start a new coding turn on the same surface mid-reload.
- Keep the last good iframe/native preview visible during reload; first open may show a loading surface, reload may not replace a working preview with a branded placeholder.
- Applies to web, mobile, tablet, tvOS, watchOS, Wear OS, car, AR/VR, and companion CLI surfaces.

## Code Changed In This Pass

### Web Vibing / Runtime

File: `web/components/dashboard/RuntimeLabView.tsx`

Implemented:

- Added explicit runner-coding state helper:
  - `taskStatusMeansRunnerIsCoding(status)` for `queued` / `running`.
- Changed task-finished render behavior:
  - no preview reload while a task is `queued` / `running`;
  - render once after `completed` / `review`;
  - MCP `runtime_render_requested` now participates in the same completion-only path.
- Made reload atomic:
  - `webPreviewReloadInFlightRef` prevents concurrent reloads;
  - manual Fast/Full Reload is ignored/queued with a quiet status if a task is coding;
  - Send is paused while a preview reload is finishing.
- Removed the normal chat composer mic button that triggered Safari's blocking microphone prompt.
- Added chat copy-to-clipboard in the Chat header.
- Folded the Chat runner/model editor by default:
  - compact Runner / Model labels remain visible;
  - the select/save/OAuth controls open behind an Edit/Fold button so runner output gets more vertical space.
- Added a draggable desktop split handle between preview/output and Chat:
  - the runtime grid uses a persisted local width preference on wide screens;
  - phone/mobile preview defaults to giving Chat substantially more room;
  - tablet preview returns to the prior compact Chat width by default;
  - the handle remains available so the user can override either mode.
- Reloads keep the existing iframe visible:
  - reload paths no longer set `webPreviewFrameReady(false)`;
  - loading overlay is only shown on first open, not while `webPreviewBusy` reloads an existing preview.

### Mobile Tasks

File: `mobile/app/(tabs)/tasks.tsx`

Implemented:

- Added explicit helpers:
  - `taskStatusAllowsRuntimeRender(status)` for `completed` / `review`;
  - `taskStatusMeansRunnerIsCoding(status)` for `queued` / `running`.
- Changed SSE `runtime_render_requested` handling:
  - previously called `rerenderActiveRemoteRuntimeSurface(...)` immediately;
  - now stores a pending render request in `pendingRuntimeRenderRef`;
  - a completion effect flushes it once when the selected task reaches `completed` / `review`.
- Changed bare reload/re-render commands from the composer:
  - if no task is coding, they still use the direct Hermes reload path;
  - if the selected task is `queued` / `running`, they queue a pending render and clear the composer instead of reloading mid-task.

### Mobile Remote Runtime Render

File: `mobile/src/lib/feedbackTrigger.ts`

Implemented:

- Added module-level `remoteRuntimeRenderInFlight` guard.
- `rerenderActiveRemoteRuntimeSurface(...)` now skips duplicate render triggers while a remote runtime render is already in flight.

## Important Remaining Work

- Add regression tests for the new render policy:
  - web: task running + `runtime_render_requested` must not call `reloadWebPreview`;
  - web: task completed must call reload exactly once;
  - mobile: `runtime_render_requested` while running must not call `rerenderActiveRemoteRuntimeSurface`;
  - mobile: completion flushes one pending render.
- Audit other native preview entry points for manual reload while a task is running:
  - `mobile/src/components/DevPreview.tsx`
  - `mobile/app/(tabs)/apps.tsx`
  - tablet / tvOS / watch / car / AR surfaces when implemented or when their code paths are identified.
- Prefer moving the policy into a small shared helper per platform:
  - `canRenderNow(status)`
  - `isRunnerCoding(status)`
  - `coalesceRenderIntent(...)`
  so copied logic does not drift.
- Add a quiet UI status line for queued render intent on mobile, equivalent to the web preview note.
- Check whether direct reload-intent commands (`reload`, `hot reload`, `re-render`) should become explicit queued render intents whenever a coding task is active, rather than direct dev-server commands.

## Verification Done

Checks passed for this patch:

- `git diff --check -- web/components/dashboard/RuntimeLabView.tsx mobile/app/'(tabs)'/tasks.tsx mobile/src/lib/feedbackTrigger.ts CLAUDE.md AGENTS.md docs/handoff/cross-surface-render-reload-policy-2026-07-27.md`
- `cd web && npx tsc --noEmit --pretty false`
- `cd mobile && npx tsc --noEmit --pretty false`
