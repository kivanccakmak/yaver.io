# Failure & Recovery Audit — Connectivity / Auth / Runtime Stack (2026-07)

> **Docs drift; code is the source of truth.** Every `file:line` below was read
> at the commit this document landed on. Before acting on any row, grep the
> code again. When this doc and the code disagree, this doc is the bug.

Scope: every failure class a user can hit across relay, runner OAuth, mobile/web
transport, Convex sessions, dev-server/preview, and agent lifecycle — and
whether each one has (a) a named remedy in its error text, (b) a self-heal,
and (c) a recovery affordance on **mobile** and on **web**. The bar, from the
project's own rules: *a failure that renders as a spinner, a raw string with no
action, or exists on one surface but not the other, is a defect.*

Method: four parallel deep-reads (relay, runner OAuth, transport/session,
dev-preview + lifecycle), baselined against `desktop/agent/custodian_playbook.go`
(the canonical self-heal inventory, reproduced in Appendix A) and the
2026-07-27 runtime/runner-auth handoff (`docs/handoff/runtime-runner-auth-oauth-audit-2026-07-27.md`),
whose items are tracked in §6.

Legend: ✅ good · 🟡 partial · ❌ missing · 🔧 fixed in this audit's fix pass (§7).

---

## 1. Relay failure classes

| # | Failure | Detected at | Error text quality | Self-heal | Mobile recovery UI | Web recovery UI | Gap |
|---|---|---|---|---|---|---|---|
| R1 | Stale/invalid per-user relay password (`reason=bad_password`) | `relay/server.go:1096` (verdict from Convex) | 🟡 names cause, not action | ✅ ×3: agent refetch+retry (`desktop/agent/main.go:11264`), bus transport (`bus_relay.go:63-79`), mesh repair (`agent_mesh_remote.go:1065`) | ✅ auto-heal effect (`DeviceContext.tsx:2601-2645`) + quic repair rung (`quic.ts:7341`) + narrated probe ladder (`probeWithRepair.ts:101`) | ✅ auto-repair + manual "Repair relay" (`WebReloadView.tsx:1396`), `/d/` proxy inline heal (`route.ts:178-188`) | Best-covered class. Minor: `main.go:11250` comment names a `yaver repair-relay` CLI command that does not exist |
| R2 | Dead relay session token (`reason=dead_token`) | `relay/server.go:1086` | ✅ "sign in again on this device" | 🟡 agent writes `RelaySessionExpiredAt` (`main.go:11454`) | ❌ nothing reads the sentinel | ❌ | **Dead sentinel**: `RelaySessionExpiredAt` is written but has zero readers; its own doc-comment claims consumers ("/settings/health", a doctor probe) that do not exist |
| R3 | Device mismatch (`reason=device_mismatch`) | `relay/server.go:1091` | ✅ truthful, terminal | ✅ correctly none ("no retry helps", `main.go:11271`) | 🔧 named terminal remedy in ladder narration + give-up (`relayDeny.ts` via DeviceContext) | 🔧 named in connect error pick + stops the reconnect ladder (`relayDeny.ts`, `reconnectLadder.ts`) | 🔧 fixed 2026-07-27 (`e3406cdcb`/`a154a87cc`/`3bf874476`) |
| R4 | Relay password missing (register) | `relay/server.go:1073` | 🟡 | bootstrap log only | ✅ probe ladder `relay-credentials-missing` → repair + re-probe (`deviceStatus.ts:370`) | ✅ `/d/` route regex → repair (`route.ts:183`) | Register-path variant visible only in agent logs + `doctor_transport` |
| R5 | Convex (auth backend) unavailable — register | `relay/server.go:1068` | ✅ "retry", deliberately not a credential verdict | agent backoff; no strike held | 🟡 generic reconnect banner | 🟡 same | Acceptable: retry IS the remedy |
| R6 | Convex unavailable — proxy 503 | `relay/server.go:1813` | ✅ | client retry | 🟡 generic 503 hint mislabels as "overloaded" (`quic.ts:1261`) | 🟡 same (`agent-client.ts:22`) | Minor mislabel; body detail usually wins |
| R7 | Register rate-limited (per-IP) | `relay/server.go:989,1292` | 🟡 no remedy | backoff | ❌ | ❌ | Low risk |
| R8 | Brute-force throttle (register) | `relay/server.go:1077` | 🟡 | strikes clear on valid auth | 🟡 matched as auth error → one repair | ❌ | Minor |
| R9 | `deviceId already registered` (different-owner collision) | `relay/server.go:1167,1384` | ❌ no reason code | ✅ for common case: dead-conn + same-user eviction (`server.go:1132-1166`) | ❌ perpetual "Reconnecting (n/5)" | ❌ | True cross-owner collision loops silently forever — unfalsifiable when it happens |
| R10 | Proxy 401 password missing | `relay/server.go:1817` | ✅ "sign in again to fetch it" | ✅ web route + mesh repair | ✅ self-heal patterns match | ✅ purpose-built regex | Well covered |
| R11 | Proxy 401 invalid password | `relay/server.go:1828` | 🟡 bare statement | ✅ same tripod as R1 | ✅ | ✅ | Well covered |
| R12 | Proxy 429 brute-force | `relay/server.go:1824` | 🟡 | — | 🟡 generic hint | 🟡 | Adequate |
| R13 | Proxy 429 free-tier / per-user rate limit | `relay/server.go:1853-1862` | ❌ raw string from relay | owner-dev exempt (`server.go:560`) | 🔧 named card text in reconnect narration (`classifyRelayLimit`) | 🔧 compact named card on PreviewPane + connect errors | 🔧 client naming fixed 2026-07-27; no meter/upgrade surface yet |
| R14 | Daily bandwidth cap (incl. mid-stream cut) | `relay/bandwidth.go:161`, cut `server.go:2147` | 🟡 states usage, not remedy | none (by design) | 🔧 card names the cap, reset, unmetered paths, and that a cut stream was the cap | 🔧 same card | 🔧 named 2026-07-27; still no meter anywhere (`/admin/bandwidth` relay-admin only) |
| R15 | Device not connected to relay (no tunnel) | `relay/server.go:1925,2475` | 🟡 | ✅ liveness watch + agent redial | ✅ topology-refresh rung (`quic.ts:7351-7362`); honest "online · no relay path" pill | ✅ ladder diagnostics | Good post-2026-07 fixes |
| R16 | Zombie tunnel (registered but blackholed) | `desktop/agent/relay_health.go:51-130` | ✅ doctor remedies (`doctor_transport.go:65-71`) | ✅ ForceReconnect after 2 confirmations; zombies excluded from heartbeat `relayConnected` | 🟡 indirect (honest pill) | 🟡 indirect | Strong |
| R17 | Sig-path auth failures (asymmetric lane) | `relay/server.go:798-865` | silent fallback by design; counters at `/authmix` | ✅ password-path fallback | n/a | n/a | If password path is ALSO broken, sig reason never reaches the client |
| R18 | WS-fallback can't stream | `relay/server.go:1989,2493` | ✅ names constraint | ❌ | ❌ raw string on a streaming surface | ❌ raw string | Truthful but actionless; SSE consumers may just stall |
| R19 | Tunnel broken mid-request | `relay/server.go:2024-2170` | 🟡 "reconnecting…" | ✅ eviction + redial | 🟡 generic banner | 🟡 | Transient; adequate |
| R20 | Device concurrency cap | `relay/server.go:1935,2498` | 🟡 | ❌ | 🟡 generic | 🟡 | Minor |

Cross-cutting: quic.ts:1258-1264 and web `agent-client.ts:22` are parallel copies
of the relay-error-hint table, and mobile maintains **three** separately-drifting
matchers for "relay-auth-shaped" (`isRelayAuthError`, the self-heal effect's
pattern list, `isRelayAuthShaped`).

## 2. Runner OAuth (browser-auth session machine)

State machine: `desktop/agent/runner_auth_browser_http.go` — statuses
`starting → awaiting_browser → verifying → completed | failed | cancelled |
account_not_eligible`, 45s silence watchdog with per-runner remedies,
callbackPort discovery + replay, code paste over stdin, `lastOutputAt`
liveness contract.

### 2a. Server-side state machine defects (all 🔧 fixed this pass)

| Defect | Where | Impact |
|---|---|---|
| 🔧 `cmd.Wait` overwrote `account_not_eligible` → `failed` ("exit status 1"); a zero exit could even flip it to `completed` | `runner_auth_browser_http.go` exit goroutine | The one status that says "retrying cannot work" was demoted to a generic failure the moment the CLI exited |
| 🔧 Cancel handler flipped ANY session to `cancelled`, including `completed` | cancel handler | A late × un-reported a successful sign-in |
| 🔧 Terminal-status guards were hand-rolled triples that omitted `account_not_eligible` | watchdog + submit-code + callback-replay guards | Entitlement-rejected sessions still accepted pastes/callbacks |
| 🔧 No incident recorded for `account_not_eligible` | `recordRunnerBrowserAuthIncident` | The entitlement class was invisible to the incident/custodian feed |

Now pinned by `desktop/agent/runner_auth_browser_state_test.go` (guards proven
by breaking them).

### 2b. Panel parity matrix (5 surfaces)

| Check | VibeCodingView | ToolsView | DevicesView modal | RuntimeLabView | Mobile RunnerAuthModal |
|---|---|---|---|---|---|
| Code-paste box | ✅ | ✅ (needs `openUrl` first) | ✅ (needs `openUrl` first) | ✅ | ✅ |
| Deliver-callback box, never hidden while `callbackPort` set | ✅ | ✅ | ✅ | ✅ | ✅ |
| Single-line copyable URL | ✅ | 🟡 break-all + copy | ❌ 🔧 truncated anchor, no copy | ❌ 🔧 URL string never shown | ✅ |
| `account_not_eligible` terminal + readable | ❌ 🔧 never terminalizes → busy flag wedged, button says "Opening sign-in…" forever | ❌ 🔧 poll never stops, amber in-progress badge | ❌ 🔧 invisible (not terminal, active branch hides detail/error) | 🟡 terminal, but `session.error` never rendered | ✅ dedicated branch |
| `lastOutputAt` liveness line | ❌ 🔧 | ❌ 🔧 | ❌ 🔧 | ❌ 🔧 | ✅ "CLI is alive, last output Ns ago" |
| Failed → error detail + retry | ✅ | ✅ | 🟡 detail, no retry | 🟡 drops `session.error` (the watchdog's remedy lives there) 🔧 | 🟡 detail, no retry |
| Cancel button | ❌ | ✅ | ✅ | ❌ | ✅ |

(The web session type `RunnerBrowserAuthSession` in `web/lib/agent-client.ts`
did not even declare `lastOutputAt` — 🔧 added.)

### 2c. Codex-specific rows (device-auth flow: `codex login --device-auth`)

| # | Finding | Where | Status |
|---|---|---|---|
| CX1 | Codex login-status probe cached 60s with NO invalidation — a completed codex OAuth kept reporting `authVerified=false` from a mid-sign-in probe, so the device card sat amber "verify needed" up to ~90s after a successful login (claude's cache IS invalidated per snapshot) | `runner_auth.go` codexLoginStatusCache | 🔧 `invalidateCodexLoginStatusCache` added, called on codex session snapshots |
| CX2 | `account_not_eligible` unreachable for codex: the entitlement scan matches `Login failed:` lines, but codex device-auth is measured SILENT — an admin-gated workspace (device-auth disabled) fell to the generic 45s remedy that never mentioned the possibility | scanner + watchdog | 🔧 codex-specific watchdog remedy now names workspace gating + the terminal/import lanes |
| CX3 | `lastOutputAt`/callbackPort/replay/completed-kick are runner-ungated — codex gets the callback lane and heartbeat kick like claude | spawn + `watchRunnerCallbackPort` + onTerminal | ✅ |
| CX4 | Device-code copy affordance missing on 2 of 5 surfaces (VibeCoding, RuntimeLab rendered `Code: XXXX-XXXX` as plain text) | web panels | 🔧 Copy-code buttons added |
| CX5 | Codex hard failures render the Go "exit status N", not the CLI's own words (no codex failure-line parsing) | exit transition | ❌ remaining (server preserves last stderr line in Detail when present) |
| CX6 | `/runner-auth/status?live=1` re-verify excluded for codex on a stale rationale — `codex login status` IS a free authoritative probe the code itself uses | `runner_auth.go` applyLiveRunnerAuthProbe | ❌ remaining |

### 2d. Live incident 2026-07-27 (web dialog vs mobile — "mobile was perfect")

Box journal: session reaped + respawned (callback port changed 40717 → 36543);
user's Deliver-callback replay succeeded; terminal `completed`,
`authSource="claude.ai · max"`. Verdicts:

| Finding | Status |
|---|---|
| Web dialog poll swallowed EVERY lookup error forever ("transient fetch errors are fine") — after a reap/respawn or agent restart it kept narrating the DEAD session, port included; Deliver-callback pointed at a dead listener with no hint | 🔧 sessionGone detection: "auth session not found" (or 8 consecutive failures) renders a named panel + Start-again button |
| Devices modal had no retry on failed/cancelled (close-and-reopen only) | 🔧 restart affordances on all terminal failure branches |
| Completion via callback replay does reach the green "✓ Signed in" branch (poll → completed) | ✅ verified |
| Deliver-callback errors surface with the thrown reason (`submitError`) | ✅ verified |
| Agent logged `scanner error: read \|0: file already closed` twice after every successful sign-in — the EXPECTED pipe-close on cmd.Wait rendered as an error | 🔧 suppressed to debug-level; real read failures still log |

### 2e. Other callers

- **CLI headless poll** (`runner_pty_cmd.go:899-978`): terminal switch omits
  `account_not_eligible` → loops ~6 min then generic timeout, dropping the
  verbatim entitlement quote. ❌ (mitigated server-side now that the status
  survives, but the CLI switch should still name it).
- **SSH fallback** (`runner_auth_cmd.go:676`): still spawns
  `claude auth login --console` — the API-billing flow whose token 401s against
  subscription endpoints; the HTTP path was explicitly fixed to `--claudeai`. ❌
- **MCP verbs**: start/status/submit-code/cancel exist; there is **no**
  `runner_auth_browser_submit_callback` verb, so MCP/phone-connector callers
  cannot use the Deliver-callback lane. ❌

## 3. Transport + session (mobile / web)

| # | Failure | Detected at | Text quality | Self-heal | Mobile UI | Web UI | Gap |
|---|---|---|---|---|---|---|---|
| T1 | Never-reached box, ladder exhausted (5 attempts) | `quic.ts:7305` → `DeviceContext.tsx:2086` | ❌ 🔧 "Could not reach device after 5 attempts" — drops the preserved cause | ❌ | ✅ Retry / Re-auth / View Logs (`tasks.tsx:4228`) | ✅ rich per-leg panel (`page.tsx:3071-3213`) | 🔧 give-up now carries `lastTransportError` |
| T2 | Previously-reached box down | `quic.ts:7297` | 🟡 "Reconnecting (n/5) — cause" (n clamped; retries are actually infinite) | ✅ repair + topology rungs | ✅ Stop + View Logs | 🔧 repair rung (once/streak) + topology rung (every 3rd) + named give-up in `lastConnectError` (`reconnectLadder.ts`) | 🔧 parity landed 2026-07-27 (`3bf874476`) |
| T3 | Stale relay password | `quic.ts:7340` | ✅ | ✅ once/streak | ✅ | 🟡 auto-repair only from mounted ProjectsView | See R1 |
| T4 | Box lost relay registration | `DeviceContext.tsx:2116` | ✅ expectation-setting text | ✅ topology refresh | ✅ | ✅ | Good |
| T5 | Agent's own Convex session expired (QUIC 401 / runner logout) | `/health` `authExpired` → flag (`quic.ts:1421`) | ✅ | ✅ silent `recoverDeviceAuth` (primary device only, capped) | ✅ banner + Re-auth button + device-details recover | ✅ headline + `yaver auth` copy + browser re-auth; mirrored in 6 views | 🟡 per-request 401s not intercepted — detection waits for next 15s health probe |
| T6 | Phone's Convex token stale/rotated | `DeviceContext.tsx:1447` | ✅ where strings exist | ✅ extend-only refresh, spurious-401 double-check, network errors never log out | 🔧 confirmed-invalid sets `sessionExpired`; login.tsx renders `SESSION_EXPIRED_NOTICE` | ✅ "Your session expired — sign in again." (`page.tsx:2490`) | 🔧 parity landed 2026-07-27 (`e3406cdcb`/`a154a87cc`) |
| T7 | Browser lane: no possible transport (RN-web) | `platformTransport.ts:102` `explainNoTransport` | ✅ sentence exists | n/a | ❌ 🔧 **zero production consumers** — the guard written after the 2026-07-25 eternal-spinner incident was dead code | n/a | 🔧 now rendered instead of the reconnect spinner on web builds |
| T8 | Relay overload (429/413/503) | `quic.ts:1259` | ✅ | backoff | ✅ | ✅ | Fine |
| T9 | Split-brain focus drift | `DeviceContext.tsx:2284-2354` | prevented | ✅ focus invariant + promotion | transparent | n/a | Residual render-gap throw only |
| T10 | Preview address never arrives | `apps.tsx:3108` | ✅ named reason after 10s | ❌ | ✅ Retry | 🟡 | Good on mobile |

## 4. Dev server / preview

| # | Failure | Detected at | Text quality | Self-heal | Mobile UI | Web UI | Gap |
|---|---|---|---|---|---|---|---|
| D1 | 412 missing toolchain (preflight) | `devserver_http.go:1766-1789` | ✅ structured `{missingTools, installEndpoint, installable, helpHint}` | 🟡 node-only case auto-installs (streamed) | ✅ install button + streamed install + auto-retry (`apps.tsx:1315`) — **but see D1a** | ❌ remedy folded into string only (`agent-client.ts:4839`); no install button | Web install affordance missing |
| D1a | **412 install dead zone**: 412 fires only for non-node tools, but `installable`/`installEndpoint` are only ever set for node | `devserver_http.go:944-971,1775` | ❌ `helpHint` names "POST /install/node" even when the missing tool is bun/pnpm/hermesc | — | ❌ the one-tap install flow is unreachable | ❌ | Every 412 that reaches a client has `installable:false`; the mobile button can never render |
| D2 | Toolchain missing at spawn ("executable file not found") | `devserver_start_remedy.go:210-235` | ✅ per-framework, validated against real install plans | ❌ offer only | ✅ via compile card | ✅ via status text | 🟡 remedy text promises "use Install on the preview panel" — **no such button exists on any surface** |
| D3 | Dev server exited before ready / foreign port owner | `devserver.go:1954-1988` | ✅ named (incl. port-bind and port-owned-by-another-process) | ✅ playbook `port-busy-orphan` | ✅ failure overlay + Retry | 🟡 raw text | Adequate |
| D4 | Web-preview sibling died ("browser preview exited") | `devserver_http.go:1330-1336` | ✅ with false-positive guards (`!Building`, WebPort fallback) | ✅ stale-handle restart | ✅ both implementations | 🟡 text only | Adequate |
| D5 | Compile failure on healthy server (blank preview, green status) | `devserver.go:1663-1690` + `SetCompileError` | ✅ triple-published (SSE + persisted + custodian) | escalation lane | ✅ named card on both surfaces (`compileFailure.ts`) | 🔧 web port (`web/lib/compileFailure.ts`, regex-parity-tested): card replaces the blank iframe in PreviewPane; SSE-tail card in RuntimeLabView | 🔧 fixed 2026-07-27 (`3bf874476`/`fca3be788`) |
| D6 | Preview probe phases/timeouts | `previewPhase.ts` | ✅ per-phase narration + per-reason timeout explanations | — | ✅ both implementations | 🔧 status-derived narration via `web/lib/previewPhase.ts` on the PreviewPane overlay; no in-page probe on web (cross-origin iframe), so probe reasons stay mobile-only | 🔧 narration fixed; probe-reason lane N/A on web |
| D7 | `hotreload.tsx` start failure | `hotreload.tsx:931` | ❌ 🔧 swallowed everything into "Could not start dev server for X" | — | ❌ 🔧 now propagates the agent's message | n/a | The textbook "client drops the truth" defect |
| D8 | Orphaned dev children | `devserver_child_registry.go` | ✅ | ✅ boot reap + warden | 🟡 via custodian feed — which mobile lacks (L4) | ✅ HousekeepingCard | See L4 |

## 5. Agent lifecycle

| # | Failure | Detected at | Text quality | Self-heal | Mobile UI | Web UI | Gap |
|---|---|---|---|---|---|---|---|
| L1 | Bootstrap / needs-auth | `auth_bootstrap.go:184-205` | ✅ announces NOT serving + names `yaver auth fix` | ✅ strong multi-path: playbook auto-verb, mobile token push + auto-pair sweep, SSH recovery | ✅ "Needs sign-in · tap to sign this machine in" | ✅ dashboard pill + web token push | Best-in-class seam |
| L2 | Auto-update failure | `agent_update_stream.go` phases; pinned-version refusal honestly surfaced | ✅ | ✅ desired-state via Convex, single-flight | 🟡 visible only if stream panel open | 🟡 same | No playbook row recognizes an update failure after the fact |
| L3 | Binary drift / self-heal | `self_heal.go` | ✅ report-only + backups | ✅ | ❌ | 🟡 CLI/doctor | Minor |
| L4 | Custodian findings surface | `custodian_playbook.go` (35 rows, Appendix A) | ✅ remedies in rows | ✅ 21/35 rows auto-apply | ❌ **no mobile custodian surface at all** (`PlaybookCatalog()` exists precisely for this) | ✅ HousekeepingCard with remedy line | A phone-only user never sees what the box auto-fixed or what needs a human |

## 6. Handoff items (2026-07-27) — status at this commit

From `docs/handoff/runtime-runner-auth-oauth-audit-2026-07-27.md`; landed
commits `a63d16ead` (verified auth carried in device status), `b188b205d`
(web green requires verified), `6ca563494` (RuntimeLab invalid-token
recovery), `3949b6b8b`/`88f6dcea1`/`e990bba9e` (runner OAuth routed to target
device; PTY gated on live auth; status on device cards).

| Item | Status | Evidence / remaining |
|---|---|---|
| 1. No false green — Claude/Codex `signed in` requires `authVerified` | see §6a (verified against HEAD in the fix pass) | |
| 2. Devices runner click → OAuth modal, not failing PTY | see §6a | |
| 3. Localhost callback hardening (paste primary, timeout+recovery) | 🟡 server 45s watchdog + callbackPort replay exist; 🔧 this pass fixed the terminal-state machine and panel rendering gaps that stranded the flow | SSH fallback still uses `--console` (§2e) |
| 4. Spread agent-auth recovery beyond Load Targets | 🟡 RuntimeLab done (`isAgentAuthErrorMessage` + Reconnect & Retry) | other surfaces per §6a |
| 5. OpenCode config snapshot first-class | see §6a | |

### 6a. Verified status detail (at HEAD, per-item)

**Item 1 — no false green: PARTIAL.** Done: `deriveRunnerChipStates`
(`DevicesView.tsx`) forces claude/codex to `needs-auth`/"verify needed"
unless `authVerified === true`; agent carries `AuthVerified` end-to-end
(`auth.go`, `tasks.go`); Convex derivation prefers it (`devices.ts`);
`runner_auth_test.go` pins "no verified without a live probe". Missing:
no `verifiedAt`/"verified Nm ago" language anywhere; `deriveRunnerChipStates`
is unexported and untested; a legacy row with `ready:true` but neither
`authConfigured` nor the literal status "ready" can still render green;
no Go test on `GetRunnerInfos` itself (no injectable seam — the probe
helpers are pinned instead). Plus the codex false-AMBER twin (CX1, 🔧).

**Item 2 — Devices runner click → OAuth modal: DONE.** Chip click and
gated PTY launches (`TerminalView`, `WebShellModal` preflight →
`onRunnerNeedsAuth`) route to the per-`{device, runner}` modal with its
own pinned AgentClient and session id; claude/codex sessions cannot cross.

**Item 3 — localhost callback hardening: LARGELY DONE (this pass).**
Paste lanes existed on all four panels; this pass added the agent-side
15-minute whole-session deadline (a session waiting on a callback that
never arrives used to stay `awaiting_browser` until the next spawn reaped
it), elapsed/liveness narration on all panels, terminal-state honesty,
and stale-session detection in the Devices modal. Remaining: SSH fallback
still uses `claude auth login --console` (§2e).

**Item 4 — spread agent-auth recovery beyond Load Targets: 🔧 DONE
(2026-07-27, `3bf874476` + `fca3be788`).** `isAgentAuthErrorMessage` hoisted
to `web/lib/agentAuthError.ts` (with `AGENT_AUTH_REMEDY`); RuntimeLabView's
private copy deleted; ProjectsView inventory (named + Reconnect-and-retry
CTA), PreviewPane task-send + dev-start, and VibeCodingView task/chat sends
(which were also UNHANDLED rejections wedging the busy label) all consume
it. `agentAuthError.test.ts` pins that no view keeps a private copy.

**Item 5 — OpenCode config first-class: PARTIAL (pre-send validation 🔧
DONE 2026-07-27, `3bf874476` + `fca3be788`).** Agent probe, Convex snapshot
with `updatedAt`, web+mobile seeding, and provider-prefix guards exist, and
`web/lib/opencodeModel.ts` now vetoes a `provider/model` the box's probed
snapshot cannot serve BEFORE dispatch (RuntimeLab sendPrompt, VibeCoding
startChatTask + runner-switch fork) with a named error carrying the
provider roster and snapshot age; ignorance (no/empty snapshot) never
vetoes. Remaining: hardcoded `zai-coding-plan/glm-4.7` defaults on ~6 seams
can diverge from a box configured differently when the snapshot is stale;
the agent does not push its opencode summary in the heartbeat, so
mobile-only users can serve stale Convex data; mobile has no pre-send veto.

## 7. Ranked gap list

**P0 — fixed in this pass** (a real failure rendered as a spinner, a lie, or
was surface-exclusive):

1. 🔧 `account_not_eligible` clobbered server-side + unrenderable/wedging on
   3 of 4 web panels (§2a, §2b). Retry-forever UX over a verdict that cannot
   change. Plus a 15-minute whole-session deadline so a callback that never
   arrives fails with a named remedy instead of waiting forever.
2. 🔧 `lastOutputAt` liveness existed only on mobile; web panels showed an
   undifferentiated spinner over a narrating CLI (§2b). All four panels now
   narrate "Started Nm ago · CLI last output Ns ago".
3. 🔧 Web dialog narrated a DEAD session after reap/respawn (live incident,
   §2d): sessionGone detection + restart affordances in the Devices modal;
   agent scanner EOF noise suppressed.
4. 🔧 Codex false-amber after successful OAuth (CX1) + codex silence remedy
   now names workspace-gated device-auth (CX2) + code copy affordances (CX4).
5. 🔧 `explainNoTransport` had zero consumers (T7) and the mobile give-up
   message dropped its cause (T1) — both folded into `connectGiveUpMessage`.
6. 🔧 `hotreload.tsx` swallowed the dev-server start error wholesale (D7) +
   the 412 install affordance was unreachable by construction and its
   `helpHint` named the wrong install for non-node tools (D1a) — yarn/pnpm/
   bun/bunx got real install recipes so the advertised endpoints resolve.

**P1 — status after the 2026-07-27 fix pass** (commits `e3406cdcb` +
`a154a87cc` mobile, `3bf874476` + `fca3be788` web):

6. 🔧 **FIXED** (`3bf874476`, `fca3be788`) Web preview compile-failure card +
   phase narration (D5, D6): `web/lib/compileFailure.ts` + `previewPhase.ts`
   (ports of the mobile originals, regex-parity-tested), consumed by
   PreviewPane (card replaces the blank iframe; overlay header narrates the
   phase) and RuntimeLabView (card over the preview fed by a raw SSE dev-log
   tail, cleared on the next successful compile). Remaining: no in-page
   render probe on web (cross-origin iframe), so probe-reason narration and
   `previewTimeoutExplanation` fire only where a caller can classify.
7. Custodian findings invisible on mobile (L4). *(untouched — large)*
8. 🔧 **FIXED** (`e3406cdcb`, `a154a87cc`) Mobile silent logout on confirmed
   session expiry (T6): `sessionExpired` in AuthContext (both
   confirmed-invalid paths; never on network errors or user logout),
   `SESSION_EXPIRED_NOTICE` banner on login.tsx, wording mirrors web.
   Guard proven by breaking (structural test).
9. 🔧 **FIXED** (`3bf874476`) Web reconnect ladder parity (T2):
   `web/lib/reconnectLadder.ts` pure policy — repair rung once per streak,
   topology rung every 3rd attempt (dashboard registers the Convex re-pull
   as `setTopologyRefreshHook`), terminal stop on device_mismatch, and a
   NAMED give-up preserved in `agentClient.lastConnectError` instead of the
   silent stop at 8. `repairRelayPassword` now also refreshes the cached
   `relayServers` passwords the ladder actually dials with.
10. SPLIT: 🔧 `device_mismatch` (R3) now named terminal on BOTH surfaces
    (`relayDeny.ts` twins, parity-tested; mobile ladder + give-up, web
    connect error pick + ladder stop). ❌ `RelaySessionExpiredAt` dead
    sentinel (R2) remains — agent-side, no readers.
11. 🔧 **LARGELY FIXED** (`e3406cdcb`, `3bf874476`, `fca3be788`) Free-tier/
    bandwidth limits (R13, R14): `classifyRelayLimit` renders compact named
    cards (reset behavior, unmetered direct/tunnel alternative, "a cut
    stream was the cap, not your network") on web PreviewPane + connect
    errors and in mobile's reconnect narration. Remaining: no usage METER
    anywhere (relay `/admin/bandwidth` is still admin-only).
12. CLI headless runner-auth poll drops `account_not_eligible`; SSH fallback
    uses the wrong claude flag (`--console`) (§2e).
13. Web 412 install affordance + D2's promised-but-missing Install button.
14. `deviceId already registered` cross-owner collision has no reason code
    (R9).
15. MCP verb for submit-callback missing (§2e). *(agent files locked during
    this pass)*

**P2:** relay-hint table duplicated across quic.ts/agent-client.ts; three
drifting relay-auth matchers on mobile; WS-fallback streaming constraint
actionless (R18); auto-update failure unrecognized after the fact (L2).

## Appendix A — Custodian playbook inventory (canonical self-heal baseline)

35 rows in `desktop/agent/custodian_playbook.go` (first match wins; AutoApply ✅
means unattended):

| ID | Remedy | Auto |
|---|---|---|
| port-busy-orphan | dev_children_reap | ✅ |
| simulator-all-claimed | runtime_sessions_reap | ✅ |
| avd-system-image-missing | sdkmanager install + recreate AVD | ❌ |
| npm-enoent-wrong-workdir | dev_start workDir=<sub-project> | ❌ |
| keychain-cannot-sign | doctor_build_signing --unlock | ✅ |
| agent-bootstrap-needs-auth | yaver auth fix | ✅ |
| relay-502 | settings_repair_relay | ✅ |
| runner-oauth-expired | runner_auth_status; re-auth in tmux TUI | ❌ |
| dev-server-stale-bundle | dev_restart | ✅ |
| npm-eresolve-peer-deps | npm_install --legacy-peer-deps | ✅ |
| npm-eacces-permissions | agent-managed Node or chown | ❌ |
| npm-cannot-find-module | npm_install --legacy-peer-deps | ✅ |
| npm-lockfile-out-of-sync | npm_install --legacy-peer-deps | ✅ |
| metro-unable-to-resolve-module | dev_restart --reset-cache | ✅ |
| metro-emfile-watch-limit | watchman / raise inotify | ❌ |
| metro-port-8081-taken | dev_children_reap | ✅ |
| hermes-bytecode-version-mismatch | dev_build_native | ✅ |
| rn-sdk-version-drift | npx expo install --fix | ❌ |
| flutter-startup-lock | flutter_unlock | ✅ |
| flutter-no-web-device | flutter_enable_web | ✅ |
| flutter-pub-get-failed | flutter_pub_repair | ✅ |
| cocoapods-incompatible-versions | pod_install --repo-update | ✅ |
| dart-package-sdk-incompatible | upgrade package or pin SDK | ❌ |
| gradle-build-failed | (runner-lane escalation) | ❌ |
| simctl-already-booted | no-op | ✅ |
| simctl-invalid-device | runtime_devices_rescan | ✅ |
| simctl-runtime-not-installed | runtime_families_rescan --from-disk | ✅ |
| simctl-app-launch-failed | ios_app_reinstall | ✅ |
| adb-device-offline-or-unauthorized | adb_restart | ✅ |
| adb-install-signature-mismatch | adb uninstall (warns) | ❌ |
| emulator-no-hardware-accel | install KVM / physical device | ❌ |
| emulator-insufficient-storage | pm clear / larger partition | ❌ |
| android-sdk-not-found | android_sdk_rediscover | ✅ |
| redroid-missing-kernel-modules | modprobe binder_linux ashmem_linux | ❌ |
| convex-privacy-violation | remove/hash field, never widen allowlist | ❌ |

Gap (L4): `PlaybookCatalog()` exports this table for surfaces to render;
only web consumes it.
