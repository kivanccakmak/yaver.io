# Signal Wiring Matrix

**Snapshot: 2026-07-27.** Built by reading the code, not the docs. Every row
carries `file:line` so the next drift is one `grep` away.

> **This file is a map, not a contract.** Per the repo rule at the top of
> `CLAUDE.md`: when this document and the code disagree, **this document is the
> bug**. Re-grep before acting on any row, and fix the row in the same change.

## How to read it

A signal is *plumbed* when a producer sets it, a transport carries it, and a
consumer **renders or acts on it** on every surface where it is meaningful.

| Mark | Meaning |
|---|---|
| ✅ | Produced, carried, and rendered/acted on |
| ⚠️ | Partial — parsed but not rendered, or rendered on some surfaces only |
| ❌ | Missing — producer sets it and nothing reads it, or a consumer reads what nothing sets |
| n/a | Genuinely not applicable, **with the reason stated** |

Surfaces: **mob** (RN phone/tablet — also car `app/car-voice-coding.tsx` and
glass `app/glass-*.tsx`, which share `DeviceContext`/`AuthContext`), **web**,
**tv** (tvOS), **watch** (watchOS), **wear** (Wear OS), **cli** (the Go binary),
**sdk** (`sdk/feedback/*`).

### The four failure shapes this matrix exists to make visible

1. **Dead signal** — a producer field no consumer reads.
2. **Dead UI** — a consumer field no producer sets.
3. **Twin drift** — mobile/web copies of one pure module diverging.
4. **Silent no-op** — a signal that reaches one surface and is dropped on another.

A fifth, subtler one keeps recurring and deserves naming: **a guard that asks a
file-level question about a per-item obligation**. Both examples found in this
pass were *green* while broken (`taskStreamWithRecovery.test.ts` counted one
`onEnd` for two call sites; the resume tests used ASCII fixtures for a
UTF-8/UTF-16 bug).

---

## 1. Stream recovery — task output SSE

Producer: `desktop/agent/httpserver.go:4946` `streamOutput`.
Frames: `resume` `:5020`, `output` `:5029`, `done` `:5039`/`:5090`,
`agent_question` `:5052`. Cursor helper: `desktop/agent/stream_cursor.go`.

| Signal | Producer | mob | web | tv | watch/wear | Notes |
|---|---|---|---|---|---|---|
| `?since=` byte cursor | `httpserver.go:4988-5034` | ✅ `app/(tabs)/tasks.tsx:2426` | ✅ `web/lib/taskStreamWithRecovery.ts:79` | ✅ `tvos/YaverTV/AgentClient.swift` | n/a — no task transcript surface | **FIXED this pass.** Clients counted UTF-16, Go slices UTF-8 bytes |
| `resume.offset` | `httpserver.go:5021-5023` | ✅ adopted | ✅ adopted | ❌ tvOS still counts locally | n/a | **FIXED for mob/web this pass** |
| `output.offset` | `httpserver.go:5030-5032` | ✅ | ✅ | ❌ not read | n/a | **ADDED this pass** — the authoritative cursor |
| `resume.full` | `httpserver.go:5023` | ✅ `tasks.tsx:2469` | ✅ `taskStreamWithRecovery.ts:92` | ⚠️ unverified | n/a | |
| `onEnd` → recovery ladder | client-side (`taskStreamRecovery.ts`) | ✅ all call sites | ✅ all call sites | ✅ `FailureSignals.swift:231` | n/a | **FIXED this pass** — `dogfood.tsx` + `VibeCodingView.tsx` graph tail were bare |
| `/dev/events` cursor | ❌ **no `since` support** — `devserver_http.go:2567` accepts only `?fresh=` `:2608` | ⚠️ reattaches with no cursor `quic.ts:2396` | ⚠️ same | ⚠️ same | n/a | Duplicates prevented by `fresh` semantics, not an offset |

**Twin:** `taskStreamRecovery.ts` — byte-identical below header. Parity test
✅ `web/lib/taskStreamRecovery.test.ts:135`. Mobile has **no** test file of its
own for this module.

**Known drift, not fixed:** tvOS carries a *third* implementation
(`tvos/YaverTV/FailureSignals.swift:182-255`) with the same shapes and
**different wording** — `:241` "The work is still running on the box" vs the TS
twins' "The task is still running on the box"; `:242` "Use Try again to
reattach" vs "Use Reattach to try again". No cross-language parity test exists.
Mobile's `/dev/events` ladder (`quic.ts:2382-2393`) hand-writes a **fourth**
wording instead of calling `planStreamRecovery`.

---

## 2. CapabilityGap / GapFix

Producer: `desktop/agent/capability_gap.go` — `CapabilityGap` `:99-122`,
`GapFix` `:63-80`, `GapConfirm` `:85-88`, `CapabilityResource`
`capability_resources.go:77-96`. Platform predicates
`capability_platform.go:173-388`.

**Wire-name split (by design, but sharp):** HTTP bodies use `capabilityGap`;
the SSE `/dev/events` error frame uses **`gap`** (`devserver.go:215`). Three
different TS entry points exist and calling the wrong one silently yields null
(`capabilityGap.ts:192/198/205`).

| Field | Producer | mob | web | tv | Notes |
|---|---|---|---|---|---|
| `summary` / `detail` | `capability_gap.go:101-102` | ✅ | ✅ | ✅ | |
| `fix.label/path/stream/est/retry` | `:63-68` | ✅ `capabilityGapFix.ts:57` | ✅ `PreviewPane.tsx:1261` | ✅ `WebPreviewStreamView.swift:173` | |
| `constraint` | `:104` | ✅ | ✅ `PreviewPane.tsx:2117` | ✅ `:153` | ⚠️ **not** in `RuntimeLabView.tsx:2300-2311` |
| `warning` | `:112` | ✅ `DevPreview.tsx:1090` | ⚠️ `PreviewPane.tsx:2101` only | ❌ | Missing on `RuntimeLabView` and tvOS |
| `resource.*Human` | `capability_resources.go:83-93` | ✅ | ✅ | ❌ | |
| `resource.*Bytes` (6 fields) | `:82-92` | ❌ parsed, never rendered | ❌ same | ❌ | **Dead.** The whole low-RAM measurement (`ramNeedBytes`, `ramTotalBytes`, `firstBuildBytes`) never reaches a pixel; RAM survives only as prose inside `warning` |
| `resource.level` | `:95` | ❌ | ❌ | ❌ | Read only by `gapIsDiskBlocked` (`capabilityGap.ts:281`), which has **0 call sites** |
| `reclaim` (`*GapFix`) | `capability_gap.go:122` | ⚠️ label-only → `router.push("/storage")` | ✅ `ReclaimPanel.tsx` | ❌ | |
| `fix.confirm` / `GapConfirm` | `:80-88` | ❌ parsed then discarded | ✅ `ReclaimPanel.tsx:29` | ❌ type absent | |
| `capability` | `:100` | ❌ parsed, rendered nowhere | ❌ | ❌ | **Dead on all three** |
| `code` | `:99` | ⚠️ non-empty gate only | ⚠️ same | ⚠️ same | The documented "clients look up a code" rule (`capabilityGap.ts:18`) is unimplemented — the constants have 0 import sites |

**Twin:** `capabilityGap.ts` — byte-identical below header. Parity test ✅
`mobile/src/lib/capabilityGap.test.mts:249`.

**Surfaces with zero CapabilityGap support:** watch, wear, sdk, car, glass.

**tvOS structural gap:** `FailureSignals.swift:94` **requires a non-empty
`stream`**, so every confirm-gated streamless fix — i.e. every reclaim route Go
emits — is dropped at parse time. Combined with the `reclaim`/`warning`/
`resource` rows above, the entire disk-pressure lane is invisible on Apple TV.

**Fully dead struct:** `capabilityPlatformRow` (`capability_platform.go:488-497`,
8 json tags) — its only builder `capabilityPlatformRows:499` has **no non-test
caller**, no route, no consumer.

---

## 3. Screen context

Producer: `desktop/agent/screen_context.go:81-108`. Probe injected into both
preview lanes (`build_web.go:805`, `devserver_basehref.go:227`). Route
`httpserver.go:970` (`s.auth`). Prompt hook `screen_context_turn.go:38` →
`task_prompt_frame.go:236`. MCP verb `mcp_tools.go:3894`.

| Surface | Sends the observation? | Evidence |
|---|---|---|
| web | ✅ | `ScreenContextChip.tsx:71` → `agent-client.ts:1928`; parser `web/lib/screenContext.ts:67` |
| **mob** | ❌ **DEAD** | Probe posts via `ReactNativeWebView.postMessage` (`screen_context_probe.js:224-225`) with `lane:"webview"` — a branch that exists *only* to serve the RN app. The only WebView handler (`DevPreview.tsx:1027-1046`) matches `yaver-preview-probe`, `yaver-preview-timeout`, `yaver-rendered` and lets `yaver-screen` fall into `catch {}`. No `screenContext.ts`, no chip, no `reportScreenContext` anywhere in `mobile/` |
| tv / watch / wear / cli / car / glass | ❌ | zero references |

**This is the single largest cross-surface hole found in this pass.** The Go
side went out of its way to support React Native and the RN side drops it, so a
phone user gets no screen context at all — and, because there is no chip, no way
to see or switch off a feature the web user can. Consumption
(`task_prompt_frame.go:236`) is surface-agnostic; only delivery is web-only.

Other findings: `capturedAt` (`screen_context.go:103`) is written and read by no
client. `lane:"native"` is accepted by Go `:152` and by
`web/lib/screenContext.ts:93` but **no producer can emit it**. The clamp
constants (`screenContext.ts:38-41`) are duplicated from Go and pinned by
nothing. `web/lib/screenContext.test.ts:167` asserts the chip's *source text*
contains `reportScreenContext` — a string-presence check, not behaviour.

---

## 4. Compile failure / preview phase

| Signal | Producer | mob | web | Notes |
|---|---|---|---|---|
| `status.error` compile detail | `devserver.go:1737`, `devserver_start_remedy.go:119-174` | ✅ `apps.tsx:3452`, `DevPreview.tsx:1063` | ✅ `PreviewPane.tsx:805`, `RuntimeLabView.tsx:1283` | |
| Failure vocabulary | `devBuildFailureLine` — 8 needles `devserver_start_remedy.go:124-133` | ✅ | ✅ | **FIXED this pass** — TS matched only 4; `module build failed`, `bundling failed`, `unable to resolve module`, `the following build commands failed` produced **no card** on the tail-only path. Now pinned by reading the Go list |
| `previewPhaseTitle` | probe reasons from `previewReadyScript.ts:138-147` | ✅ full probe | ⚠️ `PreviewPane.tsx:1881` passes `null` — the iframe is cross-origin, so 4 of 6 outputs are unreachable | Documented at `web/lib/previewPhase.ts:9-12` |
| `previewTimeoutExplanation` | same | ✅ `DevPreview.tsx:1036`, `apps.tsx:3339` | ❌ **dead** — defined `web/lib/previewPhase.ts:56`, called only by a test | Web PreviewPane has no render-probe/timeout narration at all |
| `DevServerEvent.Phase` (18 distinct values) | `devserver_progress.go:15`, `devserver.go:1488`, `webtransport.go:116/153/185`, `trial_bootstrap.go:85-109` | ❌ | ❌ | **Largest emits/ignores gap.** `previewPhase.ts` switches on `probe.reason` only and never reads `Phase`, `Topic`, `Pct` or `ProgressSrc`. Five emitted values (`done`, `serving`, `streaming`, `delivered`, `rendering`, `starting-dev-server`) are not even in the documented taxonomy |

**Twins:** `compileFailure.ts` — parity test ⚠️ `web/lib/compileFailure.test.ts:68`
compares **only the `COMPILE_LINE` line**; `relevantLines`, the `slice(-8)` cap,
the `isCompile` regex and both titles are unchecked. `previewPhase.ts` — parity
test ✅ **added this pass** (`mobile/src/lib/previewPhase.test.mts`); previously
**none**, and web has no test file for the module at all.

---

## 5. Relay deny / limits

Producer: `relay/server.go:1088/1093/1098`, `relay/bandwidth.go:161`,
`relay/counting_writer.go:11`, `relay/abuse_guard.go:388`. All travel as
free-form prose in `{"error": …}` — there is **no json tag anywhere in this
family**, which is why every consumer substring-matches.

| Reason | mob | web | tv/watch/wear | Notes |
|---|---|---|---|---|
| `reason=device_mismatch` | ✅ `DeviceContext.tsx:2110` | ✅ `reconnectLadder.ts:33` | ❌ | |
| `reason=dead_token` | ✅ | ✅ | ❌ | **FIXED this pass.** `explainRelayDeny` returned null, so web's ladder retried an unrecoverable session forever; mobile had an ad-hoc raw substring check at `DeviceContext.tsx:2651` |
| `reason=bad_password` | n/a — healable by the repair rung, so a terminal explanation would be wrong | | | Asserted intentional |
| bandwidth cap (with figures) | ✅ | ✅ | ❌ | |
| **mid-stream** cap cut | ✅ | ✅ | ❌ | **FIXED this pass.** Carried no digits so it matched no branch — while the card's own copy promised to explain exactly that case |
| free-tier / generic rate limit | ✅ | ✅ | ❌ | `abuse_guard.go:388` is not pinned by any test |

**Twin:** `relayDeny.ts` — byte-identical below header. Parity test ✅
`web/lib/relayDeny.test.ts:71`, plus **new** this pass: a sweep that enumerates
every `reason=` literal in `relay/server.go` and fails on any that is neither
explained nor declared healable. Mapping reasons one at a time is how the second
one was forgotten.

`RelayDenyReason` (`server.go:661-662`) has no `bad_password` constant despite
the literal being emitted at `:1098` — the enum and the strings are two sources
of truth.

---

## 6. Power / reboot

| Signal | Producer | mob | web | tv/watch/wear/cli |
|---|---|---|---|---|
| `PowerAction` (12 fields) | `power_capability.go:101-127` | ⚠️ `quic.ts:738` types only `id` | ⚠️ same | ❌ none |
| `etaSeconds` | `infra_http.go:396` | ✅ | ✅ | ❌ |
| `PowerActionFacts.uid/container/wslVersion/agentUser` | `power_capability.go:85-95` | ❌ | ❌ | ❌ |
| `RebootProgress` (7 json tags) | `reboot_recovery.go:75-91` | ❌ | ❌ | ❌ |

**`RebootProgressFor` (`reboot_recovery.go:94`) has no non-test caller in the
entire Go tree.** Every json tag on `RebootProgress` is serialized by nothing.
The state machine exists three times — Go (unreachable, with its own test
suite) and both TS twins (live) — and nothing compares across the boundary.
`RebootProbe` (`:58-71`) has **no json tags at all**, so it could not be
accepted over the wire even if a route existed.

**Twin:** `powerProgress.ts` — byte-identical below header. Parity ⚠️: both
tests run the *same 6-row contract table* through `rebootProgressFor` and assert
`phase`+`done` — real behaviour on shared inputs, but the table is **duplicated,
not shared**, and neither file reads the other or the Go test it claims to
mirror. Both header comments mis-name the peer file.

---

## 7. Storage pressure / reclaim

Routes: `/storage/scan` `httpserver.go:594`, `/storage/reclaim` `:595`
(`storage_reclaim_http.go:38`, no `ids` → 400, no `confirm` → dry run).
Push: `storage_pressure.go:41` → `device_broadcast_command`.

| Signal | Producer | mob | web | tv/watch/wear |
|---|---|---|---|---|
| `storage_pressure` broadcast | `storage_pressure.go:65-90` | ⚠️ `app/(tabs)/_layout.tsx:307` | ❌ | ❌ |
| ↳ `deepLink: "yaver://storage"` | `:68` | ❌ **discarded** — `_layout.tsx:323` hardcodes `router.push("/(tabs)/devices")` | ❌ | ❌ |
| ↳ `reclaimableBytes`, `usedPct`, `freeGb` | `:77-84` | ❌ only the pre-formatted `reclaimable` string is read | ❌ | ❌ |
| `ReclaimResult.dryRun` / `.freedBytes` / `.rootFreeGbBefore` | `storage_reclaim.go:109-115` | ❌ | ❌ | ❌ |
| `ReclaimOutcome.freedBytes` / `.path` | `:101-102` | ❌ consumers filter on `.ok` only | ❌ | ❌ |
| diskguard verb results (8+ fields each) | `ops_diskguard.go:110-165` | n/a — MCP/agent-only by design | n/a | n/a |

**"The box is 95% full" is phone-only.** On web, tvOS, watch and Wear it is
invisible until a build dies.

**Three divergent TS shapes for one Go `ReclaimTarget`:**
`StorageSection.tsx:28` (complete), `DeviceStorageFold.tsx:27` (**missing
`kind`, `action`**), `ReclaimPanel.tsx:31` (**missing `kind`, `lastUsedMs`,
`action`**). Also `carSurfaceIntent.ts:489` reads `root?.freeGB` — no producer
emits that spelling (`freeGb`, `diskhealth.go:45`), so that fallback is dead.

---

## 8. Prompt framing

| Signal | Producer | mob | web | Notes |
|---|---|---|---|---|
| `Task.PromptText` | `tasks.go:1044` | n/a | n/a | Persistence only; `TaskInfo` deliberately has no such field, pinned by `prompt_display_invariant_test.go:106` ✅ |
| `TaskCreateOptions.PromptText` | `tasks.go:915` | n/a | n/a | **No json tag** — transport-only by design |
| Boundary sentinel + markers | `result_cleanup.go` | ✅ | ✅ | Both twins pinned to the **Go source** independently |
| Native system-prompt channel | `task_prompt_frame.go:115` | ✅ | ✅ | ⚠️ whitelist of exactly one runner: `claude`. codex/opencode keep the in-band path |

**Twin:** `promptFraming.ts` — behaviourally identical (comment-only diff).
Parity ⚠️: there is **no TS↔TS test**. Both twins pin to
`desktop/agent/result_cleanup.go` separately, so they could drift from each
other while both still matching Go. Web's test omits the `extra`-marker check
mobile has (`promptFramingParity.test.ts:74`). `containsYaverFraming`'s marker
list is hardcoded in both twins and asserted against **nothing** in Go — if Go
renames a marker the readback guard silently stops firing on both surfaces.

---

## 9. Session expiry

| Surface | Own-session notice | Box-session notice |
|---|---|---|
| mob | ✅ `sessionExpiredNotice.ts:15` → `login.tsx:548` | ✅ |
| web | ⚠️ inlined JSX at `dashboard/page.tsx:2517`, **no module** | ✅ `use-devices.ts:561` |
| tv | ⚠️ literal duplicated ×5 in `MachineRegistry.swift` | ✅ |
| watch | ❌ **none** | ⚠️ `BoxLifecycle.swift:223` |
| wear | ❌ **none** | ⚠️ comment only, `BoxLifecycle.kt:84` |
| cli | ✅ `main.go:5751` | |

Four different sentences for one event. `mobile/src/lib/sessionExpiredNotice.ts`
exists *specifically* to reach parity with web — and web never got the module.

**JSON spelling mismatch:** `needsAuth` (`ping_cmd.go:270`,
`remote_status_cmd.go:53`, `ops_machine_doctor.go:103`,
`mcp_primary_tools.go:176`) vs **`needs_auth`** (`mcp_auth_tools.go:57`) vs the
kebab state literal `"needs-auth"` (`tasks.go:688`, `wakeMachineCore.ts:82`) —
three wire spellings of one concept.

`relay_session_expired_at` (`config.go:62`) is written at `main.go:11455` and
read by nothing.

---

## 10. Feedback-SDK reload buttons

Canonical seam `sdk/feedback/web/src/reloadActions.ts`, ported to
react-native, browser-extension, swift, kotlin, flutter, unity.

| Port | `rebuild` action | 401/403 copy | Verdict |
|---|---|---|---|
| web / RN / swift / kotlin / flutter / unity | ✅ | "sign in again, or re-pair this device" | ✅ consistent |
| **browser-extension** | ❌ absent (`reloadActions.js:136-155`) | ❌ "check the auth token in the settings below" | **A fork, not a port** — also diverges on status-0 and not-connected copy, and adds an `isDevAgentUrl` helper with no peer |

**No test in the repo reads two ports and compares them.** Each of the seven
suites pins its own local wording, so the extension's divergence is not a
failing test — it is a *passing* one. `test/reloadActions.test.js:89` explicitly
pins the *absence* of `rebuild`.

Field notes: the reload seam models only `running`/`building`/`framework`;
`serving`, `servingLabel`, `stopActionLabel`, `targetDevice*` and `iosInstall*`
(`devserver_http.go:1387-1395`) are unread by it. `framework` is **absent** from
the nil-status payload, so every SDK renders generic labels when no server runs.
`normalizeDevReloadMode` (`devserver_http.go:2026`) maps any unknown mode to
`fast` — an SDK that mis-routed `rebuild` to `/dev/reload` gets a silent hot
reload.

---

## Twin-pair register

The repo rule is one parity test per twin pair. Status after this pass:

| Pair | Behavioural drift | Parity test | Kind |
|---|---|---|---|
| `capabilityGap` | none | ✅ `capabilityGap.test.mts:249` | byte-identity |
| `relayDeny` | none | ✅ `relayDeny.test.ts:71` **+ new Go-reason sweep** | byte-identity + wire contract |
| `taskStreamRecovery` | none | ✅ `taskStreamRecovery.test.ts:135` | byte-identity |
| `previewPhase` | none | ✅ **added this pass** | byte-identity |
| `compileFailure` | none | ⚠️ `compileFailure.test.ts:68` — **one line only**; **+ new Go-vocabulary contract** | partial |
| `powerProgress` | none | ⚠️ duplicated contract table, no cross-file read | behavioural, unshared |
| `promptFraming` | none | ⚠️ both pinned to Go, **no TS↔TS check** | indirect |
| `aliasShadowing` | n/a | n/a | mobile + `backend/convex` only; web has no device-alias collapse |
| `composerKeys` / `composerNewline` | n/a | ⚠️ asymmetric — web has the module, mobile inlines the logic in `tasks.tsx`; `composerNewline.test.mts:83` reads web's file to pin it | |
| `FailureSignals.swift` (tvOS) | **YES — wording** | ❌ none | third twin, undocumented |
| `reloadActions` ×7 SDK ports | **YES — extension** | ❌ none | seven twins, zero cross-port tests |

---

## Open items (found, not fixed)

Ordered by user impact. Each is a real break with a location.

1. **Screen context never reaches mobile** — §3. The Go probe has an explicit
   React-Native branch (`screen_context_probe.js:224`) with no RN consumer.
2. **tvOS drops every streamless fix** — `FailureSignals.swift:94` — hiding the
   whole disk-pressure lane on Apple TV (§2).
3. **`DevServerEvent.Phase`: 18 emitted values, zero TS consumers** (§4).
4. **`RebootProgressFor` is unreachable Go** with a live test suite (§6).
5. **`storage_pressure` is phone-only**, and its `deepLink` is discarded (§7).
6. **`previewTimeoutExplanation` is dead on web** (§4).
7. **Watch/Wear have no own-session-expiry surface** (§9).
8. **The browser-extension reload port is a fork with a passing test** (§10).
9. **tvOS/mobile stream-recovery wording drift** — four sentences, one policy (§1).
10. **`resource.*Bytes` and `resource.level` render nowhere** (§2).

## Verification status

`go build ./...`, `cd mobile && npx tsc --noEmit`, `cd web && npm run build` all
pass. Go tests were run scoped (`-run`), per the repo rule. Every `.test.ts` /
`.test.mts` touched or added in this pass was run, and each **new guard was
proven by breaking it and watching it fail**.

**Not verified locally, and stated as such:** tvOS, watchOS and Wear OS rows are
read from source only — those toolchains were not built. Live-agent behaviour
(a real relay bounce, a real disk-pressure push) was not exercised; the SSE
contract rows are pinned by tests against `httptest` servers, not a running box.
