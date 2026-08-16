# Deep Audit — Electron GUI + Cross-Surface DOM Mode + Desktop→Mobile Continuity

Date: 2026-08-12. Companion docs: `DOM_MODE_HANDOFF.md`,
`docs/audits/webui-chat-vibing-gui-2026-08-12.md`,
`docs/handoff/acp-subscription-auth-2026-08-12.md`. Every claim below was
verified by reading code at HEAD plus live probes where noted.

---

## 1. Verdict

| Area | Verdict |
|---|---|
| DOM mode on every surface | ✅ **SHIPPED** — Go agent, web (both mounts), mobile (both preview lanes), `desktop/app/` webview shell, `electron/` GUI (inherits web), and now **tvOS pixel-overlay** (route + Swift cursor + select metadata) |
| Electron GUI — server side (desktop-as-node) | ✅ **WORKS** — adopt-or-spawn supervisor, keychain-free, device-row registration |
| Electron GUI — client side (shell) | ✅ **SOUND** — hardened window, token-in-URL fix, tray/deep-links; inherits the web app's remaining gaps |
| Desktop→mobile continuity | ✅ **VERIFIED LIVE** on this Mac — tmux seats, runner auth, preview endpoint all mobile-visible |
| tmux across OS (macOS/Linux/Windows) | ✅ **FIXED** — Windows now bridges through WSL2 (was: hint said WSL2, exec couldn't reach it) |
| Web parity gaps the GUI inherits | ⚠️ **MOSTLY FIXED** — OSC-8 XSS fixed, raw-console lane wired, render contract fixed; see §4 |

## 2. DOM mode — all surfaces

Per `DOM_MODE_HANDOFF.md`, DOM mode (Browse|Inspect → element html/css/rect/shot
→ shared `globalDomElements` store → per-turn hook) was already complete on web,
mobile, `desktop/app/` and (by inheritance) the `electron/` GUI. This session
closed the remaining surfaces:

- **tvOS pixel-overlay** — `POST /vibing/preview/select` was **dead code**
  (`VibePreviewManager.SelectElement` existed, no route, no caller). Wired it
  under `s.auth`, drove a real click in the headless preview Chrome, and added
  the Swift cursor UI in `WebPreviewStreamView.swift` (D-pad steering via
  `onMoveCommand` — **DragGesture is unavailable on tvOS**, verified against the
  tvOS 26.2 SDK — plus Play/Pause select) and `AgentClient.selectPreviewElement`.
  **tvOS `xcodebuild` succeeds.**
- **Select metadata** — the agent now returns `PreviewSelectMeta`
  (requested viewport + **real decoded frame size** via one PNG-header decode)
  so the TV maps cursor → viewport without guessing; Swift consumes it.
- **Hermes/native lane honesty** — a native Hermes preview has no DOM, so
  `DomInspectChip` gates the Inspect toggle on `getActivePreviewLane() ===
  "browser"` (new `subscribeActivePreviewLane` broadcast in
  `mobile/src/lib/feedbackTrigger.ts`); the toggle disables with
  "element inspect needs the web preview (not the native app preview)".
- **Tests**: Go select suite 7/7 (incl. HTTP wire → shared store, auth, 404);
  mobile domInspect 20/20; tvOS build green.

## 3. Electron GUI — deep audit

### Server side (the desktop IS a yaver node) — `electron/src/agent-manager.js`

- **Adopt-or-spawn**: probes `127.0.0.1:18080/health` → adopts a live agent,
  else spawns `yaver serve --debug` as a supervised child (health-wait,
  restart-with-backoff, SIGKILL fallback, kill-on-quit). Matches the agent's
  own reuse semantics — never duplicates a process.
- **Binary resolution**: bundled `<resources>/bin/yaver` → `~/.yaver/bin/current/<platform>`
  → PATH.
- **`YAVER_VAULT_SKIP_KEYCHAIN=1`** — the spawned agent never shells out to the
  macOS `security` tool, so the GUI boots without "security wants to use your
  confidential information" popups (the exact keychain-prompt bug class hit
  elsewhere this session).
- **Continuity**: the dashboard discovers devices via Convex heartbeat, so the
  GUI's box appears in the mobile device list with zero extra wiring.

### Client side (the shell) — `electron/src/main.js`, `preload.js`,
`auth-interceptor.js`, `navigation-policy.js`

- Hardened: `contextIsolation`, `sandbox`, `nodeIntegration:false`,
  `webSecurity`, navigation allowlist (will-navigate / will-redirect /
  did-navigate-in-page), external links → system browser, single-instance lock,
  `yaver://` deep links, tray, task-completion notifications.
- **Token-in-URL fix** (audit §6.2): main-process request interceptor strips
  `?token=`/`?__rp=` from SSE/stream URLs and re-injects as
  `Authorization`/`X-Relay-Password` headers — Electron can do what EventSource
  cannot; the secret never reaches the network in a URL for GUI users.

## 4. Gaps found and fixed

| Gap | Fix | Verified |
|---|---|---|
| **OSC-8 `javascript:` href XSS** (web audit §6.1) — tokenizer extracted link URLs verbatim, `AnsiConsoleText` rendered `<a href>` unsanitized; a prompt-injected link executed in the dashboard origin | `shared/client-core/src/ansi.ts` now allowlists `https?://`/`mailto:` at the single choke point; renderer got a defense-in-depth guard; 8 regression assertions; re-synced to web/mobile/sdk copies | web ansi tests pass; tsc clean |
| **Web chat raw-console lane** (web audit §2) — mobile renders RAW runner stdout (`LiveConsoleSection`); web accepted `rawSince` but had no consumer, bytes vanished into the event bus | `agent-client.ts` dispatches `raw`/`raw_replay` to a dedicated `onRaw`; `taskStreamWithRecovery` threads it through; web chat buffers (2000-line cap) into a foldable "Live console" panel with byte/line counter | web tsc clean; recovery tests 10/10 (new guard test) |
| **Render contract** (web audit §3) — PreviewPane/VibeCodingView reloaded only on `/dev/events` compile signals, never on task completion; no "render once at terminal, never while coding" | PreviewPane now renders the iframe exactly once per task when `activeTaskStream.status` hits `completed`/`review` (idempotent per task); VibeCodingView embeds PreviewPane so it inherits the fix | web tsc clean |
| **Dead code** (web audit §7.1) — `taskOutputSuggestsRender` was never called and encoded the forbidden "infer reload from output text" regex rule | **Deleted** | tsc clean |
| **tmux on Windows** — install hint said "use WSL2" but `discoverBinary("tmux")` only finds a native `tmux.exe` (essentially never exists), so `tmuxAvailable()` was false and every runner seat silently refused to drive through tmux | `ensureWSLTmuxShim()` writes `~/.yaver/bin/tmux.cmd` forwarding every tmux argv to the WSL2 default distro (`wsl.exe -d %DISTRO% -- tmux %*`, `YAVER_WSL_DISTRO` override); `tmuxCmdName()` routes Windows to the shim so all ~50 exec sites inherit the bridge; shim only advertised after probing tmux exists in the distro; hint updated | Go build/vet clean; `TestTmuxWSLShimContentBridgesToWSL` passes |

## 5. Desktop→mobile continuity — verified live

On this Mac (launchd-owned `yaver serve`, the live test subject):

- `GET /tmux/sessions` → **2 live tmux sessions**, one an opencode runner seat
  (session/pane/preview/agentType all mobile-visible over the authed channel).
- `GET /runner-auth/status` → codex + opencode **ready + authenticated**
  (dispatchable from any surface).
- `GET /vibing/preview/status` → answers (render leg reachable).
- Device registered in Convex via heartbeat → appears in the mobile device
  list as a box to vibe from the phone while the desktop does the work.

So the named use case — "open the desktop GUI, vibe, keep vibing from mobile
(tasks + rendering) leveraging the desktop" — is real and working on this
machine; the GUI's embedded agent is what makes it so.

## 6. Remaining (out of scope or not yet done)

- **Delete-or-mount `VibePreviewView`** (web audit §7.2, still orphaned — its
  clip-panel logic was lifted into WorkspaceShell).
- **Web chat command cards** in the chat `onEvent` (web audit §2) — shipped to
  PreviewPane only; chat still doesn't render `command_start/output/end`.
- Web chat final-status ~3s poller lag and the mobile "fork on follow-up"
  divergence (web audit §2) — behavioral, not correctness.
- Live e2e for the raw-console + terminal-render fixes (needs a box + creds;
  the static guards pin the wiring in CI-less runs).

## 7. Verification checklist (all pass)

- `cd desktop/agent && go build ./... && go vet .` ✅
- `go test -run 'TestVibePreviewSelect|TestTmuxWSLShim|TestACPAuthStateForRunner|TestACP|TestDom' .` ✅
- `cd tvos && xcodebuild -project YaverTV.xcodeproj -scheme YaverTV -sdk appletvos -configuration Debug build CODE_SIGNING_ALLOWED=NO` ✅
- `cd web && npx tsc --noEmit` ✅ (0 errors) · `npx tsx lib/_core/ansi.test.ts` ✅ · `npx tsx lib/taskStreamWithRecovery.test.ts` ✅ (10/10) · `npx tsx lib/taskStreamRecovery.test.ts` ✅ (10/10)
- `cd mobile && node --experimental-strip-types --test src/lib/domInspect.test.mts` ✅ (20/20)
- Live continuity probes (this Mac): `/tmux/sessions` 200, `/runner-auth/status` 200, `/vibing/preview/status` 200 ✅
