# ACP Subscription-Auth Implementation — Handoff 2026-08-12

> Status: **Faz A done + Faz B core done (client/runner/probe live-verified)**.
> Next session starts here. Plan doc: `docs/architecture/ACP_SUBSCRIPTION_AUTH_PLAN.md`
> (still DRAFT — update it with the verified findings below).
>
> All findings below were verified LIVE against real binaries on this Mac on
> 2026-08-11/12 — not from docs.

---

## 1. Verified Faz A findings (correct the plan doc with these)

| Runner | Native ACP? | ACP server | Auth methods | Subscription works? |
|---|---|---|---|---|
| **opencode** 1.18.15 | **YES** | `opencode acp --pure` (stdio JSON-RPC) | `opencode-login` | ✅ full turn loop incl. base64 image block |
| **Claude Code** 2.1.222 | **NO** (no `acp` flag in `--help`) | `@agentclientprotocol/claude-agent-acp` v0.66.0 (npm adapter, installed) | `claude-ai-login` (**terminal type, subscription**), `console-login` (API key) | auth-state ✅; prompt turn → `oauth_org_not_allowed` on the user's account (Anthropic org policy blocks the Agent SDK OAuth client — `claude auth status` shows `max` fine; **not a Yaver defect**; terminal login `--cli auth login --claudeai` is the workaround) |
| **Codex** 0.142.5 | **NO** (no `acp` flag) | `@agentclientprotocol/codex-acp` v1.1.14 (npm adapter, installed) | `chat-gpt` (subscription), `api-key` | ✅ full turn loop on the real **ChatGPT plus** subscription (`~/.codex/auth.json`) |
| **glm** | n/a | retired runner | — | use opencode with `zai-coding-plan/glm-4.7` |

### Wire-protocol facts learned by probing (all in `acp_client.go` header comment)

- Transport: **newline-delimited JSON-RPC 2.0 over stdio**. One message per line.
- Prompt method is **`session/prompt`** (NOT `prompt` → `-32601`), and `prompt` is an **ARRAY** of content blocks: `{type:"text",text}` and `{type:"image",data:<base64>,mimeType}` both work.
- **`session/new` REQUIRES `mcpServers`** (omitting → `-32602`). This is the MCP-injection seam — yaver MCP rides here as a stdio descriptor, which is what makes screenshot→Read-tool work in ACP mode.
- **opencode's schema is STRICT**: stdio MCP descriptor must serialize `env:[]`/`args:[]`/`headers:[]` — under Go `omitempty` a len-0 slice vanishes and opencode returns `-32602`. Fixed with a custom `MarshalJSON` (see §3). codex-acp is lenient; we normalize to the strictest consumer.
- **`auth/status` is NOT implemented by opencode yet** (draft RFD, `-32601`). Auth verdict still comes from the probe path; ACP contributes reachability + auth-methods surface.
- **`clientCapabilities.auth.terminal: true` must be advertised in `initialize`** — without it claude-agent-acp HIDES the terminal subscription method (`methods=[]`); with it you get `[claude-ai-login, console-login]`. opencode ignores it but tolerates it.
- `authenticate {methodId}` returns `{}` on codex chat-gpt (already authed) and opencode-login; claude-ai-login is **terminal type** → must NOT go through authenticate; use `acpTerminalLoginCommand` → `claude-agent-acp --cli auth login --claudeai` (forwards to real `claude` CLI — live-verified).
- `NO_BROWSER=1` env hides codex's `chat-gpt` method (for headless boxes).
- codex-acp `initialize` → `mcpCapabilities: {acp:false, http:true, sse:false}`; supports text + **images**.

---

## 2. Files (all new unless marked)

| File | What it is | Status |
|---|---|---|
| `desktop/agent/acp_client.go` | ACP v1 stdio JSON-RPC client: spawn, initialize, session/new, session/prompt (text+image), session/list, session/close, Authenticate, Logout, MCP descriptors, `MarshalJSON` strictness fix, `clientCapabilities.auth.terminal` | done, tested |
| `desktop/agent/acp_runner.go` | Per-runner launch specs (`acpRunnerSpecFor`), subscription auth-method mapping, **cached ACP probe** (`probeACPAuthState`, 60s TTL / 20s timeout / `invalidateACPProbeCache`), terminal-login command builder | done, tested |
| `desktop/agent/runner_auth_cmd.go` | **modified**: `runnerAuthStatusRow` + `AuthMethod` / `ACPReachable` / `ACPSubscriptionMethod` fields; `enrichRowWithACPAuthState` wired into `collectRunnerAuthStatusRows` (additive, probe fallback kept) | done, live-verified |
| `desktop/agent/runner_auth_browser_http.go` | **modified**: `opencode` case added to `runnerBrowserAuthCommand` (`opencode auth login` through the existing URL-scanning machinery) | **code added but URL-capture UNPROVEN — see §4 blocker** |
| `desktop/agent/acp_client_test.go` | 6 contract tests via a **fake stdio ACP child process** (re-execs the test binary): initialize contract, mcpServers requirement, image blocks, authenticate, stream-closed fallback, method mapping | ✅ all pass |
| `desktop/agent/acp_live_test.go` | 4 **live integration tests** (skip when binary absent; `YA_ACP_LIVE=1` forces): opencode full loop, codex full loop, claude auth-state (documents org-block), terminal-login command | ✅ all pass |

Adapters installed globally (so `resolveRunnerBinary` finds them via `~/.yaver/runtimes/node/bin`):
`@agentclientprotocol/codex-acp` 1.1.14 and `@agentclientprotocol/claude-agent-acp` 0.66.0.

---

## 3. Live-verified behavior (proof, not claims)

```
$ go test -run 'TestACP' -v .      # 11 tests, all PASS (incl. 4 live)
--- PASS: TestACPLiveOpenCodeFullLoop    # session + text+image prompt → end_turn
--- PASS: TestACPLiveCodexFullLoop       # real ChatGPT plus subscription → end_turn
--- PASS: TestACPLiveClaudeAuthState     # auth state OK; turn org-blocked (documented)
--- PASS: TestACPLiveTerminalLoginCommand # claude-agent-acp --cli auth login --claudeai
```

Status enrichment live (via `enrichRowWithACPAuthState`):
```
opencode: authMethod="acp" reachable=true subMethod="opencode-login"  detail="ACP · Login with opencode"
claude:   authMethod="acp" reachable=true subMethod="claude-ai-login" detail="ACP · Claude Subscription"
codex:    authMethod="acp" reachable=true subMethod="chat-gpt"        detail="ACP · ChatGPT"
```

`go build ./...` and `go vet .` are clean. **Do NOT run the full `go test .` in one shot — it exceeds 10 min; use `-run` filters.**

---

## 4. Blocker to solve first in the next session

**opencode login URL capture is UNPROVEN.** Live probe: `opencode auth login` (no flags) opens a **TUI provider picker** (`◆ Select provider — DeepSeek / Z.AI Coding Plan / Other`), and `opencode auth login -p deepseek` goes straight to an **API-key prompt** — neither prints a plain `https://…` line that the existing `urlPattern` scanner (`runner_auth_browser_http.go`) can catch.

Investigate in order:
1. `opencode auth login --help` full output (already seen: `--provider`, `--method` flags exist) — is there a `--method oauth` or a JSON/quiet mode that prints the URL directly? Check opencode source (`sst/opencode`, ACP auth impl).
2. Try `opencode auth login -p openai -m oauth` (or similar) with `CI=1 NO_COLOR=1 TERM=dumb` and see if a URL prints.
3. If the TUI is unavoidable: the browser-auth machinery's TTY-less spawn may need `cmd.Stdin` as a PTY (see `desktop/agent/runner_pty.go` / `creack/pty` already in go.mod) so the picker renders and a scripted keypress selects the provider.
4. Alternative: rely on the ACP `authenticate {methodId:"opencode-login"}` (returns `{}` — need to check what the adapter/TUI does when driven over ACP; may open the browser on the box and print nothing, which the silence-watchdog already handles with a remedy message).

Fallback that ALWAYS works today: the user has opencode API keys (GLM/DeepSeek) via `opencode auth list`, so opencode tasks already run — the login button is a polish path, not a blocker for tasks.

---

## 5. Remaining work (next sessions, in order)

1. **Solve §4** (opencode login URL capture) — the only unimplemented core flow.
2. **`/runner-auth/status` over HTTP** — `curl -H "Authorization: Bearer <token>" localhost:18080/runner-auth/status` and confirm the enriched rows (authMethod/acpReachable/acpSubscriptionMethod) travel the wire. Also check `/agent/runners` (the remote path).
3. **Faz D surfaces** — mobile/web/tvOS runner cards: render `authMethod: "acp"` + `ACPSubscriptionMethod` ("claude.ai · max · via ACP"), and a subscription-login button that POSTs `/runner-auth/browser/start {runner:"opencode"|"claude"|"codex"}`. Grep `mobile/app/(tabs)/`, `web/components/dashboard/` for the runner cards consuming `/runner-auth/status`.
4. **Update the plan doc** `docs/architecture/ACP_SUBSCRIPTION_AUTH_PLAN.md`:
   - Mark Faz A items done with the verified table above.
   - Correct "Claude Code ACP'ye geçiş olduğu biliniyor" → **no native ACP; adapter required**.
   - Correct Faz B checkbox names: `session/prompt` (not `prompt`), `mcpServers` required, `auth/status` absent.
   - Add the `clientCapabilities.auth.terminal` requirement and the `env:[]` strictness finding.
   - Mark Faz B done for the client/probe layer; Faz C partially (adapters wired, login flows pending §4).
5. **Faz B update (2026-08-23)**: the first production task slice is now in
   `task_acp.go`. Eligible fresh OpenCode tasks use native ACP; streamed agent
   chunks feed the existing task and raw-console lanes, selected MCP servers
   enter `session/new`, cancellation and usage are preserved, and startup
   failure falls back before prompt execution. Pinned model/mode, attachment,
   resume/raw/tmux cases intentionally remain on CLI/PTY until their ACP parity
   tests land.
6. **Faz E**: CLAUDE.md/AGENTS.md note, release 1.99.412+, E2E screenshot-task → remote box ACP runner → yaver mcp Read tool.

---

## 6. Context notes for the next session

- The working tree ALSO has unrelated uncommitted work from other sessions: `dom_inspect*.go`, `build_web.go`, `devserver_basehref.go`, `httpserver.go` modifications, `docs/handoff/electron-gui-2026-08-12.md`, `docs/audits/webui-chat-vibing-gui-2026-08-12.md`. **Do not commit ACP files together with those** — separate commits; ask before committing anything (AGENTS.md).
- `git log --oneline -1` is `aa2ac9fc1 docs: ACP subscription-auth plan…` (the plan doc commit, 2026-08-11).
- Machine state: Claude subscription `max` (CLI OK, Agent SDK org-blocked), Codex ChatGPT `plus` (works), opencode with OpenAI oauth + Z.AI Coding Plan + Z.AI + DeepSeek API keys.
- Test hygiene: live tests skip when adapters absent; `YA_ACP_LIVE=1` forces failure instead of skip (use on CI-adjacent checks).
- Key files to read before touching task dispatch: `desktop/agent/runner_session_turn.go`, `desktop/agent/runner_pty_cmd.go`, `desktop/agent/runner_mcp_scope.go` (existing MCP injection for PTY mode — ACP mode replaces it with `acpMCPServersForTask`).
