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
| CX5 | Codex hard failures render the Go "exit status N", not the CLI's own words (no codex failure-line parsing) | exit transition | 🔧 fixed 2026-07-27 (`5f74049e5`): session keeps a bounded sanitized output tail; `applyRunnerBrowserAuthExit` quotes the last meaningful line (skipping sign-in URLs / bare device codes) into `Error` verbatim — `TestRunnerBrowserAuthExitQuotesCLIWords`, guard proven by breaking it |
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
- **SSH fallback** (`runner_auth_cmd.go`): spawned
  `claude auth login --console` — the API-billing flow whose token 401s against
  subscription endpoints; the HTTP path was explicitly fixed to `--claudeai`.
  🔧 fixed 2026-07-27 (`5a90f5d1b`): now `--claudeai`, passed explicitly, with
  the file-top rationale; stale `--console` comments updated with it.
- **MCP verbs**: start/status/submit-code/cancel existed; there was **no**
  `runner_auth_browser_submit_callback` verb, so MCP/phone-connector callers
  could not use the Deliver-callback lane. 🔧 fixed 2026-07-27 (`d61d0b39a`):
  MCP tool + dispatch + `ops runner_auth op=submit_callback` all funnel into
  the same HTTP handler (`validateRunnerBrowserAuthCallbackURL` stays the
  single validation authority); registration + payload-validation tests pin it.

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
| 3. Localhost callback hardening (paste primary, timeout+recovery) | 🟡 server 45s watchdog + callbackPort replay exist; 🔧 this pass fixed the terminal-state machine and panel rendering gaps that stranded the flow; 🔧 SSH `--console` fixed to `--claudeai` (`5a90f5d1b`) | |
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
and stale-session detection in the Devices modal. The SSH fallback's
`--console` flag is fixed to `--claudeai` (`5a90f5d1b`, §2e).

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
12. CLI headless runner-auth poll drops `account_not_eligible` (§2e).
    🔧 the SSH-fallback half — wrong claude flag `--console` — is fixed
    (`5a90f5d1b`); the poll's terminal switch still omits the status.
13. Web 412 install affordance + D2's promised-but-missing Install button.
14. `deviceId already registered` cross-owner collision has no reason code
    (R9).
15. 🔧 **FIXED** (`d61d0b39a`) MCP verb `runner_auth_browser_submit_callback`
    + `ops runner_auth op=submit_callback` (§2e).

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

---

## 8. The runner launch gate — "CHECKING RUNNER AUTH · 12s" (2026-07-27)

Reported live: web dashboard → Devices → click **Codex** on a remote Linux box.
The PTY never opened. A modal sat on *"CHECKING RUNNER AUTH — Checking whether
Codex can run on @linux before opening the PTY · 12s"* and kept counting.

This is the audit's own thesis reproduced exactly: **the inventory said yes
while the product went and asked again, at the user's expense.**

### 8.1 What the gate actually did

`web/components/dashboard/WebShellModal.tsx:165-219` (pre-fix) fired, on every
open of an auth-sensitive launch:

```
agentClient.testRunner(launch, { timeoutMs: 20_000 })
  → POST /agent/runners/test        (web/lib/agent-client.ts:2418)
  → desktop/agent/runner_test_http.go:111 handleRunnerTest
```

Step 4 of that handler (`runner_test_http.go:194-199` → `runRunnerProbe`
`:232-282`) spawns, for codex:

```
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
      --model <model> "Reply with the single word OK and nothing else."
```

That is a **real LLM generation**. Measured against the live box on 2026-07-27:

| Call | Latency | Cost |
|---|---|---|
| `GET /runner-auth/status` | **0.20 s** | none |
| `POST /agent/runners/test` (codex) | **5.30 s** | **6,212 tokens** of the user's paid quota |

…and `/runner-auth/status` was *already* returning the answer the gate was
paying to rediscover:

```json
{"id":"codex","installed":true,"ready":true,
 "authConfigured":true,"authVerified":true,"authSource":"codex login status"}
```

The same `authVerified` flag was **already in the browser** before the click —
`a63d16ead` ("Carry verified runner auth in device status") plumbed it from
`tasks.go::GetRunnerInfos` → Convex heartbeat → `Device["runners"][n]`
(`web/lib/use-devices.ts:113`). `DevicesView.tsx:517` reads it to colour the
chip. The gate ignored it entirely.

Add relay RTT and a slower model and the 5.3 s becomes the user's 12 s.

### 8.2 State machine BEFORE

```
open modal (launch = claude|codex)
        │
        └─► checking ──────────────────────────────────┐  ~5–20 s, PAID
              │                                        │
              ├─ result.ok ─────────────► allowed ─────► mount TerminalView
              ├─ needsAuth+browserAuth ─► blocked  ─────► "Runner needs attention"
              ├─ any other failure ─────► blocked  ─────► "Runner needs attention"
              └─ 25 s stall timer ──────► blocked  ─────► "preflight did not finish"
```

Three defects, not one:

1. **It blocked the terminal on a question already answered.** The device row
   said verified before any network call happened.
2. **It billed the user to re-ask.** Every click of the chip = one paid codex
   generation. A UI affordance must not be a metered API call.
3. **Its only non-`allowed` exit was a dead end.** `blocked` rendered "Runner
   needs attention" — for a signed-in runner whose probe merely ran long. There
   was no state in which a slow or unavailable check still yields a terminal.
   `terminalLaunch` (`:237-239`) was `undefined` unless `allowed`, so the PTY
   was withheld, not merely un-prefilled.

The user's own framing is the correct contract and the code did not implement
it: *if the runner is authenticated, just open the terminal — like an ssh
session with the bypass-permissions command.*

### 8.3 State machine AFTER

The decision is now a pure function, `decideRunnerLaunchGate`, in
`web/lib/runnerLaunchGate.ts` — testable without a clock or a network:

```
                    ┌─ not claude/codex ──────────────► open        (ungated)
                    │
 device.runners row ├─ authVerified && installed && ready ─► open   (device-verified)   0 ms, 0 tokens
   (already in the  ├─ authConfigured===false | status needs-auth ─► sign-in
    browser)        └─ installed===false ────────────► open-degraded (named banner)
                    │
                    ▼ unknown → ONE cheap GET /runner-auth/status, budget 4 s
                    ├─ verified ──────────────────────► open        (probe-verified)
                    ├─ needs-auth ────────────────────► sign-in     → RunnerAuthModal
                    ├─ check errored ─────────────────► open-degraded (names the error)
                    └─ elapsed ≥ 4 s ─────────────────► open-degraded (names the timeout)
```

Contract implemented:

- **Fast path, zero cost.** A row carrying `authVerified` opens the PTY on the
  first render. No request is awaited. This is the everyday case.
- **Bounded slow path.** Only when the row is silent (agent older than
  `a63d16ead`, or `authConfigured` without verification) do we check — against
  `/runner-auth/status`, which asks each CLI about its own login (`codex login
  status`, cached 60 s at `runner_auth.go:930`) and **spends no quota**. The
  bound lives in the decision function, not in a `setTimeout`, so a cancelled
  effect cannot lose it.
- **Fails OPEN, always named.** Timeout or broken check mounts the terminal
  behind an amber banner stating what could not be confirmed, plus a **Sign in**
  button. Failing open is right here: the session already carries the runner's
  bypass-permissions flag, and the runner TUI states its own login need in the
  pane. A spinner states nothing.
- **Not-authenticated routes to sign-in immediately**, from the row alone, with
  no probe first — into the existing `RunnerAuthModal`
  (`DevicesView.tsx:4072`), i.e. browser OAuth on the target box, Claude's
  code/token submission, and the Deliver callback lane.
- **The terminal is never yanked back.** `openedKey` latches the moment any
  decision opens a PTY. A late contradicting answer raises the sign-in modal
  *over* the live session instead of unmounting something the user is typing in.
- **Background corroboration still runs.** The cheap check fires even on the
  fast path; if it contradicts the heartbeat, `onRunnerNeedsAuth` raises the
  sign-in modal over the already-open terminal. Verification never gates.

The load-bearing property is negative and is tested by exhaustive sweep:
**no combination of (runner × row × probe × elapsed) returns "keep waiting"
past the budget, and every terminal state either opens a PTY or hands over a
sign-in with a stated reason.** Proven by breaking it — deleting the fast-path
clause fails 5 tests; restoring it passes 20/20.

### 8.4 Second defect found while verifying — the web PTY died as root

Verifying scope item 4 ("does the PTY carry the yolo flag") surfaced a separate,
independently user-visible bug on the *same* box.

`desktop/agent/console_terminal.go:22` built the `/ws/terminal?launch=claude`
command as a bare `claude --dangerously-skip-permissions`. Measured on the live
root-owned box:

```
# claude --dangerously-skip-permissions -p 'say hi'
--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
# IS_SANDBOX=1 claude --dangerously-skip-permissions -p 'say hi'
Hi! 👋 How can I help you today?
```

Every default VPS/Hetzner agent runs as root. So clicking **Claude** in the web
dashboard opened a terminal that instantly refused — and the refusal blamed the
*user's privileges* for *our* missing environment variable.

The `/ws/runner` path has carried `IS_SANDBOX=1` the whole time
(`runner_pty.go:208-216`, whose own comment records losing it once already).
`/ws/terminal` — the path the web dashboard actually uses — never had it. Same
cross-surface drift the audit keeps finding: **a fix that landed in one of two
implementations is not landed.** `terminalLaunchCommandFor(runner, euid)` now
takes euid explicitly so the root behaviour is testable without running the
suite as root; `console_terminal_launch_test.go` asserts both branches of the
`if command -v tmux` line carry it (the tmux branch is the one that runs, and
the easy one to forget). Proven by breaking it.

### 8.5 What would have told us in ten seconds

Nothing did, and that is the finding. The gate's own narration named the wrong
thing with total confidence: *"This checks a real CLI subprocess, not only the
signed-in badge"* — presented as rigour, when it was the defect. The badge was
right, cheap, and already on screen; the subprocess was slow, billed, and
redundant.

The generalisable rule, and the one this audit keeps re-deriving: **"probe the
real capability, never the proxy" does not license probing it on the click
path.** When a verified answer is already in hand, re-proving it *is* the
regression. Verification belongs in the background or in the heartbeat that
already carries it — never between the user and the thing they asked for.

| Item | File | State |
|---|---|---|
| Gate decision table + tests | `web/lib/runnerLaunchGate.ts`, `.test.ts` | 🔧 |
| Modal rewired to fast path | `web/components/dashboard/WebShellModal.tsx` | 🔧 |
| Paid probe off the click path | was `agent-client.ts:2418 testRunner` | 🔧 |
| Root `IS_SANDBOX=1` on `/ws/terminal` | `desktop/agent/console_terminal.go` | 🔧 |
| Mobile shell has no equivalent gate | `mobile/app/shell.tsx` | ❌ untouched — no gate to fix, but no fast-path narration either |
| `/agent/runners/test` still spawns a paid generation | `runner_test_http.go:194` | 🟡 correct for an explicit "Test" button; must never be on a launch path again |

---

# 9. Connectivity + Vibing — the in-flight session (2026-07-27, second pass)

> Separate pass, separate heading. §1–§8 above are cited by other threads and
> are **not** rewritten here. Scope: what a user actually hits **while a render
> or a coding turn is in flight** — the transport under it, the session behind
> it, and the streams that carry both. Every `file:line` re-grepped at this
> commit.

## 9.1 Headline: the streams had no failure state at all

The 2026-07 pass mapped how failures are *worded*. This pass asked a narrower
question — *what happens when the pipe carrying the words breaks mid-sentence?*
— and found that on both surfaces the answer was **nothing, by explicit design**:

| Carrier | The silence, as written | Effect |
|---|---|---|
| `/tasks/{id}/output` (mobile) | `xhr.onerror = () => { /* silent (matches the previous behavior) */ }` | transcript freezes on its last frame |
| `/tasks/{id}/output` (web) | `catch { /* Silent best-effort stream; callers usually poll task status too */ }` | same, plus the backstop is a lie |
| `/dev/events` (mobile) | `subscribeSse({… onClose …})` — **`onError` never wired**, though `sseClient` has always offered it | Metro/Flutter log tail freezes mid-compile |

Three separate long-lived streams, three independent decisions to treat a
severed connection as a non-event. The user-visible result is identical in all
three and is the worst shape in the project's own rulebook: **a spinner over a
fact the product already had.**

Two aggravating details make this worse than a missing `catch`:

1. **The web comment's backstop does not exist.** "Callers usually poll task
   status too" — the poll (`VibeCodingView.tsx:673`, every 4 s) runs over the
   **same transport** that just died. It fails at the same instant, for the same
   reason. A backstop sharing the failure domain of the thing it backs is not a
   backstop.
2. **The reattach was already supported server-side and nobody could afford it.**
   `streamOutput` (`httpserver.go:4861`) has always replayed on subscribe — but
   it replayed the **entire** transcript, so a client that reconnected either
   duplicated its scrollback or had to discard it. The route existed and cost
   the user their output. *That* is why no surface took it: not an oversight, a
   priced-out remedy.

This is the "money table" pattern from `FAILURE_PLUMBING_ARCHITECTURE.md` §6h in
its purest form — the agent knew, and knowing stopped at the process boundary —
with a twist worth naming: **a route that exists but is too expensive to take is
indistinguishable from a route that does not exist.**

## 9.2 Gap table — connectivity + vibing

Legend as §1. **detect**: `op` probes the real operation · `inv` inventory proxy.
Rank: **P0** renders as a spinner/lie or has no route to a fix that exists.

### 9.2a Streams under an in-flight session

| # | Failure | Detection | Signal | Mobile | Web | Route | Rank |
|---|---|---|---|---|---|---|---|
| S1 | **Task-output stream cut mid-turn** (relay bounce, tunnel break, box drop, phone backgrounded) | none — end swallowed | none | `spin` — frozen transcript | `spin` — same | 🔧 **fixed**: `?since=` resume + `taskStreamRecovery` ladder + narrated reattach + Reattach button | **P0** 🔧 |
| S2 | **Stream closes cleanly with no `done` frame** | — | — | read as benign EOF | same | 🔧 an end with neither `done` nor a local cancel is now an INTERRUPTION regardless of whether an error object exists | **P0** 🔧 |
| S3 | **Re-subscribe replays the whole transcript** | — | — | would duplicate scrollback | same | 🔧 `?since=<bytes>` + `{type:"resume",offset,full}` frame (`httpserver.go:4919-4941`) | **P0** 🔧 |
| S4 | **`/dev/events` drop mid-compile** | `onError` **not wired** (`quic.ts:2284`) | none | `spin` — frozen log tail | (own impl) | 🔧 bounded reattach + `onStreamHealth` line in the activity card | **P0** 🔧 |
| S5 | Web `listTasks` failure rendered as "no tasks" | `.catch(() => [])` | none | ✅ mobile `fetchTasks` `catch {}` keeps the list | ❌ **wiped `taskList` → nulled `activeTask` → cleared transcript → tore down the stream**, silently, every 4 s | 🔧 `null` ≠ `[]`; last known list held | **P0** 🔧 |
| S6 | `/dev/events` slow-subscriber frame drop | `devserver.go` `default:` drop | **no counter, no gap marker** | — | text only | ❌ still open (V6 in the arch doc) | **P1** |
| S7 | Task-stream reattach on **web `PreviewPane`/`RuntimeLabView`/`WebReloadView`/`page.tsx`** | — | — | n/a | ❌ four more `streamTaskOutput` call sites still pass no `onEnd` | the transport now reports; these callers do not listen | **P1** |

### 9.2b Vibing session vs transport

| # | Failure | Mobile (Tasks chat) | Web (VibeCodingView) | Rank |
|---|---|---|---|---|
| V1 | Box drops mid-turn | 🔧 named + reattach ladder + "the task is still running on the box" | 🔧 same | 🔧 |
| V2 | Relay bounces mid-turn | 🔧 cause preserved into the reattach line | 🔧 same | 🔧 |
| V3 | Runner logs out mid-task | ✅ route (`ErrorMessage.tsx` → RunnerAuthModal) | 🟡 CTA gated to `claude/codex/kimi`; opencode is text-only | **P1** |
| V4 | Menu the runner is waiting on | ✅ **works** — traced end to end this pass (see 9.2d); the arch doc's R6 row is **stale** | n/a — web has no session-turn lane at all | ✅ / **P2** (web) |
| V5 | Prompt typed into tmux, never submitted | `200 {ok:true, pane}` — nothing compares the pane tail | n/a | **P0** (unchanged, R5) |
| V6 | Dev server dies mid-render during a turn | ✅ failure overlay + Retry | 🟡 raw text | **P1** |

### 9.2d Correction — the arch doc's R6 ("dropped menu options") is STALE

`FAILURE_PLUMBING_ARCHITECTURE.md` §6c R6 ranks P0: *"`vibe.tsx:143` keeps
`options` on the object and **renders only `error`** — the user sees 'error'
instead of the menu they must answer."* **Traced end to end this pass; it does
not happen.** The chain, every hop re-read at this commit:

| Hop | File | What it does with `options` |
|---|---|---|
| 1 | `runner_session_turn.go:238-244` | 409 body carries `AwaitingChoice:true` + `Options` + `Pane` **and** an `Error` sentence |
| 2 | `quic.ts:9850` | `if (res.ok \|\| res.status === 409) return data` — the 409 body is returned verbatim, **not** thrown |
| 3 | `vibe.tsx:140-143` | maps `awaitingChoice` + `options` onto the adapter result |
| 4 | `carSessionTurn.ts:174-185` | **checks `awaitingChoice` BEFORE the error branch** and formats `Choose: a. b. c.` |
| 5 | `runnerChannel.ts:33-38` → `conversationCore.ts:346` | speaks that line and sets `pendingChoice` so the next utterance is mapped to a digit (`parseSpokenChoice`) |
| 6 | `vibe.tsx onVoiceEvent` | renders the same text as the turn summary |

The ordering at hop 4 is the whole ballgame: because `awaitingChoice` is tested
*before* `!result.ok`, the 409's `Error` sentence never wins. Had the branches
been ordered the other way, R6 would be exactly right — so the row was a
plausible reading of a real 409-plus-error payload, not a fabrication. Web is
**n/a**, not "not consumed": it has no session-turn lane at all
(`grep runnerSessionTurn web/` is empty).

*Rule applied: when the doc and the code disagree, the doc is the bug. Flagged
here rather than edited into the architecture doc, which another thread owns.*

### 9.2c Transport / session rows re-verified at this commit

| # | Row | State |
|---|---|---|
| T7 | `explainNoTransport` had zero consumers | ✅ now consumed via `connectGiveUpMessage` (`DeviceContext.tsx:2111`), pinned by `platformTransport.test.ts` |
| R2 | `RelaySessionExpiredAt` dead sentinel | ❌ **still zero readers**; `/settings/health` still does not exist |
| R9 | cross-owner `deviceId already registered` | ❌ still no reason code — still loops "Reconnecting (n/5)" forever |
| R13/R14 | relay rate/bandwidth limits | 🟡 named on both surfaces; **still no usage meter on any surface** |
| N3 | three drifting relay-auth matchers on mobile | ❌ unchanged (`quic.ts`, `DeviceContext.tsx` ×2) |

## 9.3 What was fixed in this pass

| Fix | Commit | Guard |
|---|---|---|
| Agent `?since=` resume + `resume` frame | `093a70670` (swept by a concurrent session) | `httpserver_task_output_resume_test.go` — 4 cases |
| `taskStreamRecovery.ts` twins + both transports report stream end + mobile/web vibing reattach UI + web task-list wipe | `dba683364` | `web/lib/taskStreamRecovery.test.ts` — 10 cases incl. twin parity |
| `/dev/events` reattach + health line | `3e512df6f` | same suite, `/dev/events` case |

**Guards proven by breaking them**, both required by the brief:

- Pre-implementation, the resume suite failed with
  `resume re-sent bytes the client already had — transcript would duplicate` —
  the exact defect, stated by the test.
- Deleting the `onError` wiring from `subscribeDevEvents` fails
  `subscribeDevEvents must observe stream errors`.

## 9.4 The design rule this pass adds

> **A long-lived stream that closes without being asked has FAILED, and a
> failure the client cannot afford to recover from is a failure with no route.**

Three corollaries, each earned by a row above:

1. **A clean EOF is not consent.** On a stream the server holds open for the
   life of the resource, "no error object" means the tunnel died politely. Both
   surfaces read that as success. Classification must key on *"did I see the
   terminal frame"*, never on *"was there an exception"*.
2. **Price the remedy, not just its existence.** Re-subscribe worked for a year
   and no one used it, because it charged the user their scrollback. Auditing
   for *presence* of a route would have scored this row green.
3. **A backstop inside the failure domain is not a backstop.** "Callers usually
   poll too" is only true while the transport is up — precisely never when it
   matters.

## 9.5 Ranked remainder

**P0 — still open (not touched this pass):**

1. **V5** — a prompt typed into a tmux pane but never submitted returns
   `200 {ok:true}`. The response already carries the `pane` tail that would
   prove it; nothing compares it. Unfalsifiable by construction.

**P1 — ranked:**

2. **S7** — four remaining `streamTaskOutput` call sites on web (`PreviewPane`,
   `RuntimeLabView`, `WebReloadView`, `dashboard/page.tsx`) still pass no
   `onEnd`. The transport reports now; these do not listen, so they keep the
   old freeze. Mechanical follow-up: the seam and the policy already exist.
   *(Three of the four are owned by the concurrent render/dependency thread —
   coordinate before editing.)*
3. **V3** — opencode auth failure is text-only on web while mobile routes it.
4. **S6** — dev-events frame drops to a slow subscriber have no counter and no
   gap marker, so a *partial* stream is indistinguishable from a complete one.
5. **R2/R9** — dead `RelaySessionExpiredAt` sentinel; cross-owner registration
   collision with no reason code (both unchanged since the first pass).
6. **N3** — three drifting relay-auth matchers on mobile, no set a superset of
   another.

**Cross-surface parity note:** the reattach ladder now exists on mobile and web
only. tvOS, watchOS, Wear, car, glass and Electron consume task output through
their own clients and inherit **none** of it — consistent with §6g of the
architecture doc, and unchanged by this pass.
