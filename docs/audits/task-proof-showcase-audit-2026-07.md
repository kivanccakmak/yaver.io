# Task Proof / Showcase — deep audit of what exists, what's dead, what's missing (2026-07)

> **Docs drift; code is the source of truth.** Every `file:line` below was read at
> `533c9d603...` (main, 2026-07-28) by five parallel deep-read agents. Grep again
> before acting on any claim; if this doc and the code disagree, this doc is the bug.

**Scope:** the feature request — *"user gives a task; when it completes, a rich
'task completed' UI with proof video + narrative text appears — mobile app first,
web too, and the feedback-SDK lane too."* The reference UX is the hand-authored
claude.ai artifact from the false-positive Selenium loop (hero headline → autoplaying
proof video → before/after chips → root-cause card → numbered closed-loop timeline →
footer with commit hash + verdict pills).

**Method:** five parallel deep-reads — (1) recording/capture infrastructure,
(2) task lifecycle + completion data model, (3) mobile task UI, (4) web task UI +
report generators, (5) feedback SDK + black box end-to-end — synthesized here.

**Legend:** ✅ exists & wired · 🟡 exists, unwired/partial · ❌ missing · 💀 phantom
(advertised but no implementation) · 🔴 bug found during this audit.

---

## 0. Constraints (the product contract for this feature)

Gathered from the user during this audit; these outrank any implementation
preference below:

| # | Constraint |
|---|---|
| C1 | **Mobile-first.** The showcase lands in the phone app primarily; web is parity. |
| C2 | **P2P only.** Media + text live on the box, served over the agent's authed HTTP. Nothing in Convex (already enforced — `convex_privacy_test.go` fences `clipPath`, `summaryText`, `posterBytes`, `videoBlob`, …). |
| C3 | **Pragmatic format.** Structured JSON for card chrome (URLs, stats, commit), **markdown** for the narrative body (both surfaces already render MD). HTML only as an optional export later — not the primary vehicle. |
| C4 | **Plumbed, not standalone.** The card is a property of a task (or turn), rendered in the existing task thread; the recording is a byproduct of the render the product already performs. No new tabs, no parallel subsystem. |
| C5 | **Optional, default OFF.** A toggle. Off = tasks complete exactly as today, zero overhead. |
| C6 | **Toggle = proof requirement.** When ON, "done" must carry documentary evidence: video of the result actually working + narrative. Claims vs evidence stay separated (the recap doctrine, §4.3). Proof-capture failure is a named cause with a route, never a silent fallback to unproven "done". |
| C7 | **Browser automation is the primary proof lane** wherever the stack can render to a browser (RN→RN-web, Flutter→web-server, web frameworks). Simulator/emulator recording is the heavyweight fallback for Swift-only/Kotlin-only. Lane choice is stack × box capability aware, probed by operation, not file-sniffing (§6). |
| C8 | **The feedback-SDK lane gets proof too.** A tester who never opens Yaver's app — shake → bug report → fix task — must receive "your fix is ready → ▶ see proof" back in *their* app. |
| C9 | **Delivery UX:** a proof button/link in the task's response; tapping opens an **overlay card / popup** (mobile sheet, web modal) — no navigation, no surprise re-render of the preview underneath. |

---

## 1. Executive summary

**The feature is ~80% built and ~0% assembled.** Yaver already ships, today:

- a **default-OFF per-task toggle** ("Record Demo Video", `mobile/.../taskComposerPrefs.ts:8`, `settings.tsx:4150-4164`) — exactly C5;
- an **OnTaskDone → auto-record bridge** (`desktop/agent/tasks_video_summary.go:29`, wired `main.go:3846`) that detects the stack, records a ≤12s MP4, extracts a poster, and stamps `videoClipId/videoStatus/videoClipUrl/videoPosterUrl` onto the task JSON (`httpserver.go:4596-4631`);
- a **browser-automation live recorder** (`browser_video.go` — CDP frames of the agent's own chromedp session → ffmpeg MP4, headless-safe) — exactly C7's primary lane;
- a **Maestro exerciser** that drives the app *during* the clip so the video shows use, not an idle screen (`vibe_preview_clip.go:178`, `vibe_preview_exercise.go`);
- **Range-capable, authed, relay-allowlisted MP4 + poster serving** (`vibe_preview_clip_http.go:105-199`);
- an **authenticated mobile video player** (`AuthenticatedVideoPlayer.tsx`) and a web blob-player (`VibeCodingView.tsx:1909-1966`);
- a **before/after visual-diff summarizer** with an LLM one-sentence describer (`vibe_preview_summary.go` — `QueueSummary`, `claudeCLISummarizer`);
- a complete **narrated documentary generator** — MP4 + poster + VTT + per-cue TTS + git-activity script + claims-vs-evidence honesty layer + real retention pruning (`recap*.go`, ~2900 LOC);
- a **complete but never-rendered showcase layout** on mobile (`VibePreviewModal.tsx`, 325 lines, **zero importers**).

What the user actually sees at completion today: **a green dot, a haptic, and an
11pt text chip.** Web shows a status string. The feedback loop returns nothing.
The work is therefore *assembly and plumbing-completion*: join the pieces at the
seams they were built for, fix the eight bugs found in their joints (§7), and
render one card on three surfaces.

**The genuinely new pieces are only:** (a) a structured `proof` record on the task
(commit SHA, diff stats, narrative MD, before/after refs — none captured today);
(b) the card/overlay UI on mobile + web; (c) the return channel into the feedback
SDK; (d) retention for clips (none exists); (e) the stack×box lane picker made
capability-probing and browser-first.

---

## 2. The task lifecycle and the completion seam

### 2.1 Model

- Statuses `queued|running|review|stopped|completed|failed` — `desktop/agent/tasks.go:63-72` (`TaskStatusFinished` is the const for wire value `"completed"`).
- `review` vs `completed` is decided by **source, not content**: `taskAwaitsManualCompletion` (`tasks.go:1248-1264`) sends `Source == "mobile"|"mobile-code"` to `review`; everything else goes straight to `completed`. Web-created tasks never enter `review`.
- Fields available at completion, free: `Title`, `Description`, `ResultText` (clean final assistant message), `Output` (full transcript, in-memory), `Turns`, `CostUSD`, tokens, `StartedAt/FinishedAt`, `WorkDir`, `GitRemote/GitBranch/AutoPush`, `VideoEnabled/VideoSource/VideoClipID/VideoStatus` — `tasks.go:1033-1200`.
- **Not present at completion:** exit code, diff stats, commit SHA, structured summary, before/after refs. ❌

### 2.2 The seam — where proof generation attaches

- Terminal transition: the process-waiter in `startProcess`, `tasks.go:3175-3355`. `FinishedAt` set at `:3257`; final assistant turn appended at `:3266-3272`; **follow-up drain at `:3274-3323`** resets the task and re-spawns *without* firing `fireTaskDone` — so:
  - **whole-task proof** hooks `OnTaskDone` (assigned once, `main.go:3779-3847`; `MaybeRecordTaskSummary` already sits at `:3846`);
  - **per-turn proof** must hook `tasks.go:3266` instead (turn index = `len(Turns)-1` at that instant).
- `fireTaskDone` passes a **copy** (`tasks.go:1436-1452`) — anything the generator computes must be written back via a `TaskManager` mutation (`SetTaskVideoState` at `tasks.go:4459` is the pattern), never by mutating the argument.
- The `done` SSE frame carries only `{type:"done", status}` (`httpserver.go:5223,5271`). The structured `eventCh` (`emitTaskEvent`, `agent_question_http.go:246`) already carries `runtime_render_requested`, `agent_question`, `command_*`, `push_pending` — a new `task_proof_ready` event is backwards-compatible by the documented contract at `tasks.go:1176-1190`. 🟡

### 2.3 Git at completion — the missing commit footer, five lines away

`autoPushAfterTask` (`task_ensure_clone.go:336-410`) already runs
`git status --porcelain` → `add -A` → `commit -m "yaver: <Title> (task <ID>)"` →
`rev-list --count @{u}..HEAD` — and **discards the SHA and diff stats**. Adding
`git rev-parse HEAD` + `git diff --shortstat HEAD~1..HEAD` here and writing them
back to the task gives the showcase its commit footer + "N files, +A −D" chips
for free. ❌→ trivial.

### 2.4 Persistence traps

- `persistedTask` (`store.go:14-35`) drops `VideoClipID/VideoStatus/WorkDir`; `Output` truncated to last 2000 chars. **A daemon restart orphans the clip link.** 🔴
- Full-transcript sidecar exists: `~/.yaver/sessions/<ts>_<taskID>.md` (`sessions.go:35-96`).

---

## 3. Capture inventory — every recorder on the box

| Subsystem | Produces | Trigger | Storage | Task-linked? |
|---|---|---|---|---|
| **Vibe-preview clips** `vibe_preview_clip.go` | MP4 ≤30s (12s default) + poster JPEG | ✅ auto on `OnTaskDone` when `VideoEnabled` (`tasks_video_summary.go:29`) | `~/.yaver/vibe-preview/clips/<project>/<c_hex>.mp4` (0700/0600) | ✅ first-class (`Task.VideoClipID`) |
| **Browser live recorder** `browser_video.go` | MP4 of the agent's own chromedp session, 10fps CDP→ffmpeg, headless-safe | ✅ auto when `VideoEnabled && source==browser` (`tasks.go:2019` sets `YAVER_TASK_RECORD_BROWSER=1`) | same clip layout; cross-process marker `~/.yaver/vibe-preview/task-clips/<taskID>.clip` (`browser_video_task.go:69`) | ✅ via marker |
| **Maestro exerciser** `vibe_preview_exercise.go` | drives the app during recording (`ExerciseClip`, `vibe_preview_clip.go:178`) | with clip | — | ✅ |
| **Sim recorders** | `xcrun simctl io booted recordVideo` (`:305`) / `adb screenrecord` + pull (`:316`) | with clip (`source==sim-ios|sim-android`) | clip layout | ✅ |
| **Phone capture** `YaverScreenRecorder.swift` (ReplayKit) + Android MediaProjection | MP4 on device → `POST /vibing/preview/clip/upload` (50MB cap, `vibe_preview_clip_upload.go:47`) | manual / `recordAndUploadPhoneClip` (`vibePreview.ts:305`) | clip layout | 🟡 source `phone` stubbed in parts |
| **Recap builder** `recap_build.go` | narrated 75s MP4 + poster + VTT from screenlog frames + git activity | autorun-finish only (`recap_autorun.go:29`, opt-in) | `~/.yaver/recaps/<r_hex>/` — **with pruning** (`recap.go:324`) | ❌ keyed by AutorunID, no TaskID |
| **screenlog** (20 files) | rolling deduped JPEG frames, 2s interval, 7-day retention, 4GB budget | continuous when enabled | `~/.yaver/screenlog/<session>/` | 🟡 queryable by window — `screenlogSessionForWindow` (`recap_script.go:53`) answers "what happened between t1..t2" |
| **`clip_*` verbs** `recorder.go` | whole-desktop ffmpeg MP4 (Loom-replacement) | manual | `~/.yaver/clips/<session>/` — no retention | ❌ |
| **WebRTC video track** `remote_runtime_video_track.go` | live H.264 (Pion track) for native-app streaming | live only | — | ❌ not recordable today; the natural proof source for kt/swift streamed apps 🟡 |
| **capture.go / ghost_stream.go** | live MJPEG only | — | — | ❌ |
| 💀 `record_start/stop/drivers`, `morning_list/show/latest/rollback` | **phantom MCP verbs** — declared in the live tool roster, deleted from dispatch (`morning_*` deleted in `0185942ff`; see `tasks/recap-ops-and-honesty.md:84-105`) | — | — | — |

**Retention:** `~/.yaver/vibe-preview/clips` and `~/.yaver/clips` and
`~/.yaver/feedback/` have **no pruning at all** (called out at `recap_test.go:338`
and `tasks/recap-ops-and-honesty.md:104-113`). Only recaps and screenlog prune.
Recording per-task at scale requires copying `pruneRecaps` from day one — and
pruning on the failure path too. ❌

---

## 4. Text/narrative generators — the words half of the card

### 4.1 `ResultText` — free, already there
The runner's clean final message, appended as the last assistant turn
(`tasks.go:3266-3272`), capped 64KB on the wire (`httpserver.go:4560-4575`).
Zero-cost card summary. ✅

### 4.2 `VibeSummary` — the before/after chips, fully built, zero consumers 🟡
`vibe_preview_summary.go:30-38`: `{Seq, Text, Source, BeforeHash, AfterHash,
KickContext, CreatedAt}` — persisted JSONL, served at `GET /vibing/preview/summaries`,
emitted as a `summary` SSE event. `claudeCLISummarizer` (`:248-313`) shells
`claude --print --input-images before.png,after.png` for a one-sentence visual
diff; identical-hash short-circuit means no LLM cost when nothing visibly changed
(`:101`). `KickContext` is documented to carry a commit SHA. **`QueueSummary`
(`:85`) has zero production callers; default summarizer is a no-op unless
`YAVER_VIBE_SUMMARIZER=claude`.** Frame bytes fetchable per hash
(`GET /vibing/preview/frames/<hash>`, mobile `frameUrl` `vibePreview.ts:186`,
web `vibeFrameRequest` `agent-client.ts:5184`). Nothing anywhere renders the
before/after pair. One call from the completion seam wires it.

### 4.3 The recap script + honesty layer — the documentary doctrine ✅ (wrong key)
`recap_script.go` joins *what was on screen* (screenlog episodes) with *what
landed in git* (`CollectGitActivity`, `newsletter_compose.go:89`) into ≤12 timed
cues; LLM polish optional, deterministic draft always survives. `recap_evidence.go`
deliberately separates **claims** (`FinishReason`) from **evidence** (`Landed` =
commits>0 ∧ FinalCommit≠"", `Complete` from `## P<n>` priorities vs progress
evidence) — `recap.go:110-116` documents why. **This is C6's "proof, not
decoration" implemented — reuse the doctrine and the fields verbatim.** The only
missing join is a `TaskID` alongside `AutorunID` and a `[StartedAt,FinishedAt]`
window call.

### 4.4 The feedback fix-prompt composer — a text showcase that only LLMs ever read 🟡
`feedback.go:440-521` composes: project/lane, candidate URL, a timestamped
timeline (`0:03 — [voice] "…"` / `[screenshot]` / `[CRASH]`), captured errors +
stacks, transcript, media filenames. It is essentially the showcase page as text —
and it is never rendered for a human.

---

## 5. Serving & transport — how proof reaches each surface (all P2P ✅)

| Path | Where | Notes |
|---|---|---|
| Task JSON carries media URLs | `enrichTaskInfoVideo`, `httpserver.go:4596-4631` | absolute `videoClipUrl/videoPosterUrl` from `r.Host` + `X-Forwarded-Proto`; live status refresh. **Copy this shape for `proofUrl`.** |
| MP4/poster | `GET /vibing/preview/clip/<id>[/poster]` — `vibe_preview_clip_http.go:105-199` | `authSDKOrGuest`, `http.ServeContent` (Range — cellular seeking), `Cache-Control: private, max-age=86400, immutable`, ID-shape guard, **cross-process disk fallback** `findClipOnDisk`. Best media endpoint in the repo. |
| Relay allowlist | `httpserver.go:1940-1946` | clip GETs allowlisted for companion-scope tokens — add any new proof path here or TV/watch 403 forever. |
| Durable share | `maybeShareClipDurably`, `browser_video_task.go:109` | opt-in MinIO presigned URL, 7 days — the eventual "share this proof" seam. |
| Mobile playback | `AuthenticatedVideoPlayer.tsx` (expo-video, **headers on `VideoSource`**) | drop-in. |
| Web playback | blob shim `VibeCodingView.tsx:1907-1935` | works but blocks seeking. **Better:** the same-origin proxy `web/app/d/[deviceId]/[[...path]]/route.ts` streams bodies raw (`:218-231`) with cookie auth and even self-heals stale relay passwords (`:195-206`) — `<video src="/d/<id>/vibing/preview/clip/<clipId>">` gives real Range/seek with a plain src. Currently unused for clips. 🟡 |
| Header-free absolute URL (tvOS `AsyncImage`, `<img>`) | `?browser_session=` + `?__rp=` scheme, `agent-client.ts:3660-3668`; precedents `FeedbackView.swift`, `AppScreenPlane3D.tsx`, noted at `recap_http.go:10-15` | for surfaces that can't set headers. |
| SDK auth | `authSDK` chain `httpserver.go:2745-2896`; scopes `scopePathPrefixes` `httpserver.go:1791-1817` (`"feedback": {"/feedback"}`) | one line adds a `proof` scope for SDK-token access to a task's proof (C8). |

---

## 6. The proof-lane matrix (C7) — stack × box, browser-first

Preference order per C7: **browser lane whenever a web target exists** (cheapest:
headless Chromium + CDP recorder, works on any Linux box, seconds not minutes),
simulators only where no web target can exist, named refusal + route when the box
can do neither. Every cell must be **probed by operation** (attempt the lane),
not inferred from files — the whole false-green class lives in that difference.

| Stack | Any box (incl. headless Linux) — PRIMARY | macOS box — fallback | Linux box, no web target | Notes |
|---|---|---|---|---|
| Web framework (Vite/Next/…) | ✅ browser drive + `browser_video.go` recorder | — | — | already the `source==browser` path |
| RN / Expo | ✅ **RN-web at phone viewport** (established closed-loop lane, drives the REAL app) + browser recorder | 🟡 `sim-ios` recordVideo + Maestro | ✅ browser lane still works | 🔴 `autoDetectVideoSource` (`tasks_video_summary.go:109-130`) currently prefers `sim-ios` when `ios/` exists — **backwards vs C7**; flip to browser-first |
| Flutter | ✅ `flutter run -d web-server` + browser drive (classed `DevServerKindWeb`, `devserver_kind.go:37`) | 🟡 sim fallback | ✅ | ⚠ known trap: Flutter web-server serves index.html even on compile failure — proof lane must verify compile success before recording "success" (memory: `project_flutter_web_compile_fail_serves_blank`) |
| Swift-only iOS | ❌ no web target | ✅ build → boot sim → **Maestro drive** → `simctl recordVideo` (the `shots_capture.go` engine proves the full lane) | ❌ **named refusal + route**: "iOS proof needs a Mac; run render on `<mac-device>`" (runner/render role split is the seam) | never browser-automate a Swift app — the clip would be a lie |
| Kotlin-only Android | ❌ no web target | ✅ emulator + `adb screenrecord` + Maestro | ✅ same (emulator runs on Linux/KVM; redroid path exists — `studio/redroid.go`) | |
| Native app streamed via `native-webrtc` | 🟡 record the existing WebRTC H.264 track (`remote_runtime_video_track.go`) — recorder not built | — | — | the natural lane for C8's kt/swift feedback loop |
| Phone-on-desk (user present) | 🟡 ReplayKit/MediaProjection capture → clip upload | — | — | proof of the *real device*, the strongest evidence tier |

Missing-toolchain rule applies per cell: if Maestro/ffmpeg/Xcode is absent, offer
the streamed install (`ensureRunnerInstalledStream` pattern), don't dead-end.

---

## 7. Bugs & false greens found by this audit (fix before/while building)

| # | Bug | Where | Impact on this feature |
|---|---|---|---|
| B1 🔴 | `MaybeRecordTaskSummary` requires `Status == TaskStatusFinished` — but **mobile-sourced tasks always land in `review`** (`tasks.go:1252-1255`) | `tasks_video_summary.go:42` | **Mobile tasks never get a demo clip today even with the toggle ON.** Highest-value one-line fix in this doc. |
| B2 🔴 | `VideoClipID/VideoStatus/WorkDir` not in `persistedTask` | `store.go:14-35` | daemon restart orphans the proof link |
| B3 🔴 | Kotlin & Swift feedback SDKs POST `application/json`; agent handler is multipart-only → 400 | `YaverFeedback.kt:170`, `YaverFeedback.swift:234` vs `feedback_http.go:91` | **kt/swift SDKs cannot file a report at all today**; C8 requires the JSON ingest branch anyway |
| B4 🔴 | `feedback_fix` with `taskMgr == nil` returns `{"ok":true}` with no taskId (documented false green, `CLAUDE.md`) | `feedback_http.go:462-468` | the feedback→task→proof chain must not inherit this |
| B5 🔴 | `launch-feedback` with no DataChannel returns `{"ok":true,"status":"accepted"}` | `remote_runtime.go:1825-1848` | same class |
| B6 🔴 | Web SDK `.webm` video/audio written to disk but never routed into the report (extension switch lacks webm) | `feedback.go:268-275` | web-SDK proof/media invisible |
| B7 🔴 | RN SDK captures `errors[]` but `uploadFeedback` never serializes them | `sdk/feedback/react-native/src/upload.ts:23-54` | timeline data silently dropped |
| B8 🔴 | `ClipsPane` posters fetch an `authSDKOrGuest` route via `agentAssetUrl` (no auth) → 401 over relay | `WorkspaceShell.tsx:396`, `agent-client.ts:3646-3649` | broken poster grid |
| B9 🔴 | Feedback↔task link only exists in candidate mode (`ChangeSet.TaskID`, `feedback_http.go:448-451`); no reverse `Task.FeedbackID` | `feedback.go:128`, `tasks.go` | C8 needs the bidirectional key |
| B10 | 💀 `record_*` + `morning_*` verbs advertised, unimplemented | tool roster vs `mcp_tools.go` | delete the declarations (per `tasks/recap-ops-and-honesty.md:97`), don't reimplement |
| B11 | No retention on `~/.yaver/vibe-preview/clips`, `~/.yaver/clips`, `~/.yaver/feedback/` | §3 | per-task proof accumulates unbounded |
| B12 | `videoStatus: "failed"/"stale"` renders nothing on mobile (chip handles ready/recording/queued only) | `tasks.tsx:6291-6306` | violates C6's "proof failure is a named cause" |
| B13 | Black box: dir created never written; 1000 events RAM-only; task correlation by bare platform string | `blackbox.go:68-74,130-137`, `feedback_http.go:317-329` | timeline source needs snapshot-at-completion + real key |
| B14 | Web parity drift: `page.tsx` chat has review→Complete + detail-hydration guard; `VibeCodingView` has the video chip; neither is a superset; a `review` task in Vibing tab is a dead end; no `?task=` deep link | §"web" agent report | build the card once as a shared component |

---

## 8. Current completed-task UX (what the user literally sees)

- **Mobile** (`tasks.tsx`): green flip + haptic + optional TTS; final bubble
  indistinguishable from mid-task bubbles except `tokens used N`; the only proof
  affordance is an 11pt "▶ Watch demo" text chip **above** the chat
  (`:6289-6306`, with hardcoded hex, violating the `agentStatus.ts` doctrine).
  `ListFooterComponent` (`:6344-6482`) has a **rich failure card**
  (`ErrorMessage.tsx`) and **nothing for success** — the clearest asymmetry.
  `VibePreviewModal.tsx` (hero video/frame swap + poster clip strip + event
  timeline) is complete and has **zero importers**.
- **Web**: emerald dot; subtitle literally `` `${status} · ${path}` ``. The
  richest completion UI in the product is `DeepAskGraphPanel`'s step list +
  "Final answer (cross-checked)" emerald card (`VibeCodingView.tsx:3352-3418`) —
  graph runs only. `WebTestsPanel.tsx:562-700` already has a mime-dispatched
  artifact viewer + Playwright trace timeline — the reusable timeline/media code.
- **Feedback SDK**: fire-and-forget. No return channel renders anything.
- **The claude.ai artifact was hand-authored** — `e2e/false-positive-selenium.mjs`
  emits only an MP4 + `VIDEO=`/`VERDICT=` stdout lines; no showcase generator
  exists anywhere in the repo.

---

## 9. Recommended architecture — the Proof Package

One artifact, three renderers (C1/C8/C9). Everything below names the existing
seam it plugs into.

### 9.1 Data: `TaskProof`, stored beside the clip, linked from the task

```
~/.yaver/vibe-preview/clips/<project>/<clipID>.mp4        (exists)
~/.yaver/vibe-preview/clips/<project>/<clipID>.poster.jpg (exists)
~/.yaver/proofs/<taskID>/proof.json                        (new)
~/.yaver/proofs/<taskID>/summary.md                        (new — narrative body)
~/.yaver/proofs/<taskID>/before.png / after.png            (new — copied frames)
```

`proof.json` (all fields optional except id/taskId/status):
`{taskId, turnIndex?, status: capturing|ready|failed, failedReason?, lane:
browser|sim-ios|sim-android|webrtc|phone, clipId, posterUrl, commit: {sha,
subject, branch, filesChanged, insertions, deletions}, beforeHash, afterHash,
visualDiffText, verdict?: TRUE-GREEN|…, durationSec, createdAt}` — reusing the
recap claims/evidence split: `verdict`/`commit` are evidence fields, `resultText`
stays a claim. Follow `VibeClipRecord`'s `json:"-"` discipline: **paths never on
the wire, only routes** (`vibe_preview.go:145-146` precedent; the feedback API's
absolute-path leak at `feedback.go:44,47` is the anti-pattern).

Task gains `ProofID`/`ProofStatus` (persisted — fix B2 in the same change),
written back via the `SetTaskVideoState` mutation pattern (`tasks.go:4459`).

### 9.2 Generation: extend `MaybeRecordTaskSummary`, don't replace it

At `main.go:3846`, in order (each step degrades independently, C6):
1. **Lane pick** — capability-probed, browser-first (§6). Fix B1 (`review`
   counts as success) and the sim-over-browser preference in the same change.
2. **Record** — existing clip machinery + exerciser. Browser lane: the recording
   *is* the automation drive (the artifact pattern).
3. **Evidence collect** — commit SHA + shortstat from `autoPushAfterTask` (§2.3);
   `QueueSummary` for before/after + one-liner (§4.2); optional black-box
   snapshot into the proof dir (B13).
4. **Narrative** — deterministic MD draft from `ResultText` + evidence fields
   (recap's draft-then-optional-LLM-polish pattern, `recap_script.go`); MD renders
   natively in both chat surfaces (C3).
5. **Emit** — `task_proof_ready` (or `_failed` with `failedReason` + route) on
   `eventCh`; enrich `TaskInfo` with `proofUrl` (copy `enrichTaskInfoVideo`).
6. **Prune** — port `pruneRecaps` to clips + proofs, success and failure paths.

Toggle: keep the existing `VideoEnabled` wire field; rename surface copy from
"Record Demo Video" to proof language; surface it in the composer (today it's
buried in Settings), still **default OFF** (C5).

### 9.3 Serving

`GET /tasks/{id}/proof` → proof.json with absolute routes (authSDKOrGuest +
relay allowlist + a `proof` scope prefix for SDK tokens). Media via the existing
clip routes. Web uses the `/d/<deviceId>/` proxy for seekable plain-src video.

### 9.4 Rendering (C9)

- **Mobile:** `TaskProofCard` in `tasks.tsx` — compact card (poster + play
  overlay + one-line summary + commit chip) at `ListFooterComponent` first
  (upgrade path: `kind`-discriminated inline message later); tap → overlay sheet
  built from `VibePreviewModal.tsx` re-themed to `useColors()`/tokens (no
  hardcoded hex). Subscribe `clip_ready`/`task_proof_ready` instead of polling.
  Handle `failed/stale` with named cause + route (B12). Memoize like `ChatBubble`.
- **Web:** same card as a **shared component** mounted in *both* chat surfaces
  (B14), opening a modal overlay; hero video via proxy src; before/after chips
  from frame hashes; timeline from `WebTestsPanel`'s trace-timeline shape;
  verdict pills use the closed-loop taxonomy vocabulary
  (`docs/architecture/CLOSED_LOOP_FALSE_POSITIVE_TESTING.md`).
- **Feedback SDK (C8):** on fix-task completion, push `fix-proof-ready`
  {feedbackId, taskId, proofUrl} down the existing channels — blackbox
  `command-stream` SSE for SDK apps, the `remote-runtime-feedback-v1`
  DataChannel for streamed apps (fix B5's false green first) — and render a
  "your fix is ready → ▶ see proof" overlay in the SDK (it already owns an
  overlay). Requires the bidirectional task↔feedback key (B9) and the JSON
  ingest branch (B3). SDK-token auth scoped to that one proof.

### 9.5 What NOT to build

- No HTML generator as the primary vehicle (C3) — optional later export can reuse
  `test_report_cmd.go`'s self-contained-HTML pattern + the public
  `web/app/artifacts/[token]` route for sharing.
- No reimplementation of `record_*`/`morning_*` (B10).
- No Convex writes beyond a counters-only pointer if ever needed
  (`TestRecapConvexPayload_isCounterOnly` precedent).
- No second recording path — the render pipeline's "one final render" moment is
  the capture moment (C4).

---

## 10. Phasing (each phase ships value alone)

| Phase | Content | Mostly |
|---|---|---|
| P0 | Fix B1 (review clips), B2 (persist clip link), B12 (failed/stale named) — the existing feature starts working for mobile users | 3 small agent diffs |
| P1 | Evidence collection (commit SHA/shortstat, `QueueSummary` wire-up) + `TaskProof` record + `/tasks/{id}/proof` + `task_proof_ready` event | agent |
| P2 | Mobile `TaskProofCard` + overlay (from `VibePreviewModal`) + `clip_ready` subscription; composer-level toggle | mobile |
| P3 | Web shared card + modal in both chat surfaces; proxy-src video; fix B8, B14 | web |
| P4 | Lane picker browser-first + capability probes + named refusals (§6); Flutter compile-check guard | agent |
| P5 | Feedback-SDK return channel: B3, B5, B9 fixes + `fix-proof-ready` push + SDK overlay | agent + SDKs |
| P6 | Retention (B11), durable share, optional HTML export | agent |

Guards to prove by breaking (house rule): a proof-required task that produces no
clip must **fail visibly** (disable the recorder, watch the named failure render);
the SDK proof push with no listener must **not** report ok (B5's mirror); the
parity test for the shared web card in both surfaces.

---

*Sources: five parallel deep-read agent reports (recording infra; task lifecycle;
mobile UI; web UI + reports; feedback SDK e2e), 2026-07-28. Where a claim matters,
re-grep before coding — several findings here (zero-importer files, phantom verbs,
false greens) are exactly the kind of thing another session may have already
changed.*

---

## 11. Implementation status (landed 2026-07-29, this working tree)

P0–P3 + P5 shipped in one pass; verified by `go build`, guard tests (each
proven by breaking), `tsc --noEmit` (mobile, both SDKs), and `npm run build`
(web). What landed:

**Agent** — `task_proof.go` (TaskProof record at `~/.yaver/proofs/<taskID>/`,
built at the OnTaskDone seam, named capture failures, bounded clip waiter,
`task_proof` SSE event, retention pruning for proofs AND the clip store),
`task_proof_http.go` (`GET /tasks/{id}/proof` + `GET /feedback/{id}/fix-proof
[/video|/poster]` for feedback-scoped SDK tokens), commit evidence stamped in
`autoPushAfterTask`, wire DTO carries `proofStatus/proofUrl/commitSha/
commitSubject/commitBranch/diffShortstat/feedbackId`. Fixed: **B1** (review
counts as success — mobile tasks get clips), **B2** (video/proof/workdir
persisted), **B4** (nil-taskMgr fix is now a named 503), **B6** (webm
routing), **B9** (task↔feedback join both directions, every mode), plus
browser-lane preference per C7 (a live browser clip outranks sim detection).
Guard tests: `task_proof_test.go`.

**Feedback lane (C8)** — `feedback_http_json.go` accepts the kt/swift
`application/json` + data-URI shape (**B3** fixed); agent broadcasts
`fix-proof-ready` (delivered-count logged); RN + web feedback SDKs consume it
filtered to reports the device itself filed (`filedReportIds`), with
`onFixProofReady` config callback, event emit, and a zero-integration default
alert. kt/swift SDK *push* consumption is still pull-only (the fix-proof
endpoint serves them); their in-app overlay is follow-up work.

**Mobile** — `TaskProofCard.tsx` (memoized, tokens-only theming) in the task
thread footer; proof overlay grown out of the existing video modal (player +
summaryMarkdown + commit/diff chips + lane caption); `task_proof` SSE branch;
**B12** fixed in card, chip strip, and overlay (named causes for
failed/stale; chip's hardcoded hex also fixed); `taskProofStatus.ts` mappers
with an `npx tsx` test (B12 guard proven by breaking). Settings toggle
renamed "Require Proof of Work" (still default OFF).

**Web** — shared `TaskProofCard.tsx` mounted in BOTH chat surfaces (B14 for
this feature), modal overlay with `/d/<deviceId>/` proxy video src (real
Range/seek) + blob fallback, verdict pills, `AssistantMarkdown` narrative;
**B8** fixed (ClipsPane poster auth); poll change-detection extended to proof
fields.

**Found during implementation:** BOTH web and mobile task mappers were
dropping the `video*` fields entirely — the shipped "▶ Watch demo" chip was
data-dead on both surfaces. Fixed in `web/lib/agent-client.ts` and
`mobile/src/lib/quic.ts`.

**Still open (from §10):** P4 capability-probed lane picker + named refusals
(detection is still workdir-sniffing; the browser-marker preference is the
first step), Flutter compile-check guard, QueueSummary/before-after wiring,
durable-share surface, optional HTML export, kt/swift SDK proof overlays,
`record_*`/`morning_*` phantom-verb deletion (tool-roster side), B5
(launch-feedback DataChannel false green), B13 (black-box persistence).
