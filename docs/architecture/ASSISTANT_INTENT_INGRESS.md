# Assistant Integration — Siri / Alexa / Gemini / MCP → Yaver

Deep analysis · 2026-07-25 · source-read on this machine, not device-verified.

**Target utterance (the user's words):**

> *"Hey Siri, with Yaver develop this in Talos with Claude Code."*

> Docs drift; code is truth. Where this disagrees with the files it cites,
> the code wins — fix the doc in the same change.

---

## 0. Verdict

1. **Siri is the only assistant worth native work.** App Intents run
   on-device, in Yaver's own process, with no cloud hop and no account
   linking. It is the only platform where the target utterance is achievable
   at all — and even there, **not as one free-form sentence** (§3.1).
2. **Alexa is the worst fit and is blocked on infrastructure Yaver does not
   have**: Yaver is an OAuth *client*, never an authorization server
   (`web/lib/oauth.ts` only consumes Google/Apple/GitHub/GitLab/Microsoft), and
   Alexa account linking requires a standard auth-code grant against *our*
   endpoint. Defer until a customer asks.
3. **Google Assistant is effectively dead** for this: App Actions /
   `shortcuts.xml` is deprecated, Conversational Actions is shut down, and the
   replacement (App Functions / Gemini extensions) is not shippable. Build
   nothing; keep the ingress generic so it's cheap later.
4. **The real work is not an assistant integration.** Every channel — Siri,
   Alexa, WhatsApp, MCP, watch, glass — needs the *same* missing layer: one
   authenticated **external intent ingress** on the box, with a shared
   resolver (project → machine → runner), a risk gate, and a receipt. Build
   that once; each assistant then costs days, not weeks.
5. **One structural blocker gates every cloud assistant:** the only existing
   cloud→box delivery path resolves `device.publicEndpoints[0]`
   (`backend/convex/whatsapp.ts:197`, used by `deliverWhatsappCommandToAgent`
   in `http.ts:10643`). A NAT'd, relay-only box has no public endpoint, so the
   call fails `no_public_endpoint`. Until relay-mediated ingress exists, Alexa
   / Gemini / remote-MCP would silently fail for most users — the exact
   "inventory says yes, operation says no" class.

---

## 1. What the utterance actually decomposes into

| Fragment | Means | Resolved by |
|---|---|---|
| "Hey Siri" | wake | platform |
| "with Yaver" | app invocation | **required** by `AppShortcut` phrases (`\(.applicationName)`) — the user's natural phrasing already satisfies Apple's rule |
| "in Talos" | project → which device holds it | `userProjects` + `/devices/voice-hints` (spoken machine aliases already exist, `http.ts:3482`) |
| "with Claude Code" | runner selection | `runners` registry (`/runners`) |
| "develop this" | the instruction | free-form text — **the hard part** |
| "this" | a referent | undefined off-app. There is no "current selection" outside the app. Must be dictated explicitly, or bound to a concrete anchor (last feedback item, clipboard, last task). |

Plus two contract facts the phrasing hides:

- **The assistant wants an answer in seconds; the work takes minutes.** Siri's
  in-process budget is short, Alexa's is ~8s. So the intent must **acknowledge
  with a receipt**, never wait for the task. Progress goes out-of-band —
  `NSSupportsLiveActivities` is already `true` and a `YaverActivity` widget
  extension already exists in the pbxproj, so the progress surface is built.
- **"develop this" is a write action on a repo, requested with no screen.**
  The in-app voice core has a spoken risk-confirm handshake
  (`conversationCore.ts` → `carVoiceConfirm.ts`). An assistant channel that
  skips it turns Siri into an unconfirmed way to run destructive work.

---

## 2. Inventory — what exists today

### Strong, and reusable

| Thing | Where | Note |
|---|---|---|
| Surface-agnostic voice core | `mobile/src/lib/voice/conversationCore.ts` | STT → endpoint → judge → risk gate → dispatch → TTS. **RN-only** — a Siri intent runs in a native process where JS isn't running, so it cannot consume this. |
| Intent classifiers | `mobile/src/lib/carMachineSwitch.ts` (`classifyMachineSwitch`), `carSurfaceIntent.ts` (`classifyCarSurfaceIntent`), `carSessionTurn.ts` | Already parse "switch to the mini" style speech. **TypeScript, phone-only.** |
| External command ingress | `desktop/agent/whatsapp_ingress.go` → `POST /integrations/whatsapp/command` (`httpserver.go:348`) | Shared-secret auth. The only third-party→box command path that exists. **This is the seam to generalize.** |
| Placement routing for free | `handleWhatsAppTask` (`whatsapp_ingress.go:72`) | Already does `previewTaskPlacement` → `recordTaskPlacement` → `activateTaskPlacement` → Cloud-Workspace fallback. Any generalized ingress inherits full placement + wake behavior. |
| Runner dispatch | `POST /runner/session/turn` (`httpserver.go:1280`), `POST /tasks` | The commit point. |
| Voice hints per device | `POST /devices/voice-hints` (`http.ts:3482`) | Spoken aliases for machines — already the right primitive for "in Talos". |
| Progress surface | `NSSupportsLiveActivities`, `YaverActivity` extension target | Exists, unused for this. |
| Voice WS on the agent | `desktop/agent/voice_http.go` — `WS /voice/stream` | Full server-side STT/TTS turn loop with provider selection. Useful for a *Yaver-owned* mic, irrelevant to Siri (Apple does the STT). |

### Absent

- **No App Intents, no SiriKit, no `INIntent`, no Shortcuts donation anywhere.**
  `grep NSUserActivity/AppIntent` over `mobile/ios`, `tvos`, `watch` → only
  Expo's `RCTLinkingManager` route handling (`AppDelegate.swift:1071`).
  `NSUserActivityTypes` contains exactly one entry: the Expo index route.
  `UIApplicationShortcutItems` has one home-screen quick action ("Car Voice
  Runtime") — a launcher, not an intent.
- **No OAuth authorization server** (needed for Alexa/Google account linking).
  There *is* a device-code flow (`/auth/device-code*`, `http.ts:5264`) which
  could back a linking page, but it is not the auth-code grant Alexa requires.
- **No relay-mediated cloud→box ingress** (§0.5).
- **The remote MCP server is unauthenticated marketing tooling**
  (`web/app/api/mcp/route.ts` — `yaver_codex_setup`, `yaver_mcp_package_info`,
  …). It does not reach the user's box.
- **Nothing exposes Yaver *to* macOS Shortcuts.** The MCP verbs
  `run_shortcut` / `list_shortcuts` (`mcp_tools.go:1695`) go the other way —
  Yaver calls Shortcuts.

### The privacy constraint that shapes all of it

`promptFreeMetadataBodyDeniedReason` rejects prompt text on
`/tasks/dispatch-intents` and `/tasks/relay-source-intents`. The WhatsApp
bridge threads the needle deliberately: raw message text lives **only inside
the httpAction** while forwarding inline to the agent; Convex stores hashes,
routing metadata, and delivery receipts (`http.ts:10753` comment,
`whatsapp.ts::receiptStart/receiptFinish`). **Any cloud assistant bridge must
copy that shape exactly** — instruction text passes through, never lands.

---

## 3. Platform reality

### 3.1 Siri / App Intents — recommended

**The critical constraint most designs get wrong:** free-form text **cannot**
be a spoken parameter inside an `AppShortcut` phrase. Phrase parameters must be
`AppEnum` or `AppEntity` with resolvable options. So the target sentence does
not work verbatim. The shape that *does*:

```
"Hey Siri, Yaver task in Talos with Claude Code"
      └ project: AppEntity (dynamic options from the user's projects)
                    └ runner: AppEnum (claude-code | codex | opencode)
Siri: "What should I do?"          ← @Parameter(requestValueDialog:)
User: "add Google sign-in to the login screen"   ← dictation, free-form
```

Every `AppShortcut` phrase must embed `\(.applicationName)` — "with Yaver" and
"Yaver task" both satisfy it, so the user's instinct is right.

Implementation facts:

- App Intents can live **in the main app target** (iOS 16+). No extension
  needed — important for an Expo/RN app.
- The intent runs **in the app's process, in the background, briefly**. It must
  ACK, not complete. Return `.result(dialog: "Sent to Talos — I'll tell you
  when it's done.")` plus a receipt, and hand progress to the Live Activity.
- It is **native Swift**: read the session token from Keychain, resolve the
  device, POST. RN JS is not running. This is a **fourth native client** and
  falls under the cross-surface-parity rule — precedent to copy is
  `watch/YaverWatch/SessionClient.swift` / `tvos/YaverTV/AgentClient.swift`.
- **watchOS gets it nearly free** if the intent is compiled into a watch target.
- **HomePod does not.** "Hey Siri" on a HomePod cannot run a third-party app's
  App Intents (no app process). Say so in docs rather than let users discover it.
- CarPlay already has a scene delegate (`YaverCarPlaySceneDelegate.swift`); an
  App Intent complements the existing voice runtime, it does not replace it.

### 3.2 Alexa — defer

Requires all three of:

1. **An OAuth2 authorization server we do not have.** Account linking needs
   auth-code grant at our own `/authorize` + `/token`. `web/lib/oauth.ts` is a
   consumer of five external IdPs; the pieces to build one exist (sessions,
   device-code broker) but it is a security-sensitive new surface on a
   multi-tenant relay product.
2. **Cloud→box delivery that works behind NAT** (§0.5) — missing.
3. **Prompt text through our cloud**, which is only acceptable in the
   WhatsApp inline-forward shape.

UX is also weaker: no natural phrasing (`"Alexa, ask Yaver to …"`), free-form
capture needs `AMAZON.SearchQuery` with a carrier phrase, and the devices sit
in rooms where nobody is coding. **Low value, high cost. Skip unless asked.**

### 3.3 Google Assistant / Gemini — build nothing

App Actions (`shortcuts.xml` + `actions.xml`) is deprecated and Conversational
Actions is shut down; App Functions is not generally available. The honest
Android story today is App Shortcuts + deep links + a Quick Settings tile —
app launch, not voice dispatch. Keep `/integrations/intent` generic so App
Functions is a one-file adapter when it lands.

### 3.4 The two channels worth more than Alexa

- **MCP (ChatGPT / Claude / Codex voice).** Users already speak into ChatGPT's
  voice mode. An **authenticated** remote MCP server that proxies to the user's
  box is arguably the highest-ROI "assistant" integration in this list — and it
  needs the same reachability fix, so the cost is shared.
- **WhatsApp voice notes.** The bridge already ships. Transcribing inbound
  audio messages gives "speak → box" on every platform with **zero App Store
  work and no new auth**. Cheapest real win on the board.

---

## 4. The architecture: one seam, N adapters

Generalize `POST /integrations/whatsapp/command` into
`POST /integrations/intent`:

```
Siri App Intent ─┐
Alexa skill ─────┤
WhatsApp ────────┼──▶ POST /integrations/intent ──▶ resolver ──▶ risk gate ──▶ placement ──▶ runner
Remote MCP ──────┤     {source, project?, runner?,     (Go, shared)              (existing)
watch / glass ───┘      machineHint?, instruction,
                        idempotencyKey}
                                 └──▶ returns {receiptId, resolvedProject,
                                               resolvedMachine, willAsk?} in <2s
```

Non-negotiables:

1. **One resolver, in Go, on the box.** Port `classifyMachineSwitch` /
   `classifyCarSurfaceIntent` / the risk gate into the agent so *every*
   non-RN channel routes identically. A second classifier written in Swift for
   Siri is the two-browser-preview drift wearing a new hat.
2. **Receipt, not completion.** `{receiptId}` returned immediately; the task id
   follows. A receipt with no task after N seconds must **speak the reason** —
   silence here is the same defect as a silent `serve`.
3. **The risk gate applies to screenless channels**, with the spoken confirm
   handshake, or the channel is read-only by policy.
4. **Idempotency key required.** Assistants retry. Siri re-runs intents.
5. **Convex stores no instruction text** — hashes, routing metadata, receipts.
   Same contract as `whatsapp.receiptStart/receiptFinish`.
6. **Auth is per-channel, key-based.** The WhatsApp shared secret
   (`YAVER_WHATSAPP_INGRESS_SECRET`) is fine for a Yaver-operated bridge;
   Siri talks to the box with the *user's own* session token from Keychain and
   must not use a shared secret.

### The blocker to fix first: relay-mediated ingress

Cloud→box today is `fetch(device.publicEndpoints[0] + "/integrations/…")`.
Behind NAT that array is empty and the bridge reports
`no_public_endpoint` — the user hears "the developer machine is not reachable
yet" with no way to act on it. Needed: a relay ingress that forwards an
authenticated intent over the box's existing QUIC tunnel. This is compatible
with the relay's pass-through invariant (relay forwards, box authorizes,
same-owner scoping) but it is **new code and a security-sensitive surface** —
it must not become a way for tenant A to reach tenant B's agent.

Note that Siri, uniquely, **does not need this**: the phone talks to the box
directly over the same LAN/relay path the app already uses. That is another
reason it is first.

---

## 5. Phasing

| Phase | Deliverable | Why this order |
|---|---|---|
| **P0 — days, no store review** | A documented **Shortcuts** recipe (`Get contents of URL` → the box, SDK token) so *"Hey Siri, Yaver task"* works today on iPhone + Mac. Optionally `yaver siri install` to generate it. | Validates phrasing, the receipt contract, and whether "this" is resolvable — before paying for native work. Ships value in a week. |
| **P1** | `/integrations/intent` + Go resolver + risk gate + receipt + idempotency; WhatsApp re-pointed at it (behaviour unchanged). | The shared spine. Everything else is an adapter after this. |
| **P2** | iOS **App Intents** in the main target: project/runner `AppEntity`s, dictated instruction, Live Activity progress. watchOS target gets it nearly free. | The real product. |
| **P3** | Authenticated remote **MCP** + **relay ingress**. | Unlocks ChatGPT/Claude voice *and* every future cloud assistant at once. |
| **P4** | WhatsApp voice-note transcription. | Cheap, broad, no store. |
| **P5 — on demand only** | Alexa skill + OAuth authorization server. | Only if a customer asks. |

---

## 6. False greens to watch for

- **"Siri said OK" ≠ the box got it.** The intent must not report success until
  the ingress returns a receipt id — and a receipt that never becomes a task
  must surface *why*, spoken.
- **`publicEndpoints` non-empty ≠ reachable.** Probe the operation, not the
  inventory. The WhatsApp path already learned this the expensive way.
- **A second intent classifier in Swift** looks like parity and is drift.
- **A dispatch-intent row carrying the prompt** passes review and violates the
  privacy contract — `promptFreeMetadataBodyDeniedReason` is the guard; keep
  the new ingress outside that path entirely.
- **"HomePod works too"** — it does not. Write it down before a user finds out.

---

## 7. Not verified (needs a device / an account)

- Whether an App Intent's background execution budget is enough for
  token read → device resolve → POST on a cold app (expected yes; unproven).
- Whether Siri's dictated instruction parameter survives CarPlay and watchOS
  contexts identically.
Settled elsewhere, and worth not re-litigating: `mobile/app/assistant.tsx` uses
`useVoiceHelper` + `interpretMessage` rather than `createVoiceCore` **on
purpose** — it is the on-device concierge ("do something on this phone"), a
different feature from the voice-*coding* surfaces ("tell my runner to code").
See S3 in `STT_TTS_DEVICE_SYNERGY_AUDIT.md`. A Siri intent belongs on the
voice-coding side: the shared Go resolver, not this path.
