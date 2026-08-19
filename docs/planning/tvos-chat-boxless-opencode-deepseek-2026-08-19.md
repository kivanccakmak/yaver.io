# tvOS Chat → Remote Boxless → BYOK DeepSeek V4 Flash + Git — Plan (2026-08-19)

Status: **PLANNED — boxless service not implemented.** Client-side runner/model controls are
implemented separately and must remain compatible with both a selected remote box and this
future boxless target. Store uploads are currently blocked by signing material.

Companion audit: `docs/audits/tvos-vibing-runner-model-chips-2026-08-19.md` (the tvOS Vibing
chip-click + prompt-card findings).

---

## Scope

**tvOS Chat menu only** — `TasksView` (Chat) → New vibe → `TaskComposerView` → `TaskDetailView`.
No vibing previews, no WebRTC, no on-TV editor, no literal `opencode` binary.

The mode: the TV sends a task to a **remote boxless** target (a Cloudflare Worker hosting the
existing Hermes agent loop). The user brings their **own** DeepSeek V4 Flash API key and git
token (BYOK), stored **first-class in the tvOS Keychain**. Git commit + push happen through
pure APIs (`isomorphic-git` over HTTPS). Yaver's marginal cost ≈ $0.

### Current client compatibility (2026-08-19)

- tvOS Vibing exposes only OpenCode, Claude Code, and Codex. The active runner's model picker
  remains independent, so each runner's measured model list stays selectable on a remote box.
- OpenCode exposes Build/Plan and sends the mode with task creation/fork requests.
- Android TV `tv-coding` follows the same three-runner filter, model list, OpenCode Build/Plan
  mode, and keyboard-submit contract. It must not replace a connected remote box with the
  future boxless Worker.
- tvOS project inventory falls back from runner client to connected render client; connectivity
  status alone is never treated as proof that `/projects` succeeded.

### Locked decisions

| Decision | Choice |
|---|---|
| Agent home | **Remote service** — Cloudflare Worker (existing account, `deploy/deploy.sh cloudflare`) |
| Pricing | **BYOK free first** — users bring their own keys; paid tiers later via existing SKUs |
| Key custody | DeepSeek key + git token live **only** in the tvOS Keychain; sent per-run, in-memory on the Worker |
| Phone→TV key sharing | **One-time Worker handoff** (TTL'd, single-read blob; TV stores in Keychain; Worker deletes) |
| Reboot behaviour | Keychain self-heals (`errSecNotAvailable` transient → auto-retry); `.corrupt` → routed re-entry |

---

## Architecture

```
phone (SecureStore) ──"Send coding key to Apple TV"──▶ Worker one-time blob (TTL'd, single-read, encrypted)
                                                            │  TV "Get from iPhone" → tvOS Keychain (SecretStore)
                                                            ▼
tvOS Chat menu ──POST /tasks (Bearer + per-run keys)──▶ Cloudflare Worker
                                                        ├── api.deepseek.com/chat/completions   (BYOK DeepSeek key)
                                                        ├── isomorphic-git clone / commit / push (BYOK git token)
                                                        └── GET /tasks/{id}/output  → SSE back to the TV
```

The Worker mirrors the agent's **exact task contract** so the TV client is reused, not rewritten:

- `POST /tasks` — create (body shape identical to `AgentClient.swift:601-635`)
- `GET /tasks` — list
- `GET /tasks/{id}` — detail
- `POST /tasks/{id}/continue` — follow-up
- `GET /tasks/{id}/output?rawSince=` — SSE, frames `{type:"output"|"raw"|"raw_replay"|"done"|"agent_question"}`
  (`AgentClient.swift:443-467`)

Auth as today: `Bearer <token>` + `X-Yaver-Surface` (`AgentClient.swift:494-496`).

---

## Work items

### 1. `SecretStore` — first-class Keychain (tvos/YaverTV)

Generalizes `TokenStore.swift:9-57` (which today silently returns `""` on any error and swallows
every save/clear status — the anti-pattern being replaced).

- `enum SecretKey: String, CaseIterable { case yaverToken, deepseekApiKey, gitToken, boxlessServiceToken }`
- Throwing, classified CRUD — never silent:
  - `get(_:) throws -> String?` · `set(_:for:) throws` · `delete(_:) throws`
- `enum KeychainError: Error, Equatable`:
  - `.notFound` (`errSecItemNotFound`) — the **normal** "not configured yet" state
  - `.unavailable` (`errSecNotAvailable` / `errSecInteractionNotAllowed`) — keychain locked /
    not-yet-first-unlock after boot → **retryable, self-heals**
  - `.auth` (`errSecAuthFailed`) — classified even though tvOS generic passwords shouldn't hit it
  - `.corrupt` (`errSecDecode` / `errSecParam`) — named, routes to re-entry in Settings
  - `.unexpected(OSStatus)`
- Attributes: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, `kSecAttrSynchronizable: false`
  (never to iCloud). One-shot migration of `TokenStore`'s legacy `io.yaver.tv`/`session` item into
  the typed key.
- `KeychainProbe`: async write→read→delete sentinel at launch and **before** enabling the Cloud
  target → named verdict (`KeychainVerdict`), never a grayed-out/dead control.
- Auto-retry ladder for `.unavailable` (bounded, a few seconds; post-boot tvOS has no interactive
  unlock, so it resolves quickly).
- **Hygiene**: keys only in Keychain; never `UserDefaults`/`@AppStorage`/logs; "Sign out" /
  factory-reset clears all four keys alongside the token.

### 2. Phone → TV one-time key handoff

- Phone Settings → "Send coding key to Apple TV": reads `getLocalApiKey("deepseek")`
  (`mobile/src/lib/coding-runtime.ts:158`), POSTs to a **TTL'd (2 min), single-read,
  account-scoped, encrypted** blob on the Worker.
- tvOS Cloud-agent settings → "Get from iPhone": GET once → store in Keychain → Worker deletes.
- Long-term custody stays **only** in the tvOS Keychain (no durable server-side copy).
- Also serves as the re-provisioning path after an app reinstall.

### 3. Worker agent service

Ports `mobile/src/lib/coding-runtime.ts` to a Cloudflare Worker:

- Agent loop `runLocalPrompt` — already **DeepSeek-API-native by default**
  (`getLocalProvider()` → deepseek, `endpoint` → `api.deepseek.com/chat/completions`,
  `:151-157` / `:333`), tools `fs_read/fs_write/fs_search/git_status/git_diff/git_commit`
  (`:334-342`).
- Git: `gitCommit` (`:292`) and `gitPush` / `pushWorkspace` (`:304-322`, `yaver/local-*` review
  branch) via `isomorphic-git` over HTTP — no git binary.
- Model mapping: TV sends `runner=opencode, model=DeepSeek V4 Flash` → Worker calls
  `provider=deepseek, model=deepseek-v4-flash` directly (bypasses the box-side `provider/model`
  argv rule at `desktop/agent/tasks.go:305-307`).
- 8-tool-turn cap; SSE streaming in-request (Worker free tier wall-clock fits a short loop; move to
  a Durable Object only if long runs demand it).
- Keys passed per-run are used **in-memory only** — never persisted, never logged.

### 4. tvOS Chat target picker

- `TaskComposerView` gains a `Target` selector: `Cloud · no box (BYOK)` vs selected box.
- When Cloud: a `boxlessClient` (Worker URL + `boxlessServiceToken` from Keychain) replaces
  `store.runnerClient()`; the POST body carries `repoUrl`, `gitToken`, `deepseekKey`.
- Runner label `opencode`, model default `DeepSeek V4 Flash`.
- `TasksView.load()` (`:275-301`) reads `GET /tasks` from the Worker when Cloud is active.
- Missing-key card in the composer: named reason + `NavigationLink` to the Cloud-agent Settings
  section (pattern at `DashboardView.swift:111`), then returns the user where they were.

### 5. Git commit + push

- The loop commits locally (`gitCommit`); on terminal state with `autoPush=true` pushes a
  `yaver/local-*` review branch (`pushWorkspace`) using the user's token.
- Result surfaces in `TaskDetailView` exactly like a box task today.

### 6. Auth

- Worker validates the caller's `boxlessServiceToken` (per-account secret minted via the existing
  SDK-token path, Keychain-backed) as Bearer; missing → "connect your Cloud account" route, not a
  bare 401.

### 7. Cost guardrails (BYOK free first)

- BYOK = $0 to Yaver at any scale (users pay their own DeepSeek/Git tokens).
- Worker free tier (100k req/day) covers launch; when exceeded → Workers Paid $5/mo floor.
- Per-user/day task caps so one runaway user can't burn the account's Worker quota.
- Managed inference (Yaver pays DeepSeek) and Managed Cloud Runner (build/test/native) stay behind
  the existing **Cloud Workspace $29/mo / Relay Pro $9/mo** SKUs — the Chat target selector is the
  one-tap upsell.

---

## Failure plumbing — never blocks, never silent

The four layers, applied to every failure in this mode:

1. **Detection** — `KeychainProbe` (write→read→delete) and per-key `presence(for:)`
   (`ok / notConfigured / unavailable / corrupt`). Probe the operation, never the inventory.
2. **Signal** — `KeychainVerdict` + task errors with **named, structured** causes (FailureSignals
   sentence parity — `FailureSignals.swift:20-24` wording identical to mobile/web).
3. **UI** — a named cause with the next tap, never a spinner:
   - missing DeepSeek key → card + "Add your DeepSeek API key in Settings" → route
   - `.unavailable` (post-boot) → transient "Keychain unlocking…" auto-retry
   - `.corrupt` / `.unexpected` → named diagnosis + "re-enter key in Settings" route
   - broken Keychain never takes down the **box** target — only the Cloud path needs the keys
4. **Route-to-fix** — every state has the next tap, in place, and returns the user to what they
   were doing.

Reboot matrix (tvOS Keychain): reboot → self-heals (transient `.unavailable`, auto-retry);
corrupt item → not fixed by reboot, routed re-entry (handoff re-shares in one tap); app
reinstall/uninstall → items cleared, handoff re-provisions.

---

## Verification (prove-by-breaking)

- `SecretStoreChecks.swift` — `swiftc`-run like `FailureSignalsChecks` (no Xcode/TV needed):
  round-trip, `.notFound` / `.corrupt` classification, no-silent-`""` contract, accessibility and
  sync attributes asserted.
- On-device closed loop:
  - enter key → relaunch → persists (masked in Settings)
  - phone handoff → TV receives → Worker blob deleted after read
  - reboot → transient retry, keys return
  - delete item → composer names it with the Settings route
  - Chat → New vibe (Cloud) → task streams in `TaskDetailView` → DeepSeek call happens → commit +
    push land on `yaver/local-*`
  - two users / two keys / same Worker → no cross-user leakage
- Break the guard: remove the sentinel/retry, watch the named state appear, restore it.

---

## Release gates observed on 2026-08-19

- **tvOS TestFlight:** archive reached Apple signing but stopped because team `5SJZ4KA39A`
  has no valid tvOS App Store provisioning profile for `io.yaver.mobile`; do not substitute a
  development profile. Create/download the App Store profile, then rerun
  `./deploy/deploy.sh tvos --upload`.
- **Android TV Play internal:** leanback manifest checks pass, but upload stopped before build
  because the local vault has neither `ANDROID_KEYSTORE_BASE64` nor `ANDROID_KEYSTORE`.
  Provision the release keystore and `mobile/android/keystore.properties`, then rerun
  `./deploy/deploy.sh android-tv`.
- These are signing/account gates, not UI failures. The tvOS simulator build and Android TV
  manifest regression tests remain valid evidence for the client changes.

## Non-goals (explicit)

- No build/test/native/npm in this mode (Hermes loop ceiling, `coding-runtime.ts:360`) — those stay
  on the paid Managed Cloud Runner.
- No literal `opencode` binary, no opencode port, no on-TV agent (JavaScriptCore variant is a
  stretch, out of scope).
- No vibing previews / WebRTC surfaces.
- Nothing implemented yet — this is the plan.

## Suggested implementation order (later)

1. `SecretStore.swift` + `SecretStoreChecks.swift` (prove the Keychain layer first)
2. Worker one-time handoff blob + Worker agent service (`/tasks` + SSE contract)
3. tvOS `TaskComposerView` target picker + `boxlessClient` + Settings section
4. Phone-side "Send coding key to Apple TV"
5. Closed-loop verification
