# tvOS vibing parity — every missing plumbing, web → TV (2026-07-27)

Companion to `tv-vibing-scope-wall-deep-analysis-2026-07.md` (the wall + the
fix). This doc is the **complete parity ledger**: what the web dashboard's
vibing loop (`web/components/dashboard/RuntimeLabView.tsx`) does, what the TV
does today, and every piece of plumbing between them — ranked by what makes
the couch experience feel like the web one. "Plumbing" here always means the
four failure-plumbing layers (detection / signal / UI / route-to-fix) plus the
happy-path seam itself.

The design constraint that shapes everything: **tvOS has no WebKit and no
keyboard.** The web loop is iframe + typing; the TV loop is pixels + voice/
remote. Parity means *capability* parity, not widget parity.

## 0. The target loop (what "vibing as in webui" means)

Web's loop: type a prompt → runner turn streams → preview (iframe) hot-reloads
→ read the diff/log → next prompt. One screen, no navigation.

TV's target loop: **watch the preview full-screen → press a button / speak →
prompt goes to the RUNNER box → turn progress narrates on-screen → HMR lands
in the frame stream → next prompt.** One screen, no navigation. Everything
below serves that sentence.

## 1. Parity matrix

| # | Web vibing capability | Where (web/agent) | TV today | Gap class |
|---|---|---|---|---|
| 1 | Prompt → session turn from the SAME screen as the preview | RuntimeLabView chat + iframe | ❌ SessionView and WebPreviewStreamView are separate screens; no prompt on the preview | **the loop itself** |
| 2 | Streamed runner output during a turn | web SSE tail | ⚠️ SessionView polls `pane` snapshots via `/runner/session/turn` waitMs; no stream | latency/feel |
| 3 | Preview surface | iframe (direct DOM) | ✅ pixel poll (300 ms, hash-gated) — correct for tvOS; WebRTC JPEG-DC is the upgrade (see §3 of the wall doc) | feel |
| 4 | Fast/Full reload buttons | RuntimeLabView reload modes → `/dev/reload` | ⚠️ Rebuild button calls ops `reload` on render box; no fast/full distinction, and `POST /dev/reload` is companion-scope-closed (deliberate for now) | control |
| 5 | Reload-intent queueing (no surprise re-render; refresh once on terminal state) | RuntimeLabView iframe re-mount policy | ✅ by construction — poll shows latest good frame; nothing blanks mid-turn | — |
| 6 | Capability gap → named tool → Install button → streamed bytes | capabilityGap.ts + RuntimeLabView | ✅ gapPanel + `/install/*` + `/streams/*` (scope fixed 2026-07-27) | — |
| 7 | Probe failure classification (relay-presence vs relay-route) with runner-fallback route | `web/lib/runtimeTargetProbeFailure.ts` | ❌ TV renders raw relay errors; no `relay.device_not_connected` classification, no "use runner box instead" lane | 4-layer |
| 8 | Per-role Test connection (runner + render separately) | vibe Route editor (`c8af35677`) | ❌ no probe at all; a dead render box discovers itself as a stuck spinner→error | 4-layer |
| 9 | Roles badge + per-role presence | web route editor | ⚠️ `machineRolesBadge` exists ("AI: x · Render: y") but shows row existence, not liveness | signal |
| 10 | Turn queue visibility (what's running/ready to test) | web runtime lab queue | ✅ RuntimeDashboardView `runtimeTurns` (redacted for shared rooms) — but not visible from the preview screen | placement |
| 11 | Clips / exercise summaries review | `/vibing/preview/clips`, `/summaries` (agent: vibe_preview_clip*.go, _summary.go) | ❌ scope now open; zero UI | feature |
| 12 | Crash overlay / exercise verdicts | vibe_preview_crash.go, _exercise.go | ❌ not consumed | feature |
| 13 | Screen-context ("this screen" prompts) | `/screen-context` | ❌ not sent; TV prompts lose the "what am I looking at" binding | quality |
| 14 | Co-vibe presence (who else is driving) | `/vibe/sessions` | ❌ not consumed; two people + one sim = fight | feature |
| 15 | Voice input | web mic / phone voice core | ⚠️ `Speech.swift` exists (AVSpeechSynthesizer out); no STT in — Siri Remote dictation into TextField is the zero-cost path | input |
| 16 | Runner auth / git auth with QR + liveness | RuntimeDashboardView | ✅ already the best native port (terminal-state set, liveness line) | — |
| 17 | Choice replies (runner asks, user picks) | web buttons | ✅ SessionView renders `options` as focusable buttons — BETTER than watch/wear; reuse on the preview screen | placement |
| 18 | Update-agent route on version skew | web banner | ✅ scope_denied → UpdateAgentView (2026-07-27) | — |

**Reading of the matrix:** rows 1, 7, 8 are the real distance. Everything else
is either done, placement (move an existing capability onto the preview
screen), or a feature tier that can trail. Row 1 is the loop itself — without
it the TV is a monitor, not a vibing surface.

## 2. Plumbing work items, ranked

### P1 — the loop: prompt-from-preview (row 1 + 17 + 10)
One overlay on the preview screens: a focusable "Vibe" button → prompt entry
(Siri Remote dictation types into a tvOS TextField for free) → send via
`SessionClient.sendText` to **`store.runnerBox()`** (role-routed, never the
selected box) → render turn state inline (sent → working → pane tail /
options) → options render as focusable buttons (`sendChoice`) → preview
frames keep flowing the whole time, and HMR lands automatically because the
poll never stopped. No navigation, no second screen.
*Implemented 2026-07-27: `tvos/YaverTV/Views/VibeTurnPanel.swift`, wired into
`WebPreviewStreamView` (browser/RN lane) and `DroidStreamView` (redroid lane).*

### P2 — per-role probe + relay-presence classification (rows 7, 8, 9)
Port the *policy* of `web/lib/runtimeTargetProbeFailure.ts` (kind:
relay-presence / relay-route / other; retry; runner-fallback) into
`FailureSignals` — keyed off `relay.device_not_connected`, NOT a fourth copied
regex — and run a cheap `GET /health` per role before entering a preview.
Named outcomes on the surface: "Render box isn't on the relay right now —
falling back to your AI machine" (when roles collapse) or the named dead end.
*Implemented 2026-07-27: `FailureSignals.classifyTargetProbeFailure` +
preflight in `WebPreviewStreamView.run()`.*

### P3 — WebRTC JPEG-DC viewer (row 3)
The feel upgrade: 300 ms poll → 10–15 fps push, sub-second. Signaling already
scope-allowed; browser surface needs no video decoder (JPEG DataChannel).
Needs a libwebrtc xcframework decision → separate change, user-approved dep.
Fallback stays the poll. See wall-doc §7 for the full lane analysis.

### P4 — turn stream instead of waitMs polling (row 2)
`/runner/session/turn` already answers with pane snapshots on a wait budget.
A `/dev/events`-style SSE for runner output (or widening `/streams/` to
runner session tails) would let the TV narrate a turn live. Agent-side seam
exists (`/streams/<name>`); needs a named stream per session turn.

### P5 — feature tier (rows 11, 12, 13, 14)
Clips + summaries as a "what happened while I was away" rail; crash verdict
overlay on the frame; screen-context POST alongside prompts (needs the scope
row — closed today, add with its consumer, not before); co-vibe presence
chip. Each is small once the loop exists; none blocks vibing.

### P6 — input tier (row 15)
Siri Remote dictation already covers 80% (dictation into TextField). A
hands-free wake path would reuse `mobile/src/lib/voice` semantics but native;
that's a separate engine decision — do not fork a third copy of the voice
core; drive the runner with plain turns until then.

## 3. Standing rules (so parity doesn't rot)

1. **Every new companion endpoint lands with a `companion_scope_parity_test.go`
   row in the same change.** The wall must never come back.
2. **Role accessors only** (`runnerClient()`/`renderClient()`); a
   `store.client()` in a feature view is a review-blocker.
3. **Reason codes over prose** — new failure shapes get a `reason_codes.go`
   code + a `FailureSignals` classifier; no per-view regex.
4. **A scope row with no consumer doesn't ship, and a consumer with no scope
   row can't** — add both sides in one change (screen-context is the current
   example: closed until its TV consumer lands).
5. **The TV never blocks the preview on advisory work** — probes get
   deadlines and degrade to named text; frames keep flowing.
