# ACP Subscription-Auth Plan — opencode / Claude Code / Codex

> Status: DRAFT (2026-08-11). Deep-audit sonucu; implementasyon yeni session'da.
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

**Runner ACP desteği:**
- **opencode:** `opencode acp` — ACP server var (yerel `--help` doğrulandı)
- **Claude Code:** `claude --help`'te ACP flag'i görünmedi; son sürümlerde ACP'ye
  geçiş olduğu biliniyor — **doğrulanmalı** (`claude --version`, docs)
- **Codex:** yerel `--help`'te ACP yok; Codex CLI `--acp` veya benzeri —
  **doğrulanmalı**

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

### Faz A — Doğrulama (yeni session'da önce bunlar)
- [ ] Claude Code ACP desteğini doğrula: `claude --version`, `claude --help | grep -i acp`,
      docs. Yoksa: Claude Code'un ACP'ye geçiş tarihi/flag'i araştır
- [ ] Codex ACP desteğini doğrula: `codex --help | grep -i acp`, `codex exec --help`
- [ ] `opencode acp --help` ile ACP server'ın tam arayüzünü çıkar
- [ ] `auth-methods.md` (Terminal Authentication) RFD'sini oku — uzaktan login akışı
- [ ] `get-auth-state.md` RFD'sini oku — auth state sorgulama şekli

### Faz B — opencode ACP köprüsü (ilk implementasyon)
- [ ] `desktop/agent/acp_client.go` — ACP JSON-RPC istemcisi (initialize, session/new,
      auth-state, prompt, session/list, session/resume)
- [ ] `opencode acp`'yi runner olarak başlatma yolu (runner_pty_cmd yerine ACP stdio)
- [ ] `/runner-auth/status`'u ACP `getAuthState` ile besle (probe fallback korunur)
- [ ] Task prompt'larını ACP `prompt` turn'ü ile gönderme (PTY yerine)
- [ ] yaver mcp enjeksiyonunu ACP modunda koru (screenshot Read tool çalışsın)

### Faz C — Claude Code + Codex subscription (ACP destekleri netleşince)
- [ ] Claude Code ACP varsa: aynı acp_client ile bağla; yoksa probe korunur
      ve "subscription import" akışı iyileştirilir (uzaktan login başlatma)
- [ ] Codex ACP varsa: aynı; yoksa `codex login --device-auth` akışını
      `/runner-auth/browser/start`'a tam bağla (mobil'den remote box'ta login)
- [ ] auth-methods RFD'sine göre: mobil/webui'den "terminal login'i kullan" butonu
      → box'ta ACP login akışını başlat

### Faz D — Yüzeyler + güvenlik
- [ ] `/runner-auth/status` çıktısına `authMethod: "acp" | "probe" | "apikey"` ekle
- [ ] Mobile/webui/tvOS runner kartları: subscription durumunu net göster
      ("claude.ai · max · via ACP")
- [ ] Güvenlik testi: ACP bağlantısı kesilirse probe'a düş, yanlış "signed in" yok
- [ ] Kır-geri-yükle testleri (probe → ACP geçişi, ACP çökerse fallback)

### Faz E — Kapanış
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

---

## 7. Bu Oturumda Yapılanlar (bağlam)

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

## 8. Kalan İşler (yeni session)

1. Faz A doğrulamaları (Claude/Codex ACP desteği, RFD okuma)
2. Faz B opencode ACP köprüsü
3. Faz C Claude/Codex subscription
4. Ubuntu'da 1.99.411 ile yaver MCP config yazımını canlı doğrula
   (screenshot Read tool kök nedeninin kapanması)
5. Android Auto upload sonucunu doğrula (`/tmp/android-auto-deploy.log`)
6. yaver-cli 1.99.412 release (diskguard + MCP guard + toggle fix'leri)
7. "Latest MCP" Convex parity testi + visionOS runtime_turn
8. Deploy onayı (web + agent + mobil)
