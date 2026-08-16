# Yaver — Tasks + tmux wiring across all surfaces: audit & plan

> Date: 2026-08-15 · Target branch: `upstream-audit/main` (v1.99.x, deployed daemon 1.99.411)
>
> Local `main` (v1.29.0) is a stale, divergent fork with **zero tmux code**. All
> gap-closure work below belongs on `upstream-audit/main`.

## 1. What already exists on the v1.99.x product

The deployed product already has a deep tmux subsystem. This is not a
greenfield build — it is a gap-closure + hardening pass.

**Agent tmux core (`desktop/agent/`)**

- `tmux.go` — session enumeration (`list-sessions -F`), adopt/detach, polling,
  pane-targeted I/O, WSL shim for native Windows, auto-install on Linux/macOS.
- `tmux_panes.go` — the **pane is the unit**. `ListVibePanes` enumerates every
  pane with agent detection (`claude | codex | opencode | shell`),
  `AgentConfirmed` (observed via process tree, never guessed), vibe status
  (`working | awaiting-input | idle | no-agent | dead | unknown`) via output-delta
  sampling, menu options when awaiting-input, absolute `currentPath` (P2P-only,
  forbidden in Convex by `convex_privacy_test.go`).
- `tmux_convex.go` — privacy-safe session ledger (identifiers + lifecycle only)
  synced to the Convex `tmuxRunnerSessions` table, restart-surviving via
  `~/.yaver/tmux-sessions.json` cache.
- `autorun_tmux.go` — drives runner TUIs through tmux (`new-session`, `send-keys -l`,
  `capture-pane`, busy-marker detection, blocked-prompt pre-answers).
- `attach_session.go` / `attach_http.go` / `attach.go` — interactive attach,
  remote reattach picker (`yaver attach --machine=<dev>`).
- `vibe_sessions.go` — co-vibe roster: per-machine live sessions keyed by
  workdir, participants with roles (`viewer | driver | owner`), TTL heartbeats,
  exclusive resource claims (ports/devices).
- `runner_session_turn.go` — `POST /runner/session/turn`: one call drives a live
  session synchronously (`waitMs`, pane tail, `awaitingChoice` + `options[]`,
  `delivered: observed|unconfirmed`).
- `mcp_tmux_close.go`, `tmux_input_queue.go` — close/input helpers.

**HTTP surface**

- `GET /tmux/sessions` · `POST /tmux/adopt` · `POST /tmux/detach` ·
  `POST /tmux/close` · `POST /tmux/input`
- `POST /runner/session/turn` · `GET /vibe/sessions` + `/vibe/join|heartbeat|role|leave`
- `GET /vibing/preview/*` (frames/events/clips/snapshots), `GET /vibing/frame`
- `GET /v2/capabilities`, `/v2/git/repositories`, `/v2/project-sessions/{id}/...`
- `/git/status|log|diff|tree|show|branches|stash|stash-pop|checkout|commit|commit-push|pull-request|identity|push|pull|revert`
- `/repos/pull` (credential-reinjected, token-free-origin clone/pull)

**MCP tools**

- `tmux_list_sessions` · `tmux_adopt_session` · `tmux_detach_session` ·
  `tmux_send_input` · `tmux_close_sessions`
- `runner_attach` / `runner_detach` / `runner_autorun` / `runner_queue_add` /
  `runner_queue_list` / `runner_queue_clear` / `runner_status` ·
  `runner_model_probe` / `runner_auth_status`

**Client surfaces**

| Surface | List sessions | Adopt | Stream live pane | Send follow-up | Task status | Convex ledger |
|---|---|---|---|---|---|---|
| mobile (iOS/Android) | ✅ P2P + ledger | ✅ `/tmux/adopt` | ✅ SSE + PTY shell | ✅ composer + voice | ✅ | ✅ |
| web | ✅ P2P + ledger | ⚠️ helper exists, **no UI calls it** | ✅ WebShellModal/PTY + /spatial trio | ✅ PTY typing | ✅ | ✅ |
| tvOS | ✅ `runner_sessions` | ⚠️ drive-by-name | ⚠️ pane **snapshot poll**, tasks SSE ✅ | ✅ turn loop | ✅ | ❌ |
| visionOS | ✅ (shared tvOS client) | ⚠️ drive-by-name | ⚠️ snapshot + preview frames | ✅ turn loop | ✅ | ❌ |
| watchOS | ❌ | ❌ | ❌ (1-line) | ✅ turn (standalone LAN-only) | ⚠️ 1-line | ❌ |
| Wear OS | ❌ | ❌ | ❌ (1-line) | ✅ turn (LAN+relay ✅) | ⚠️ 1-line | ❌ |
| car (CarPlay/AA) | ❌ (agent picks single) | ❌ | ❌ (audio only) | ✅ voice turn via relay | ⚠️ Live Activity; AA MessagingStyle scaffold-only | ❌ |
| Android TV | ✅ (full RN client) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Android XR | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

## 2. Confirmed gaps (from per-surface audit)

1. **watchOS standalone has no relay leg** — LAN-only `BoxTarget`
   (`watch/YaverWatch/Backend.swift`), unlike wearOS
   (`StandaloneStore.kt` LAN → relay `/d/<deviceId>/...` + `__rp`).
2. **car has no multi-session picker** — `resolveRunnerSession` errors when >1
   live session; docs/yaver-car-surface.md §7.2 calls this out.
3. **tvOS / visionOS poll pane snapshots** — no live runner-pane SSE; only
   *task* output streams (`/tasks/{id}/output`).
4. **No native surface reads the Convex ledger** (`GET /tmux-sessions`) except
   mobile + web — no offline/other-device inventory, and adoption state that
   survived an agent restart is invisible on tvOS/visionOS/watch/wear/car.
5. **Android XR has no client surface** — only `scripts/deploy-android-xr.sh`.
6. **web `adoptTmuxSession` exists but is never called by any UI**.
7. **Co-vibe presence** (`/vibe/sessions`) consumed only by web + mobile
   formatters; native surfaces never render who is driving/viewing.
8. **Android Auto MessagingStyle** is scaffold-only
   (`carMessagingNotification.ts` documents the expo-notification gap; needs a
   native module filling `androidAutoExtras`).

## 3. Remote-repo rebase / sync today

- `/git/pull` → plain `git pull` (no `--rebase`, no `--autostash`).
- `/repos/pull` → credential-reinjected pull for token-free-origin clones.
- `/vibing/commit` → the only safe path: `add -A` → commit → `pull --rebase
  --autostash` → push (with `--set-upstream` fallback).
- Client helpers `gitPull`/`gitPush` exist on mobile (`quic.ts:6161/6149`) and
  web (`agent-client.ts:8485/8494`) but **no UI offers a safe rebase-sync** of a
  remote repo (e.g. the `talos` repo) from the surface.

## 4. Code-loss risk (phase 0 priority)

- **yaver.io working tree: 62 uncommitted files** (37 modified + 25 untracked),
  **zero coverage** in any branch or stash, and they **overlap files that exist
  on `upstream-audit/main`**.
- **talos repo: 113 uncommitted files** (65 modified + 51 untracked), no stash,
  last commit docs-only.
- Nothing is backed up remotely. Phase 0 snapshots both before any branch work.

---

# Plan

## Phase 0 — Zero-code-loss safety net (run first, before touching anything)

1. Snapshot `yaver.io` working tree → `git add -A` on a new branch
   `wip/working-tree-snapshot-<date>` → push to origin; `git bundle` to `~/backups/`.
2. Snapshot `talos` the same way (commit to `wip/snapshot-<date>`, push origin).
3. Verify: stash empty, clean tree on snapshot branches, both pushes confirmed.

## Phase 1 — Reconcile the uncommitted work onto the real base

4. Diff the snapshot against `upstream-audit/main` file-by-file for the 27
   overlapping files; port the unique additions (CloudStudioContext,
   `coding-runtime.tv.ts`, `quic.ts` additions, mobile screens) onto v1.99.x, or
   archive them if superseded.
5. Rebase the snapshot branch onto `upstream-audit/main` as the working base.
   Reconcile `shared/coding-core` (v1.99 uses `shared/client-core`).

## Phase 2 — Agent core + signalling

6. **Live runner-pane SSE**: streaming pane-delta endpoint so tvOS/visionOS
   stop polling snapshots.
7. **Ledger on native**: expose the Convex `tmuxRunnerSessions` read to all
   native surfaces via a shared client lib.
8. **Co-vibe presence**: roster consumer for native surfaces.
9. **Constrained-surface session resolution**: picker payload so car/watch can
   choose among several live sessions.

## Phase 3 — Surface completion

10. **watchOS**: add relay leg to standalone (mirror wearOS).
11. **car**: wire the voice session picker; finish Android Auto MessagingStyle
    native module.
12. **tvOS + visionOS**: consume pane SSE + ledger.
13. **web**: call `adoptTmuxSession` from the Vibing sidebar.
14. **Android XR**: scaffold first client (reuse phone RN glass routes) or
    explicitly defer.
15. **mobile**: parity with new endpoints only.

## Phase 4 — First-class remote-repo rebase

16. Harden `/git/pull` → `pull --rebase --autostash` with dry-run guard; add
    `gitSyncRemote` (status → rebase → push) modeled on `/vibing/commit`.
17. Expose "Sync / Rebase remote repo" on mobile, web, tvOS, watch, car, and
    the tmux task console, with pre-rebase stash + abort-on-conflict guarantee.
18. Integrate rebase/land into adopted tmux task flows.

## Phase 5 — Verify

19. `go test ./desktop/agent`, client typechecks/builds (web `next build`,
    mobile, tvOS, watch, wear), e2e turn-smoke, cross-surface tmux pass.
