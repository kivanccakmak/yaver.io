# ACP Subscription-Auth Plan — opencode / Claude Code / Codex

> Status: DRAFT → **Faz A done + Faz B core done (client/runner/probe live-verified)**.
> Updated 2026-08-12 with the verified findings from the handoff
> `docs/handoff/acp-subscription-auth-2026-08-12.md` (live-verified against real
> binaries + real paid accounts on 2026-08-11/12). Faz D surfaces + Faz E
> release still open.
> Amaç: terminalde yapılan **subscription login'lerini** (claude.ai hesabı, ChatGPT
> planı) yaver'ın **tüm client yüzeylerinden** (mobile, webui, tvOS, car, watch,
> wear) görülebilir ve kullanılabilir kılmak — **API key değil**. ACP (Agent
> Client Protocol) bunu standardize etmek için kullanılacak; sadece opencode
> değil, Claude Code ve Codex subscription'ları da kapsanacak.

---

## 1. Problem / Kullanıcı İsteği

Kullanıcı terminalden `codex login` veya `claude` ile **subscription** oturumu
açmış olabilir (ör. ChatGPT planı, claude.ai Max). Ardından:

- Mobil app'ten screenshot attachment'lı task gönderdi → remote opencode
  (deepseek) **yaver MCP olmadan** çalıştı → screenshot verisi okunamadı.
- Web UI'dan vibe etti → proje seçilebiliyor ama **MCP seçilemiyor** (toggle
  external-MCP-var mı koşuluna bağlıydı, fix'lendi ama yaver MCP'nin config'e
  yazılmaması ayrı bir kök neden).

İstenen use case: **terminalde yapılmış subscription login'i, yaver'ın tüm
yüzeylerinden aynı hesabı kullanarak çalıştırabilmek.** API key girmek zorunda
kalmadan. ACP bunu standardize eder.

---

## 2. Mevcut Durum (Deep Audit Sonucu)

### 2.1 Yaver'ın runner auth mimarisi (probe-based)

| Katman | Dosya | Ne yapıyor |
|---|---|---|
| Auth tespiti | `desktop/agent/runner_auth.go` | `claude auth status`, `codex login status` çalıştırır; `~/.claude/.credentials.json` (OAuth), `~/.codex/auth.json` (ChatGPT token) okur |
| Üçlü ayrım | `AuthConfigured / AuthPresent / AuthVerified` | "dosya var ama token revoke" yalanını ayıklar (2026-07-27 incident, revoke edilmiş token `authVerified:true` raporluyordu) |
| AuthSource | `"claude.ai · max"`, `"codex chatgpt"` | Subscription kaynağını yüzeylere bildirir |
| Browser login | `/runner-auth/browser/start`, `codex login --device-auth` | Remote makinede login başlatma (browser yoksa device-code) |
| Yüzeylere yansıtma | `/runner-auth/status` → `authConfigured/authSource` | Web + mobil + tvOS aynı endpoint'i okur |
| Subscription taşıma | "import subscription credentials from an already-signed-in user-owned device" | **Sadece aynı makinede** — token'lar makine-bağlı, kopyalama güvenlik açığı |

**Kritik sınır:** subscription login'i **o makinede** olmalı. Remote box'ta
(ubuntu-4gb) login yoksa, mobil'den task yaver mcp'siz ve o runner'sız çalışır.

### 2.2 Kök nedenler (bu oturumda bulunan)

1. **Screenshot kullanılamadı:** `~/.yaver/runner-mcp/opencode/opencode.json`
   içinde `"mcp": {}` — boş. yaver MCP config'e yazılmamış. Screenshot'lar
   prompt'a `[Attached images — use the Read tool]` olarak ekleniyor; **Read
   tool'u yaver MCP'den geliyor** → MCP yoksa dosya okunamıyor. Agent kodu
   doğru görünüyor (httpserver.go:5046 → runner_mcp_scope.go:216-223); şüphe:
   scoped config eski agent (1.99.410) tarafından yazıldı (kullanıcının oturumu
   o sürümle yapıldı).
2. **MCP seçilemiyor:** `RuntimeLabView.tsx:4387` + `page.tsx:5317` MCP satırını
   `mcpServers.length > 0`'a bağlıyordu → external MCP olmayan kutuda yaver
   toggle görünmüyordu. **Fix'lendi** (`8cb5de3fa`).

### 2.3 Yaver'ın runner'ları nasıl çalıştırdığı

- **opencode:** PTY/TUI üzerinden (`yaver opencode ...`). ACP **kullanılmıyor**.
- **claude/glm:** PTY + scoped `CLAUDE_CONFIG_DIR` (MCP için).
- **codex:** PTY + `--ignore-user-config` + `-c mcp_servers...`.
- MCP kapsamı: `runner_mcp_scope.go` — her task için yaver mcp + seçili
  external MCP'leri env/args ile enjekte eder.

---

## 3. ACP Araştırması (ne sağlıyor)

Kaynak: https://agentclientprotocol.com (v1 stabilize, v2 draft)

| RFD / Bölüm | Ne sağlıyor | Kullanıcı isteğiyle ilişkisi |
|---|---|---|
| `auth-methods.md` (Terminal Authentication) | Terminal'de yapılan login'lerin ACP üzerinden erişilebilirliği | **Tam istenen şey** |
| `get-auth-state.md` | Agent'ın auth durumunu sorgulama | `/runner-auth/status`'un ACP karşılığı |
| `logout-method.md` | Logout | Oturum yönetimi |
| `session-resume.md`, `session-list.md` | Mevcut session'ları keşfetme/devam | Turn/oturum yönetimi |
| `streamable-http-websocket.md` | HTTP/WS transport | Remote (mobile/webui → box) köprü |
| `session-config-options.md` | Model/agent seçimi | Runner model yönlendirme |
| `terminals.md` | Terminal komutları | PTY yerine standardize |

**Runner ACP desteği (VERIFIED 2026-08-11/12 — handoff §1):**
- **opencode 1.18.15:** ✅ **NATIVE ACP** — `opencode acp --pure` (stdio JSON-RPC v1). Auth method: `opencode-login`.
- **Claude Code 2.1.222:** ❌ **no native ACP** (`claude --help` has no `acp` flag — corrected from "geçiş olduğu biliniyor"); the ACP server is the npm adapter `@agentclientprotocol/claude-agent-acp` v0.66.0. Auth methods: `claude-ai-login` (**terminal** type — subscription, args `--cli auth login --claudeai`), `console-login` (API key).
- **Codex 0.142.5:** ❌ no native ACP (`codex --help`); npm adapter `@agentclientprotocol/codex-acp` v1.1.14. Auth methods: `chat-gpt` (subscription), `api-key`. `NO_BROWSER=1` hides chat-gpt on headless boxes.
- **glm:** retired runner — use opencode with `zai-coding-plan/glm-4.7`.

**Wire-protocol facts (verified by probing — handoff §1, all in `acp_client.go` header):**
- Transport: newline-delimited JSON-RPC 2.0 over stdio.
- Prompt method is **`session/prompt`** (NOT `prompt` → `-32601`); prompt is an ARRAY of content blocks — `{type:"text",text}` and `{type:"image",data,mimeType}` (the screenshot-attachment shape) both work.
- **`session/new` REQUIRES `mcpServers`** (omitting → `-32602`) — the MCP-injection seam; yaver MCP rides here as a stdio descriptor (screenshot → Read tool in ACP mode).
- opencode's schema is STRICT: stdio MCP descriptor must serialize `env:[]`/`args:[]`/`headers:[]` (Go `omitempty` drops len-0 slices → opencode `-32602`). Fixed with custom `MarshalJSON`; normalized to the strictest consumer.
- **`auth/status` NOT implemented by opencode yet** (draft RFD, `-32601`) — auth verdict stays on the probe path; ACP contributes reachability + auth-methods surface.
- **`clientCapabilities.auth.terminal: true` MUST be advertised in `initialize`** — without it claude-agent-acp hides the terminal subscription method (`methods=[]`); with it you get `[claude-ai-login, console-login]`.
- `authenticate {methodId}` returns `{}` on codex chat-gpt / opencode-login (already authed); claude-ai-login is terminal type → goes through `acpTerminalLoginCommand` (`claude-agent-acp --cli auth login --claudeai`), never through `authenticate`.
- codex-acp `initialize` → `mcpCapabilities: {acp:false, http:true, sse:false}`; supports text + images.

---

## 4. Hedef Mimari (öneri)

```
Mobile / WebUI / tvOS / car / watch
        │  (HTTP/WS, mevcut /runner-auth/status + /tasks)
        ▼
   Yaver Go Agent (box)
        │
        ├── ACP Client katmanı (yeni: acp_client.go)
        │     └── runner'a ACP üzerinden bağlan: auth-state, session, prompt
        │
        ├── opencode → `opencode acp` (veya `opencode serve`)
        ├── claude code → ACP (destek doğrulanınca) VEYA mevcut PTY+probe
        └── codex → ACP (destek doğrulanınca) VEYA mevcut PTY+probe
```

**İlkeler:**
1. **Additive only** — mevcut probe-based auth'u (runner_auth.go) bozma; ACP
   **ek katman** olarak eklenir. ACP bağlanamazsa probe'a düş.
2. **Subscription kimliği hiçbir zaman makine dışına kopyalanmaz.** Token'lar
   makine-bağlı; uzaktan login, ACP auth-methods ile **uzaktan yeniden login**
   akışıyla çözülür (kopyalayarak değil).
3. **API key yönetimi ayrı kalır** — kullanıcı ACP'yi API key için istemiyor;
   mevcut provider-key yönetimi (opencode provider config) değişmez.
4. **MCP köprüsü korunur** — yaver mcp + external MCP enjeksiyonu ACP modunda da
   çalışmalı (screenshot Read tool'u dahil).

---

## 5. Implementasyon Planı (adım adım)

### Faz A — Doğrulama (DONE 2026-08-11/12, live-verified)
- [x] Claude Code ACP desteğini doğrula → **no native ACP**; adapter `claude-agent-acp` required (terminal auth: `--cli auth login --claudeai`)
- [x] Codex ACP desteğini doğrula → **no native ACP**; adapter `codex-acp` required (chat-gpt subscription works live)
- [x] `opencode acp --help` ile ACP server'ın tam arayüzünü çıkar → native `opencode acp --pure`
- [x] `auth-methods.md` (Terminal Authentication) RFD'sini oku → terminal-type methods + `acpTerminalLoginCommand`
- [x] `get-auth-state.md` RFD'sini oku → opencode does NOT implement `auth/status` yet; probe fallback retained

### Faz B — opencode ACP köprüsü (CORE DONE: client/runner/probe; task-turns over ACP NOT started)
- [x] `desktop/agent/acp_client.go` — ACP JSON-RPC istemcisi (initialize, session/new, auth-state, prompt text+image, session/list, session/close, Authenticate, Logout, MCP descriptors, strict-MarshalJSON, auth.terminal capability)
- [x] Runner ACP launch path (`acp_runner.go` — `acpRunnerSpecFor`, cached `probeACPAuthState` 60s TTL / 20s timeout, `invalidateACPProbeCache`, `acpTerminalLoginCommand`)
- [x] `/runner-auth/status` ACP ile besle (probe fallback korunur) — `enrichRowWithACPAuthState` + `acpAuthStateForRunner` (shared with `/agent/runners`)
- [ ] Task prompt'larını ACP `prompt` turn'ü ile gönderme (PTY yerine) — **deliberately NOT started** (biggest change; touches streaming/capture; guard with break-it test when done)
- [x] yaver mcp enjeksiyonunu ACP modunda koru → `acpMCPServersForTask` + `session/new` mcpServers seam (screenshot Read tool)

### Faz C — Claude Code + Codex subscription (PARTIAL: adapters wired + probe/enrichment live-verified; browser-login flows for claude/codex opencode pending Faz D surfaces)
- [x] Claude Code ACP adapter bağla (auth-state + terminal-login command live-verified; org-block documented)
- [x] Codex ACP adapter bağla (chat-gpt subscription full loop live-verified)
- [x] opencode browser-login URL capture **SOLVED 2026-08-12** — see §4-blocker-resolution below
- [ ] Mobile/webui'den "terminal login'i kullan" butonu → box'ta ACP login akışını başlat (Faz D)

### Faz D — Yüzeyler + güvenlik (NOT STARTED)
- [x] `/runner-auth/status` çıktısına `authMethod: "acp" | "probe" | "apikey"` ekle → done, wire-verified (also on `/agent/runners` + `supportsBrowserAuth` for opencode)
- [ ] Mobile/webui/tvOS runner kartları: subscription durumunu net göster ("claude.ai · max · via ACP") — grep `mobile/app/(tabs)/`, `web/components/dashboard/`
- [ ] Güvenlik testi: ACP bağlantısı kesilirse probe'a düş, yanlış "signed in" yok
- [ ] Kır-geri-yükle testleri (probe → ACP geçişi, ACP çökerse fallback)

### Faz E — Kapanış (NOT STARTED)
- [ ] CLAUDE.md / AGENTS.md güncelle (ACP katmanı, güvenlik sınırı)
- [ ] yaver-cli 1.99.412+ release + tüm makinelere dağıt
- [ ] E2E: mobil'den screenshot task → remote box ACP runner → yaver mcp Read tool

---

## 6. Güvenlik Sınırları (zorunlu)

1. **Subscription token'lar hiçbir zaman makineden makineye kopyalanmaz.**
   ACP auth-methods, uzaktan **yeniden login** akışını kullanır. Kopyalama
   (scp ile ~/.claude/.credentials.json taşıma) yasak — token makine-bağlı,
   kopyalanan token başka makinede revoke görünür.
2. **Yaver çok kiracılı** (relay multi-tenant): ACP köprüsü, yaver'ın mevcut
   `Authorization` + `X-Relay-Password` sınırlarından geçer; ACP session'ı
   cihaz/owner scoped kalır.
3. **API key path'i değişmez** — kullanıcı ACP'yi sadece subscription için
   istiyor; provider key'leri (opencode provider config) ayrı kalır.
4. **Probe fallback her zaman açık** — ACP bağlanamazsa `claude auth status` /
   `codex login status` çalışmaya devam eder. ACP bir "extra", asla tek yol değil.
5. **`OPENCODE_CONFIG_CONTENT` sadece login process'ini etkiler** — açık
   olan `enabled_providers` filtresini atlatmak için enjekte edilir; kullanıcının
   diskteki `opencode.json`'una asla yazılmaz (sst/opencode `config.ts`'te local
   priority ile merge edilir, mergeDeep arrays'i replace eder).

## 7. §4 Blocker Resolution — opencode login URL capture (2026-08-12)

**Blocker root cause (NOT a missing URL print):** `opencode auth login` FILTERS
providers by `config.enabled_providers`. The user's config lists
`["zai-coding-plan","deepseek"]`, so `openai` (the OAuth credential) silently
vanished from the login command and every `-p <provider>` returned
`Unknown provider "<provider>"` — the naive `opencode auth login` hung in the
TUI provider picker because the only selectable providers were API-key ones.

**Working recipe (verified live against opencode 1.18.15 + real paid account):**

```
OPENCODE_CONFIG_CONTENT='{"enabled_providers":["openai"]}' \
  opencode auth login -p openai -m "ChatGPT Pro/Plus (headless)"
```

- `OPENCODE_CONFIG_CONTENT` (JSON config string, merged with local priority —
  verified in sst/opencode `config.ts`) injects an enabled set including
  openai WITHOUT touching on-disk config; only affects that process.
- The **"headless"** method is a plain RFC 8628 device-code flow (clack
  `log.info` → `process.stdout`, no TTY needed):
  `Go to: https://auth.openai.com/codex/device` + `Enter code: MWJI-A4WH0`.
- The URL matches `urlPattern` and the code matches `codexCodePattern` — the
  shared scanner captures both with zero new parsing (opencode rides the
  codex/kimi machine). Method label match is case-insensitive (providers.ts).

**Landed in code:** `runnerBrowserAuthCommand` opencode case → the headless
argv + `OPENCODE_CONFIG_CONTENT` env, returns `"device-auth"`;
`scanRunnerBrowserAuthOutput` captures the opencode device code (gate now
`codex || kimi || opencode`); `runnerSupportsBrowserAuth("opencode")` = true
so surfaces render the "sign in" button. Guards: 
`TestRunnerBrowserAuthCommandOpenCodeHeadless` (argv + env),
`TestScanRunnerBrowserAuthOutputCapturesOpenCodeDeviceFlow` (URL+code capture).

## 8. Bu Oturumda Yapılanlar (bağlam)

- Commit `580389c4a` — cross-surface last-project/MCP Convex sync + relay/agent fix'leri
- Commit `fbcfb2d1b` — diskguard `-dev` + `current.stale` + MCP stale-process guard
- Commit `c66513111`, `7ee4cf5a6` — deploy.sh tüm yüzeyler + versionCode pre-flight
- Commit `b5b996bbf` — ubuntu composer polish kurtarma (cherry-pick)
- Commit `901d8106f` — monetizasyon açılışı (HIDE_PAID_UI false web)
- Commit `00fc1f7db` — mobile HIDE_PAID_UI false
- Commit `8cb5de3fa` — yaver MCP toggle her kutuda görünür (fix)
- Ubuntu-4gb: agent 1.99.410 → 1.99.411, binary temizlik 441M → 53M
- Deploy: web ✓, convex ✓, npm 1.99.411 ✓, TestFlight 512/513 ✓, tvOS ✓,
  Play internal 297 ✓, Wear 298 ✓, TV 300 ✓, XR 301 ✓, visionOS ✓, carplay ✓
- Android Auto: upload devam ediyordu (303)

## 9. Kalan İşler (yeni session)

1. Faz A doğrulamaları (Claude/Codex ACP desteği, RFD okuma)
2. Faz B opencode ACP köprüsü
3. Faz C Claude/Codex subscription
4. Ubuntu'da 1.99.411 ile yaver MCP config yazımını canlı doğrula
   (screenshot Read tool kök nedeninin kapanması)
5. Android Auto upload sonucunu doğrula (`/tmp/android-auto-deploy.log`)
6. yaver-cli 1.99.412 release (diskguard + MCP guard + toggle fix'leri)
7. "Latest MCP" Convex parity testi + visionOS runtime_turn
8. Deploy onayı (web + agent + mobil)
