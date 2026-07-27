# Failure Plumbing Architecture — the route from a broken box to a fixed one

> **Docs drift; code is the source of truth.** Every `file:line` below was read
> at the commit this document landed on. Grep before you act on a row. When this
> doc and the code disagree, this doc is the bug.

**This document is about the PLUMBING and the ROUTE, not the inventory of
failures.** `docs/audits/failure-recovery-audit-2026-07.md` already enumerates
the failure *rows* (relay R1–R20, transport T1–T10, dev-server D1–D8, lifecycle
L1–L4, runner-OAuth §2) and tracks which got fixed. This document asks the
structural question that audit could not:

> **When something breaks, what is the user's next tap — on the surface they are
> actually holding — and does the agent's signal carry enough for that tap to
> exist at all?**

And the follow-on: **when a NEW capability gap appears, does it get all four
layers of plumbing for free, or does someone hand-wire it at the call site?**
Today the answer is *hand-wired*, which is why the audit's D1a, D2 and D7 are
three names for one structural hole.

---

## 0. The four layers, with the fourth reframed

| Layer | Question | The defect when it's missing |
|---|---|---|
| **A. DETECTION** | Does the agent notice — and does the check probe the **real operation** or an **inventory proxy**? | *False green.* "The inventory says yes, the operation says no." |
| **B. SIGNAL** | Does a **structured, named** thing reach the client — status code + typed JSON, an SSE event with fields, a task event, a device-status field? Or bare prose / silence? | *The client cannot branch.* A string forces every surface to invent a regex, and the regexes drift. |
| **C. UI** | Does the surface the user is on render a **named cause** at all — and can it be seen? | *Unfalsifiable product.* A truthful agent plus a client that drops the truth is still a spinner over a known fact. |
| **D. ROUTE-TO-FIX** | **What is the next tap?** Is the remedy *invocable in place*, does invoking it **stream progress**, and does it **return the user to the thing they were trying to do**? | *A dead end with a sentence.* Worse when the sentence names a button that does not exist. |

**Layer D is not "does a remedy exist" — it is "is there a route".** Yaver
almost always has the remedy. It has ~36 streamed install recipes, a browser
OAuth state machine, a relay repair, a 35-row self-heal playbook, and an
escalate-to-a-coding-agent lane. What it mostly lacks is a **path from the
place the user is standing to the remedy that already exists.**

> **The thesis, in one sentence: Yaver *describes* remedies in prose everywhere
> and *routes* to them almost nowhere.**
> The agent has **seven different JSON key names for "the remedy"** —
> `Remedy`, `SuggestedAction`, `HelpHint`, `Hint`, `Fix`, `InstallHint`,
> `NextAction` — and **not one of them carries a `method + path + stream`
> triple a UI could turn into a button.** Every one is a sentence for a human
> to read and then go do something else about.

---

## 1. The headline asymmetry

> **The fixer knows ~36 tools. The detector knows 7. And only the detector can
> raise a structured signal.**

- **Fixer vocabulary** — `metaInstallPlan` (`desktop/agent/install_cmd.go:1090`)
  has real, streamed install recipes for: `yarn pnpm bun bunx git gh uv docker
  sqlite3 vercel convex postgresql[-client] redis-tools redis-server supabase
  mqtt-broker mqtt-clients mobile tmux ffmpeg chromium java maestro appium
  android-sdk flutter webrtc-stack remote-runtime claude codex opencode tdd
  backend-dev pre-commit pytest ruff vitest eslint prettier`, plus
  `lookupIntegration` and the Convex `PackageRegistry`.
- **Detector vocabulary** — `detectProjectPreparation`
  (`desktop/agent/devserver_http.go:762-815`) can only ever emit
  `node npm npx yarn pnpm bun bunx`. Its own test says so out loud:
  *"The full vocabulary detectProjectPreparation can emit"*
  (`devserver_install_gate_test.go:20-22`).
- **And the detector is gated behind `package.json`** —
  `devserver_http.go:1806` calls `readProjectPackageManifest`
  (`devserver_http.go:1081`, a plain `os.ReadFile(workDir/package.json)`) and
  **skips the entire 412 preflight when it errors.** Flutter has `pubspec.yaml`.
  Go, Rust, Python, Swift and Kotlin have none of the above. For every non-Node
  project on earth, the one structured refusal in the product is structurally
  unreachable.

So the single seam that produces a machine-readable capability gap
(`412` + `{missingTools, installEndpoint, installable, helpHint}`) is **welded
to the Node ecosystem**, while the machinery that would *fix* 36 tools sits
behind it, reachable only by typing a CLI command the phone cannot type.

---

## 2. Three worked examples — same architecture, three shapes of "no route"

### 2a. Flutter not installed — *the route existed and was invisible* (2026-07-26)

The agent said `exec flutter: executable file not found in $PATH`. The phone
said *"Waiting for the dev server to report its address…"*. `POST
/install/flutter` worked the whole time (`install_http.go:89-119`), including
`flutter_install.go`'s git-clone path for `linux/arm64` where Flutter ships no
tarball.

The exact path, and where the route dies:

1. `POST /dev/start` → `devserver_http.go:1802-1830`. Preflight needs
   `package.json`; Flutter has none → **skipped**. No 412 possible.
2. `mgr.Start` (`devserver.go:508`) returns *before* the process is spawned —
   `devserver.go:723`, *"Launch start in background — don't block the HTTP
   response"*. **The HTTP response is 200 OK on a start that is already
   doomed.** Every synchronous refusal lane is bypassed by construction.
3. The goroutine fails; `annotateDevStartError`
   (`devserver_start_remedy.go:96`) → `devStartRemedy` (`:46`) →
   `missingToolchainRemedy` (`:207-233`).
4. `missingToolchainRemedy` is **good code**: it validates its own advice
   against BOTH real plan tables (`metaInstallPlan` + `lookupIntegration`) in
   the same order `yaver install` consults them, so it can never name an
   installer that would 404. Rule "never advertise a remedy the product
   refuses", done right.
5. …and then it is flattened into **prose appended to a string**:
   `msg + "\n\nWhat to do: " + remedy` (`devserver_start_remedy.go:104`),
   landing in `/dev/status.error` and
   `DevServerEvent{Type:"error", Message: …}` (`devserver.go:778-783`).
6. Mobile renders that string as **body text under an alert icon, no button**:
   `mobile/app/(tabs)/apps.tsx:3120-3125`. The sibling implementation
   `mobile/src/components/DevPreview.tsx:1029` offers **Retry** and **Fix in
   Yaver** — but no Install.

The string it renders literally reads *"or use Install on the preview panel,
which streams the download"*. **There is no Install button on any preview panel
on any surface.** The only consumers of `installEndpoint` in the entire client
tree are `mobile/app/(tabs)/apps.tsx:1315` — on the *synchronous* start-throw
path a Flutter start never takes — and `web/lib/agent-client.ts:4938-4946`,
which parses the typed fields and immediately **folds them back into a string**
no web view branches on.

And note what `DevPreview.tsx:1067` offers instead: **"Fix in Yaver"**, i.e.
spend an LLM run, for a class whose deterministic one-command fix already
exists. **Escalating a known capability gap to a coding agent is the most
expensive possible answer to the cheapest possible question**, and on that
surface it is the default answer.

> **Lesson: a remedy that is prose is not a route.** The agent had the tool
> name, the endpoint, the stream name and the arch-resolution in typed form,
> and threw all four away to build a sentence.

### 2b. The PTY launch gate — *an unbounded preflight is a failure with no route*

Clicking Codex/Claude in web → Devices sits on **"CHECKING RUNNER AUTH · 12s"**
instead of either opening the terminal or routing into OAuth.

`web/components/dashboard/WebShellModal.tsx:164-215` gates the PTY behind
`agentClient.testRunner(launch, {timeoutMs: RUNNER_PREFLIGHT_TIMEOUT_MS})`
(`:44`, 20 s) with a stall guard at `RUNNER_PREFLIGHT_STALL_MS` (`:45`, 25 s).
The probe itself is *correct* — `POST /agent/runners/test`
(`desktop/agent/httpserver.go:402`) runs a real CLI subprocess rather than
trusting the signed-in badge, which is exactly the "probe the operation, not
the inventory" rule. The panel even narrates elapsed seconds and names the
endpoint (`:291-305`).

The architecture defect is not the probe, it is **where the probe sits**:

- It is **advisory verification placed in the critical path of the operation it
  annotates** — the repo's own hard rule forbids exactly this ("Advisory work
  must never sit in the critical path of the operation it annotates… degrade to
  empty rather than block").
- It converts a **binary route decision** ("open the shell" vs "start OAuth")
  into a **third state that is neither** — up to 25 s of wall in front of a
  capability that, in the signed-in case, was usable at millisecond zero.
- A bounded wall is still a wall. Narrating the wall well does not make it a
  route.

**The contract this should satisfy** (as stated by the user): authenticated →
open immediately, like an ssh session, with the bypass-permissions command; not
authenticated → drive the remote OAuth flow *including* Claude's token/code
submission. The architecture that yields it: **launch optimistically, let the
probe route rather than gate.** Open the PTY now; run `testRunner` alongside;
if it returns `needsAuth`, overlay the OAuth route *on top of* the live
terminal (`onRunnerNeedsAuth` already exists at `:198`). The user is never
worse off than an ssh client, and the failing case gains a route instead of a
countdown.

*(Another thread is implementing this in `WebShellModal.tsx`; this document
records the architecture lesson only and does not touch that file.)*

### 2c. The mobile action sheet — *the route rendered at zero height* (fixed, `40eec39ef`)

Build 482 showed **zero visible lanes** for `yaver/mobile`. The compatibility
`errors[0]` is a multi-KB per-module wall, rendered **unbounded above** the
lanes `ScrollView` (`mobile/app/(tabs)/apps.tsx:2649`), so diagnostics consumed
the whole sheet and the one lane the agent *did* offer — Browser Reload,
marked primary — sat at zero height. The user's report: *"can't reload yaver
with browser path"*, while the capability existed the entire time.

Fix (`40eec39ef`): diagnostics capped at `numberOfLines={4}` (errors, warnings,
`lastBuildError`) and `actionSheetScroll` given `minHeight: 200` — *"the lanes
are the sheet's reason to exist"*.

> **Lesson: layer C is not only "is it rendered", it is "can it be seen".**
> Diagnostics are advisory; the route is the product. A layout in which
> advisory text can squeeze the route to zero is the same defect as advisory
> work blocking the operation (2b) — advisory content winning over the
> operation, once in time, once in pixels.

**The three together give the general rule:** a route can be missing because it
was never built (2a), because something *blocks* it (2b), or because something
*crowds it out* (2c). All three read to the user as "Yaver can't do this",
while Yaver could.

---

## 3. Signal carriers — what a failure can travel on

**There is no canonical error envelope.** `jsonError` (`httpserver.go:5926`)
emits `{ok:false, error:"<prose>"}` — one string, no code, no remedy, no route.
A second, unrelated writer `writeJSON` (`httpserver.go:18868`) bypasses even
that convention. Everything structured is ad-hoc at the call site.

| Carrier | Produced at | Shape | Route-bearing? |
|---|---|---|---|
| `jsonError` | `httpserver.go:5926` | `{ok:false, error:string}` (+`hint`,`checkoutUrl` only when `YAVER_CLOUD_TENANT=1`) | ❌ prose only |
| `writeJSON` | `httpserver.go:18868` | arbitrary | ❌ no convention |
| **412 dev-start refusal** | `devserver_http.go:1818-1827` | `{error, missingTools[], packageManager, hermesCompiler, installEndpoint, installable, helpHint}` — **an untyped inline map, one call site, no Go struct** | 🟡 **the only route-bearing payload in the product** (`installEndpoint`), and it is Node-only |
| `/dev/events` SSE | `DevServerEvent`, `devserver.go:141-197` | 30+ fields for *progress* (`phase`, `pct`, `done/total`, `etaMs`, `progressSrc`, `snapshot`) — for failure, **`Type:"error"` + `Message string`, nothing else** | ❌ the richest channel in the product carries failures as prose |
| `/dev/build-native` refusal | `devserver_http.go:3554`, `:3953` | inline maps with `helpHint`; typed only client-side in `mobile_client.go:241 BuildNativeBundleResult{Code, HelpHint, …}` | ❌ |
| `IncidentEvent` | `incidents.go:22-45` | `Code, Category, Title, UserMessage, TechnicalInfo, SuggestedAction, Recoverable, LogRefs[], Metadata` | ❌ `SuggestedAction` is prose; no endpoint. **Richest structured shape in the codebase and no client keys off `code`.** |
| `OperationState` | `operations.go:9`; `/operations/stream` SSE | joins ops→incidents via `IncidentIDs` | ❌ |
| `CustodianFinding` / `PlaybookEntry` | `custodian.go:78` / `custodian_playbook.go:46` | `Problem, Action, Outcome, Remedy` / `Match(regexp), Verb, Args, AutoApply, Remedy` | ✅ **`Verb`+`Args` IS a route** — and it is web-only (audit L4) |
| `CapabilityTargetReadiness` | `capabilities_snapshot.go:12` | `Enabled, ReasonCode, Reason, SuggestedAction, Notes[]` | ❌ prose action. **Closest to the right type; one read-only endpoint, one consumer (`quic.ts:4418`).** |
| `reason_codes.go` | `desktop/agent/reason_codes.go:3-18` | 14 dotted codes (`connectivity.no_viable_transport`, `runner.claude.auth_required`, `reload.dev_server_unavailable`, `build.hermes.failed`, `deploy.testflight.xcode_missing`, …) | **the wire contract already exists — and has ZERO client readers** |
| `LogStream` / `GET /streams/<name>` | `logstream.go:23-75`; routes `httpserver.go:470-471` | `{"type":"line","text":…}`, terminal `{"type":"result","status":"ok"\|"error"}` | ✅ **the layer-D transport, and it works.** Only its call sites are missing |
| `RecoveryContext`/`RecoveryKind` | `recovery.go:26-67` | 14 kinds incl. `RecoveryMissingRuntime`, `RecoveryDevCompatMissingTools` | 🟡 routes to an **LLM prompt**, not a deterministic fixer |
| Convex heartbeat | `auth.go:1810 SendHeartbeat` → `backend/convex/devices.ts` | flat map: `relayConnected`, `runners[] (RunnerInfo{AuthConfigured, AuthVerified, AuthSource, Warning, Error})`, `deployCapabilities`, `recoveryPosture` | ❌ state, no route |
| `/health`, `/info` | `httpserver.go:3057`, `:3100` | `authExpired` (`:3070`), lifecycle, runner | 🟡 one boolean that a client turns into a route |
| `/doctor/*` | `doctor_transport.go:20-71`, `doctor_surfaces.go:39`, `doctor_build.go:37` | `Remedy`, `InstallHint` | ❌ prose; CLI + web only |
| `/settings/health` | **does not exist** — only a comment at `main.go:11443` | — | confirms audit R2: `RelaySessionExpiredAt` (`config.go:56-62`, written `main.go:11454`) has **zero readers** in Go or TS |

**Count of parallel capability-gap representations: at least seven typed**
(`CapabilityTargetReadiness`, `preflightResult`/`preflightDep`
`build_preflight.go:53/41`, `DeployCapability` `deploy_capabilities.go:99`,
`PlaybookEntry`, `CustodianFinding`, `IncidentEvent`,
`PreviewCapabilityReport` `preview_capability_probe.go:54`) **plus two
untyped inline maps** (the 412 and the build-native refusal) that are the ones
clients actually hit, **plus** `projectPreparationStatus`
(`devserver_http.go:184`) — a detection record with **no remedy field at all**,
so the remedy is re-derived at ~9 call sites.

`MissingTools` is a field name on **three unrelated structs**. `Installable`
exists twice with **different meanings** (`build_preflight.go:67` = "every dep
is Auto"; `devserver_http.go:1824` = "the agent has a recipe for the first
missing tool"). Three non-overlapping vocabularies describe "what went wrong":
`reason_codes.go` (14, agent-internal), `RecoveryKind` (14, client→agent only),
`custodian_playbook` IDs (35, web-only).

---

## 4. Classifier seams — the client re-derives what the agent already knew

Because layer B is prose, every surface reconstructs the class with a regex.
**There is no structured-code lookup anywhere on either client** — no client
reads `reason_codes.go` values, incident `code`, or `reasonCode`. The one
exception, `probeWithRepair.ts:100`, matches a code **minted client-side** in
`deviceStatus.ts:370-375`, not one received from the agent.

| Seam | Mobile | Web | Kind | Parity |
|---|---|---|---|---|
| compile failure | `mobile/src/lib/compileFailure.ts:41` (regex `:25`, `:50`) | `web/lib/compileFailure.ts:44` (`:28`, `:53`) | regex over a string | ✅ tested twins |
| preview phase | `previewPhase.ts:31`, `:62` | `web/lib/previewPhase.ts:25` | switch over **locally minted** reasons | ✅ |
| relay deny | `relayDeny.ts:24-33` | `web/lib/relayDeny.ts:24` | substring on `reason=…` | ✅ |
| relay limit | `relayDeny.ts:44-69` | `web/lib/relayDeny.ts:44` | **regex capturing MB numbers out of prose** — most fragile matcher in the tree | ✅ |
| repair rung | `probeWithRepair.ts:100` | `web/lib/reconnectLadder.ts:22-61` | code lookup / substring | 🟡 |
| agent auth error | `DeviceContext.tsx:672-680` | `web/lib/agentAuthError.ts:20-32` — **8 substrings including bare `"http 401"`/`"http 403"`** | classifying a status code by parsing its own rendered string | 🟡 |
| relay hint table | `quic.ts:1260-1266` | `web/lib/agent-client.ts:23-27` | status-code lookup, **duplicated and already drifted** (web is missing mobile's 401 row) | ❌ |
| relay-auth-shaped | `quic.ts:7354` (4 patterns) · `DeviceContext.tsx:672` (4, **different**) · `DeviceContext.tsx:2646` (8, **different again**) | `reconnectLadder.ts:51-55` | substring | ❌ **three drifting sets on mobile; no set is a superset of another** |
| no-transport | `platformTransport.ts:102`, `:128` | n/a | capability table — sound | ✅ |
| **capability gap** | **absent** | **absent** | — | **the missing module** |

`relayDeny.ts` is the shape everything else should have: the relay emits a
**reason code** (`relay/server.go:1073-1096`) and both clients do a *lookup*.
It is — not coincidentally — the best-covered failure family in the 2026-07
audit.

---

## 5. Route inventory — layer D exists and is mostly unreachable

Every install is a **two-call protocol**: `202 {ok,tool,stream}` then a
*separate* `GET /streams/install:<tool>` subscribe. **No route streams its own
remedy inline.** A client that fires `/install/x` without separately
subscribing gets a spinner with no output — the exact failure mode this
document keeps re-finding.

| Route | Where | Streams? | Reachable from an affordance? |
|---|---|---|---|
| `POST /install/<tool>` | `install_http.go:21-174`; reg `httpserver.go:1170-1171` | ✅ via `/streams/install:<tool>` | 🟡 **one** call site: `apps.tsx:1315`, Node-family only |
| `GET /install/list` | `install_http.go:221` | one-shot | 🟡 catalogue views |
| `POST /install/sudo` | `install_http.go:181` | n/a | 🟡 |
| `GET /streams/<name>` | `httpserver.go:470-471`, `logstream.go` | ✅ SSE | ✅ where wired |
| `/runner-auth/browser/{start,status,cancel,submit-code,submit-callback}` | `httpserver.go:417-421` | ❌ **one-shot each, polled** | ✅ 5 panels — this poll-not-stream shape is why the web dialog narrated a dead session (audit §2d) |
| `/runner-auth/{status,set,setup}` | `httpserver.go:403-409` | one-shot (`?live=1` re-probes) | ✅ |
| `POST /agent/runners/test` | `httpserver.go:402` | one-shot, ≤20 s | 🟡 used as a **gate** (see §2b) |
| `POST /agent/update` | `agent_update_stream.go` | ✅ phases | 🟡 only if the panel is open |
| `GET\|POST /agent/self-heal` | `httpserver.go:392-399` | one-shot | ❌ CLI/doctor |
| `POST /agent/runner/restart` | `httpserver.go:453` | one-shot | 🟡 |
| `/auth/recover`, `/auth/recover/session`, `/auth/pair/*`, `/auth/factory-reset` | `httpserver.go:542-621`, `auth_bootstrap.go:278-279` | one-shot | ✅ mobile + web |
| `POST /recover` | `httpserver.go:1105` → `recovery.go:70 BuildRecoveryPrompt` | ✅ task stream | ✅ "Fix in Yaver" (`DevPreview.tsx:1067`) |
| `POST /custodian/sweep` · `/custodian/events` · `/custodian/playbook` | `httpserver.go:972-975`, `custodian_http.go:47,89` | sweep one-shot; events ✅ SSE | ❌ **web only** — a phone-only user never sees what the box fixed or what needs a human |
| `/incidents`, `/incidents/stream` | `httpserver.go:488-491`, `incidents_http.go:45` | ✅ SSE | ❌ web only |
| `/dev/{start,stop,reload,reload-app,build-native}` | `httpserver.go:981-990` | one-shot + `/dev/events` side channel | ✅ |
| `/settings/repair-relay` | **not an agent route — Convex** (`agent_mesh_remote.go:1070`) | one-shot | ✅ both surfaces |

Note the last two rows against each other: **the most-invoked remedy in the
product (relay repair) does not live on the agent at all**, while the agent's
own richest remedy feeds (incidents, custodian) reach exactly one surface.

---

## 6. THE FAILURE × ROUTE MATRIX

Legend — **detection**: `op` = probes the real operation · `inv` = inventory
proxy · **signal**: `struct` = typed/coded · `str` = bare prose · `—` = silence.
**UI**: `route` = a tap that starts a fix · `named` = named cause, no tap ·
`text` = raw string · `spin` = spinner/silence. Gap-rank: **P0** a real failure
renders as a spinner, a lie, or has no route to a fix that exists; **P1**
route exists on one surface only, or is prose-only; **P2** cosmetic/duplication.

### 6a. Capability gaps (the Flutter family)

| # | Failure | Detection | Signal | Mobile | Web | Route-to-fix | Rank |
|---|---|---|---|---|---|---|---|
| C1 | **Non-Node toolchain missing (flutter/dart/java/xcode/adb)** | `op` at spawn (`devserver.go:724`) — but **after** a 200 OK | `str` (`devserver_start_remedy.go:104` → `/dev/status.error`, SSE `Message`) | `text` `apps.tsx:3120-3125` · `DevPreview.tsx:1029` → Retry + *Fix in Yaver* | `text` `PreviewPane.tsx:1177` (a log line) | **`POST /install/<tool>` exists, no surface offers it.** Remedy string names a button that does not exist | **P0** |
| C2 | **412 preflight cannot fire for non-`package.json` projects** | gated `devserver_http.go:1807` | none | `spin` | `spin` | — | **P0** |
| C3 | Node-family tool missing (npm/bun/pnpm/yarn) | `op` `commandExists`→`lookPathWithRuntimes` `devserver_http.go:757` | **`struct`** 412 `:1818-1827` | **`route`** `apps.tsx:1315-1377` — Install button, `subscribeStream`, auto-retry `startDevServer` | `text` — `agent-client.ts:4930-4947` parses the typed fields then flattens them; `PreviewPane.tsx:1177` renders a log line | ✅ mobile only; **web has no install affordance anywhere** | **P1** |
| C3a | Post-D1a inversion: `installable:false` is now **unreachable** — `MissingTools ⊆ {node,npm,npx,yarn,pnpm,bun,bunx}` and every member has a recipe, so `devInstallHelpHint`'s "install manually" branch (`:1010`) is dead code for `/dev/start` | — | — | — | — | the gate is fine; the **vocabulary** is the constraint | note |
| C3b | 🔧 **`helpHint` named a stream path that does not exist** — it said `streamed to /streams/install`, while `handleInstall` opens `install:<tool>` (`install_http.go:46`) served at `/streams/<name>`. A user following the remedy watched a 404 and concluded the install was hung | — | — | — | — | **fixed in this pass**: `installStreamPathForEndpoint` (`devserver_http.go:1011-1022`) + `TestDevInstallHelpHintNamesTheRealStreamPath`, guard proven by breaking it | 🔧 |
| C4 | Mobile 412 alert copy hardcoded to Node | — | — | shows *"Install Node LTS into ~/.yaver/runtimes/node"* for bun/pnpm (`apps.tsx:1326`) | — | route works, sentence lies | **P1** |
| C5 | `DevPreview.tsx` has **no** missing-runtime branch at all | — | — | `text` only | n/a | cross-surface drift **inside one app** | **P1** |
| C6 | Install stream has no bytes/elapsed | — | `{"type":"line","text"}` `logstream.go:42` | one truncated line in `quickActionStatus` | — | a 1.2 GB SDK behind a line-only stream | **P1** |
| C7 | **`installNodeBackedCLI` reports success without installing** — it writes a 4-line `exec npx -y <pkg>` shim into `~/.local/bin` (`install_cmd.go:1594-1595`) and returns ok; the real download happens lazily on first invocation, outside any stream. `~/.local/bin` is not guaranteed to be in `lookPathWithRuntimes`, so `commandExists("bun")` can stay false → **412 → install → 412 loop** | `inv` | false `{"status":"ok"}` | spinner→retry→same 412 | — | none | **P0** |
| C7a | Same function shims **the wrong package for `bunx`** — `metaInstallPlan` passes `pkg="bun"` (`install_cmd.go:1097-1100`), so `~/.local/bin/bunx` execs `npx -y bun` | — | — | — | — | — | **P1** |
| C8 | **Flutter installs, then is still "not found"** — `ensureFlutterShellPath` (`flutter_install.go:192`) writes `~/.profile`; the running agent never re-reads PATH, and its own progress line admits *"open a new shell to pick it up"* (`:222`). Unless `flutterRoot()` is in `runtimeBinDirs()`, the very next detect fails | `inv` | success | — | — | the install succeeded and the product says it did not | **P0** |
| C9 | **`yaver install wda` is advertised and does not exist** — `remote_runtime_target.go:193,199,211` name it as the remedy for unsupported gestures; `wda` is in neither `integrations` nor `metaInstallPlan`, so `POST /install/wda` 404s (`install_http.go:137`) | — | `str` | `text` | `text` | **a remedy the product refuses** — the exact 2026-07-26 defect, still live | **P0** |
| C10 | Runner binary absent (claude/codex/opencode) | `op` `resolveRunnerBinary` `install_cmd.go:1545` | `str` → 500 | `Alert` no action `tasks.tsx:3345` | picker **filters uninstalled runners out entirely** `VibeCodingView.tsx:663,699` | `POST /runner-auth/setup` w/ `install_if_missing` (`runner_auth_setup.go:239`) exists — **blocking 10-min POST, no streaming** (`runner_auth_http.go:213`), and is called only from onboarding, never from a composer | **P1** |

### 6b. Preflights and layout that block a route

| # | Failure | Detection | Signal | Mobile | Web | Route-to-fix | Rank |
|---|---|---|---|---|---|---|---|
| G1 | **PTY launch gated on a ≤25 s runner probe** | `op` ✅ `POST /agent/runners/test` `httpserver.go:402` | `struct` (`needsAuth`, `supportsBrowserAuth`) | n/a | `named` + countdown `WebShellModal.tsx:291-305` | ✅ `onRunnerNeedsAuth` `:198` — but only *after* the wall. Advisory work in the critical path | **P0** |
| G2 | **Action-sheet diagnostics squeeze lanes to zero height** | n/a | n/a | 🔧 fixed `40eec39ef` (`numberOfLines={4}` + `minHeight:200`) | n/a | route existed at zero pixels | fixed |
| G3 | `/dev/start` returns 200 on a doomed start | — | — | — | — | every synchronous refusal lane bypassed (`devserver.go:723`) | **P0** |

### 6c. Remote runner — Tasks surface and Vibing surface

`POST /tasks` returns **201 Created with `status:"failed"`** on a runner that
cannot start (`httpserver.go:4747`) — deliberately, so the task row exists. The
consequence is that **no HTTP status distinguishes "your runner is broken" from
"your task ran"**. And `/tasks/{id}/output` SSE has exactly three event types —
`output`, `done`, `agent_question` (`httpserver.go:4891,4901,4914`). **There is
no `error`, no `runner_auth_required`, no `capability_gap` event.** Every named
failure below arrives as free text inside `output`, then `done{status:"failed"}`.

| # | Failure | Detection | Signal | Mobile | Web | Route-to-fix | Rank |
|---|---|---|---|---|---|---|---|
| R1 | Runner not authed / OAuth expired | `inv` `CheckRunnerReady` `runner_auth.go:51` (credential-file probe). The **real** probe `POST /agent/runners/test` (`runner_test_http.go:104`) exists and the task path never calls it | `str` → 201/`failed` | ✅ **route** — pre-send `tasks.tsx:3157-3163` → `RunnerAuthModal`; banner "Sign in to {name}" `:5490-5552`; post-failure `ErrorMessage.tsx:69-76` | 🟡 CTA `VibeCodingView.tsx:2005-2020` gated to `claude/codex/kimi` — **opencode auth failure is text-only on web**; failed-task card `:2676-2685` is prose with no button | browser OAuth — **polled, not streamed** (`RunnerAuthModal.tsx:171`, 1.5 s) | **P1** |
| R2 | **Auth revoked mid-flight** — the agent computes *which* runner was rejected (`hitRunner`, `tasks.go:3194`) and **never puts it on the wire** | `op` ✅ `IsRunnerAuthFailureOutput` `runner_auth.go:244` | `done{failed}` + raw text | re-derives the same regex client-side `ErrorMessage.tsx:47-61` → button | `runnerFailure.ts:70-79` re-derives → **text card, no button** | agent knew, client re-guessed | **P1** |
| R3 | **Empty reply, exit 0** | `op` ✅ `isEmptyRunnerReply` `tasks_empty_reply.go:9` | `str` — canned `ResultText` **blames the model** ("switch zai glm-4.7 → glm-5.2") `tasks.go:3212-3215` | no matching rule → generic failed card | `runnerFailure.ts` has no rule → **returns null → no card at all** | none. The usual real cause is R4 | **P0** |
| R4 | **MCP tool flood** (1135 tools vs z.ai's 1000 cap; runner still exits 0) | **none at failure time** — only a preventive budget `mcp_core_profile.go:125` | trim notice goes to **stderr** `:143-145` | — | — | env var on the box only (`YAVER_MCP_MAX_TOOLS`) — **no endpoint, no UI** | **P0** |
| R5 | **Prompt typed into a tmux pane but never submitted** | **none — unverifiable by construction.** `sendTmuxLine` (`tmux.go:688-699`) sleeps 250 ms then sends Enter and returns nil if tmux exited 0. `runner_keeper.go:464-475` has its own copy **with no submit delay at all** | **200 OK `{ok:true, sent:"prompt", pane:"<tail>"}`** `runner_session_turn.go:255` — the `pane` tail would prove it never submitted; nothing compares it | spinner forever `vibe.tsx:186-188` | n/a | none | **P0** |
| R6 | **Pane is on a menu — the agent sends the exact options and the client drops them** | `op` ✅ `tmuxPaneAwaitingChoice` `tmux.go:718` | **409 `{awaitingChoice, options[], pane, error}`** `runner_session_turn.go:237-241` | `vibe.tsx:143` keeps `options` on the object and **renders only `error`** — the user sees "error" instead of the menu they must answer | not consumed | re-POST with `choice` — no UI on any surface | **P0** |
| R7 | Session's runner exited (pane is a bare shell) | `op` ✅ observes the pane process `runner_session_turn.go:116-124` | **409 `{session, runner, pane, error}`** `:205-212` | `text` turn, `pane` dropped | not consumed | prose names `yaver wrap <runner>` | **P1** |
| R8 | Runner crashed mid-task (auto-restart ×4) | `inv` heuristic — output length as proxy for "crashed vs answered" `tasks.go:3101` | `output` text `"⚠️ Agent process crashed — restarting (N/4)"` `:3117` | plain text. The **Restart** button (`tasks.tsx:4394`) is gated to states **not** in `{ok, loading, failed}` — i.e. **hidden exactly when it failed** | no card (`probe:"subprocess"` never set) | none | **P0** |
| R9 | **Default runner silently substituted** | `tasks.go:1674-1679` | **log line only** `:1676`. The response's `runnerId` carries the truth; no client diffs it against what it asked for | none | none | agent renders the wrong agent's name as if chosen | **P1** |
| R10 | **Model silently substituted** | `tasks.go:1712-1735` | **log line only** `:1739` | mobile has **no** `validateOpenCodeModel` equivalent — a bad model travels to the runner and dies as opaque output | pre-send veto `VibeCodingView.tsx:963-975` (text) | none | **P1** |
| R11 | codex workDir not writable | `op` ✅ real `os.CreateTemp` probe `runner_auth.go:85-127` | `str` embedding the literal `sudo chown -R …` | ✅ **route** — `ErrorMessage.tsx:98-106` → **Copy chown command** button. *Best-designed path in the codebase.* | **nothing** — `runnerFailure.ts` has no rule → `null` → **no card renders at all** | manual | **P1** |
| R12 | codex Linux sandbox prereqs missing | `op` ✅ kernel probe `runner_auth.go:956` | structured `SuggestedAction` + `ReasonRunnerCodexLinuxSandboxBlocked` **exists — on `/runner-auth/status` only** (`runner_auth_http.go:95-99`), never on the task payload | generic Alert | no card | none | **P1** |
| R13 | Task hangs with zero output | `op` ✅ 30 s warn / 4 min kill `tasks.go:3044-3080`. A runner that emits one banner byte then hangs forever is **never** caught | `output` text | spinner + one line | same | `stop`/`fork` exist (`httpserver.go:4977`, `:4820`) — **not offered from the watchdog message** | **P1** |
| R14 | tmux missing | `op` ✅ `tmuxAvailable` `tmux.go:125` | **silent on the spawn path** — `runner_pty.go:115` and `runner_tmux.go:79` just take the non-tmux branch | **silent**: an empty session list is indistinguishable from tmux-missing, so `tasks.tsx:4554` simply doesn't draw the banner | same silence | **auto-install exists** (`tmux.go:155-211`, 6 package managers) — **boot-time only, log-only, no endpoint, no client trigger** | **P0** |
| R15 | Runner PTY errors (binary missing, unsupported id, bad session name, session gone) | `inv`/`op` | bespoke **WS frame `{"type":"runner_pty_error","error":…}`** `runner_pty.go:579-585` — not an HTTP status, not SSE | grep: **zero clients map `runner_pty_error` to anything** | zero | prose names `runner_auth_setup` | **P1** |
| R16 | Stale login screen parked in a persistent tmux session | `op` ✅ four conjoined guards + pane read `runner_pty.go:252-283` | **none** — silently kills and recreates, log line only `:277` | — | — | self-healing and correct; zero telemetry | note |
| R17 | Co-vibe role denial | `vibe_sessions_http.go:202-219` | **403** with three distinguishable sentences `:213-217`, **no `role` field** | generic error text | `CoVibeCard.tsx` doesn't branch | `/vibe/role`, `/vibe/join` | **P2** |
| R18 | **`RunnerPreflightByID` — the payload every row above is missing — is dead** | `runner_preflight.go:35` returns `{fresh, needsReauth, reason, action, spoken}` | — | — | — | **called by `voice_dispatch.go:70` and nothing else.** Neither `POST /tasks` nor `POST /vibing/execute` calls it, though the file header describes the Tasks problem it was written for | **P0** |
| R19 | Cloud-workspace placement deferral | ✅ | **409 `{action:"cloud_workspace_required", pendingTaskId, placement, activation, reason}`** `httpserver.go:4716-4722` | pending card + Alert | `CloudWorkspaceRequiredError` `VibeCodingView.tsx:49` | **the best-typed failure on either surface** — the shape to copy | ✅ |
| R20 | Vibing eligibility | ✅ | **200 `{canVibe:false, reason, guidance, needsGitSetup}`** `vibing.go:1031-1053` | — | — | the only endpoint shipping a structured reason **and** remedy pair | ✅ |

### 6d. Preview / reload — additional route findings

| # | Failure | Signal | Route-to-fix | Rank |
|---|---|---|---|---|
| V1 | **`recoverKind` is emitted and consumed by nobody** — `devserver_http.go:3958` ships `recoverKind:"hermes-compat-blocked"` inside a rich 409 (`incompatibleNativeModules`, `nativeModuleVersionMismatches`, `hostSdkVersion`, `supportedRNRange`, …) | 409 `struct` — the richest refusal in the product | grep: **zero consumers in `mobile/` or `web/`**. The "try to fix" round-trip it documents was never wired | **P0** |
| V2 | **`capture_error` is emitted and consumed by nobody** — WebRTC capture failure sends `{"type":"capture_error","error":…}` on the events DataChannel (`remote_runtime_video_track.go:139-145`) with remedies that name real installs (`xcode-select --install` `:245`, `yaver install remote-runtime` `:265`) | events-DC `struct` | typed in `vibePreview.ts:68`; **`RemoteRuntimeViewer.tsx:317-341` handles `dims`/`rotation`/`ready`/`throttle` only.** The one WebRTC failure carrying an actionable remedy is dropped on the floor | **P0** |
| V3 | **`HermesValidation` returns `OK:true` on a bytecode-version mismatch** (`hermes_runtime.go:101-104`) with the mismatch only in `.Error` — a caller checking `.OK` proceeds | false green | — | **P0** |
| V4 | ICE failure | agent sets `Status:"failed"` (`remote_runtime_webrtc.go:366`) but the events DC is already dead, so **no message reaches the viewer** | `RemoteRuntimeViewer.tsx:303-305` renders centered text "Peer state: failed"; `iceState`/`dataState` are tracked, **no Retry button**. TURN is unwired (`:1005`) | **P1** |
| V5 | Offer stalls | `<-gather` at `remote_runtime_webrtc.go:459` is an **unbounded block on ICE gathering, no timeout** | reaper eventually closes it; the client sees a 404 | **P1** |
| V6 | SSE frames dropped to a slow subscriber | `devserver.go:1433-1439` `default:` drop — **no counter, no gap marker** | mitigated only by the 5 s `snapshot`; `RuntimeLabView.tsx:903` renders "dev events stream interrupted" as text with no reconnect UI | **P1** |
| V7 | `/dev/build-native` missing tools | **500 `{"error":"missing required tools…"}`** `devserver_http.go:3193` — **the 412's `installable`/`installEndpoint` shape is not reused here** | text only on both surfaces | **P1** |
| V8 | Node-only missing (the one lane that self-heals) | SSE `log` stream from `ensureNodeDepsStreamed` `devserver_install.go:105-140` | ✅ in-place, streamed, no user action needed — **the model for every other gap** | ✅ |

### 6e. Feedback SDK

Full detail in the sub-audit; the route-relevant rows:

| # | Failure | Detection | Signal | Mobile | Web | Route-to-fix | Rank |
|---|---|---|---|---|---|---|---|
| F1 | **`feedback_fix` with no task manager → HTTP 200 `{"ok":true,…}` with no `taskId`** | `feedback_http.go:334` `if s.taskMgr != nil` with **no else** | **false success** `:454-458` | — | — | none — indistinguishable from a real fix | **P0** |
| F2 | **`launch-feedback` with no DataChannel → 200 `{"ok":true,"status":"accepted"}`** | `remote_runtime.go:1724` `if live, ok := …` with **no else**; `remote_runtime_webrtc.go:526-528` returns silently | **false success** `remote_runtime.go:1738-1747` | success Alert on a no-op `remote-runtime.tsx:192` | same false positive `ProjectsView.tsx:425-433` | none | **P0** |
| F3 | **Web SDK upload failure is invisible** | `web/src/YaverFeedback.ts:397,406,439,469` — every path `return null` + `console.error` | — | n/a | **none** — `Last report:` only ever set on success (`:443`); failure leaves `''` (`:843`) | none | **P0** |
| F4 | MCP `feedback_list`/`feedback_fix` discard HTTP status | `httpserver.go:13869`, `:13907` (`body, _, _`) | **false success** — daemon down returns `""`/success | — | — | none | **P0** |
| F5 | Shake detector silently dead | `ShakeDetector.ts:108-111` `catch {}`; `ShakeDetector.kt:52-56`; `feedbackTrigger.ts:174-176` web no-op | **none, all platforms** | — | — | none | **P1** |
| F6 | Kotlin/Swift SDKs **exist** (`ab5d4ae65`) but the planner denies them | `workspace_preview_strategy.go:88-94, 244-246, 352` assert they don't | plan routes to viewer-triggered | — | — | **inventory drift**: a real capability withheld. `CLAUDE.md` repeats the stale claim | **P1** |
| F7 | SDK-not-installed detection is an inventory proxy | `stack_detect.go:708` names what *should* be there, never checks | — | — | — | fixer exists for web+expo only (`expo_cmd.go:147`, `init_project_feedback.go:41`) | **P1** |
| F8 | Web SDK ships CSS for a send button with no element (`.yvr-fb-action-send`, `:3310`); `stopAndSend()` (`:299`) never called from the overlay | — | — | n/a | dead route | **P1** |

### 6f. Connectivity / lifecycle

Rows R1–R20, T1–T10, L1–L4 are **not repeated here** — see the 2026-07 audit.
The route-architecture verdicts on top of it:

| # | Structural finding | Evidence | Rank |
|---|---|---|---|
| N1 | **Custodian + incidents reach web only** | `httpserver.go:488-491,972-975`; `PlaybookCatalog()` exists precisely to be rendered | **P0** — a phone-only user never sees what the box fixed or what needs a human (audit L4) |
| N2 | `RelaySessionExpiredAt` dead sentinel; `/settings/health` never existed | `config.go:56-62`, written `main.go:11454`, **zero readers**; comment `main.go:11443` | **P1** (audit R2) |
| N3 | Three drifting relay-auth matchers on mobile, none a superset | `quic.ts:7354` · `DeviceContext.tsx:672` · `:2646` | **P1** |
| N4 | Relay hint table duplicated and already drifted | `quic.ts:1260` vs `agent-client.ts:23` (web lost the 401 row) | **P2** |

### 6g. Cross-surface route parity — all seven surfaces

Surfaces confirmed to exist: tvOS (`tvos/YaverTV/`, 28 Swift files), watchOS
(`watch/YaverWatch/`, 21), Wear OS (`wear/app/src/main/kotlin/io/yaver/wear/`,
20), car (`mobile/app/car-voice-coding.tsx` — **RN only; no native CarPlay
scene exists anywhere in the repo**), glass (`mobile/app/glass-terminal.tsx`,
`glass-workspace.tsx`), desktop Electron (`desktop/app/src/`, 3 files), CLI.

**Route presence, per surface:**

| Route | tvOS | watchOS | Wear OS | car | glass | Electron | CLI |
|---|---|---|---|---|---|---|---|
| re-auth / sign in again | 🟡 silent `signOut()` `RuntimeDashboardView.swift:329-331` | ❌ string only `WatchStore.swift:322` | ❌ literal text "Sign in again." `AgentClient.kt:72` | ❌ | ❌ | 🟡 named, no button `index.html:883` | ✅ best-in-class `auth_fix_cmd.go:29` (HTTP→SSH→browser ladder) |
| relay repair | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ **fake** — `addRelay()` alerts success and persists nothing (`index.html:925`) | ❌ |
| install missing toolchain | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 unconditional Xcode/Android-Studio links `:895-896` | ✅ `main.go:7137,7177`, `doctor_build.go:470` |
| retry dev server / preview | ✅ `WebPreviewStreamView.swift:37,50` | ❌ | ❌ | ❌ | ✅ 3-rung fallback `glass-terminal.tsx:635-676` | 🟡 stop only `:1043` | ✅ |
| runner OAuth | ✅ **strongest native** — Claude/Codex/GitHub/GitLab + QR `RuntimeDashboardView.swift:150-217` | ❌ | ❌ | ❌ | ❌ | ❌ read-only `<select>`, "(not installed)" is a label `:706-709` | ✅ `runner_auth_cmd.go:33` |
| escalate to a coding agent | 🟡 | ❌ | ❌ | ❌ speaks *"I sent the details to your phone"* `car-voice-coding.tsx:1422` | ✅ `glass-workspace.tsx:551-566` autoFix | ✅ `:808` | ✅ |
| custodian / playbook findings | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

**Headline:** **custodian, playbook and incidents are invisible on all seven
surfaces** — `custodian.go`, `custodian_playbook.go`, `incidents.go`,
`incidents_http.go` have no consumer in tvOS, watchOS, Wear, car, glass,
Electron *or the CLI*. Web is the only place they render at all. **Relay repair
exists on exactly two surfaces** (mobile, web) plus `web-headless`; Electron
ships a fake success alert in its place. **Runner OAuth is tvOS-only** among
native surfaces.

**"Sign-in needed" is named on all three wearable/TV surfaces and actionable on
none** — tvOS `BoxLifecycle.swift:205`, watchOS `BoxLifecycle.swift:231`, Wear
`WakeProgress.kt:114` all say *"sign it in from your phone"* and offer only a
dismiss. Worse, dismissing returns the user to a normal UI with a live Speak
button on a box that provably cannot run a turn (`WakeProgress.kt:100-125`).

**False greens on these surfaces:**

| # | Surface | Where | The lie |
|---|---|---|---|
| S1 | Electron | `index.html:925`, `:926` | `alert('Relay added…')` and `alert('Cache cleared.')` — **success alerts for pure no-ops** |
| S2 | Electron | `:897` | "Web Preview … always available" with a **hardcoded green dot**, rendered even when `conn.connected === false` |
| S3 | Electron | `:883` | Agent ✓ green is pushed on any `getAgentInfo()` success; the `authExpired` ✗ red row is appended *after*, so Doctor shows both at once |
| S4 | tvOS | `RuntimeDashboardView.swift:346-348` | `(try? await …) ?? voice` — when the box dies the **last-known values stay on screen**, so `SurfaceStatusTile` keeps painting `ready` **green** for a machine that is gone |
| S5 | tvOS | `:40,:71` | a *failed* dev server and a *never-started* one both render "Waiting". **No failure state exists on this surface.** |
| S6 | Wear | `BoxLifecycle.kt:196-203` | phone-paired mode has no `boxBaseUrl`, so after 90 s it declares `READY` (100 %) **with zero confirmation**, then `MainActivity.kt:284` re-sends the pending turn into a box that may still be down |
| S7 | tvOS/watchOS | `BoxLifecycle.swift:78` / `:67` | needs-auth — a **blocked terminal state rendered as 80 % progress** |

**Duplicated classifiers that have already drifted** (native surfaces cannot
import `mobile/src/lib/*`, so every copy drifts by construction):

| # | Duplicate | Drift |
|---|---|---|
| D1 | `WatchStore.isUnreachable` `WatchStore.swift:246-262` | boolean, not a class; **missing mobile's `blocked` (ATS/cleartext −1022) case** → a permanently-impossible leg renders as "Box asleep. Tap Wake", and Wake can never fix it |
| D2 | Wear `SessionClient.kt:56-58` | `catch (e: Throwable) → boxUnreachable = true`. **Every** DNS/TLS/parse error becomes "box asleep". Zero classes |
| D3 | tvOS `SessionView.swift:387,427` | `error is URLError` — broadest of the three. Three surfaces, three incompatible rules for one question, all coarser than mobile's five-class `directProbeFailure.ts:32` |
| D4 | tvOS auth classifier `RuntimeDashboardView.swift:329-331` | string-matches `localizedDescription`; Wear uses the HTTP code, watchOS a third form. **A backend wording change silently disables tvOS re-auth** |
| D5 | Wake ladder ×3 (`tvos/BoxLifecycle.swift:30-80`, `watch/:28-70`, `wear/:50-58`) | **percentages drifted on 3 of 7 rungs** (mobile 40/65/86 vs native 52/80/94) — **and the doc comments claim they are identical** (`tvos:68`, `watch:40`) |
| D6 | Electron doctor `index.html:878-889` | fully independent check set; shares nothing with `main.go:6635 runDoctor()`, which has ~3× the checks and prints fix commands |

### 6h. The money table — the agent knows and the client drops it

Every row is a fact the Go agent computed correctly and then failed to route.
**This table is the deliverable's core evidence:** the problem is almost never
that Yaver does not know. It is that knowing stops at the process boundary.

| Fact the agent has | Where it dies |
|---|---|
| Which runner's auth was rejected (`hitRunner`) | `tasks.go:3194` — logged, never serialized |
| Default runner was silently swapped | `tasks.go:1676` — log only |
| Model was silently substituted | `tasks.go:1739` — log only |
| MCP tools were trimmed past the provider cap | `mcp_core_profile.go:143` — **stderr** |
| tmux missing on a spawn | `runner_pty.go:115`, `runner_tmux.go:79` — silent branch |
| Stale login pane killed and restarted | `runner_pty.go:277` — log only |
| The menu options the user must answer | sent at `runner_session_turn.go:239`; `vibe.tsx:143` keeps them and renders only `error` |
| The pane tail proving the prompt never submitted | sent at `runner_session_turn.go:259`; nothing compares it |
| `recoverKind` + the full native-module mismatch report | sent at `devserver_http.go:3958`; **zero consumers** |
| `capture_error` + `xcode-select --install` / `yaver install remote-runtime` | sent at `remote_runtime_video_track.go:139`; **zero consumers** |
| Per-runner incident `code` + `SuggestedAction` | `runner_auth_http.go:88-118` — on `/runner-auth/status` only, never on the task payload |
| `{needsReauth, reason, action, spoken}` | `runner_preflight.go:35` — **called by voice only** |
| The install command for each runner | `httpserver.go:5337`, `runner_auth.go:283-285` — no client renders it |
| 14 dotted reason codes | `reason_codes.go:3-18` — **zero client readers** |
| 35 playbook remedies with machine-invocable `Verb`+`Args` | `custodian_playbook.go` — **web only** |

---

## 7. THE CONTRACT

> **Detect by attempting → name with a code → signal it structurally on every
> carrier → render a route the user can see → stream the fix → return them to
> what they were doing. Or name the constraint, specifically, when no fix
> exists.**

1. **Detect by attempting the operation.** `commandExists` is an inventory
   proxy; a tool on PATH can be a stub, a cert can be present and unable to
   sign, a device can be `online` and unreachable.
2. **Name it with a stable code**, not a sentence. The sentence is for humans
   and gets rewritten; the code is the wire contract and does not.
   `reason_codes.go` already exists — **use it, and let clients read it.**
3. **Signal structurally on every carrier the failure can take** — the HTTP
   response, the SSE stream, the task event, the incident feed, the heartbeat.
   One producer, one type, one set of field names.
4. **A remedy is a route, not a sentence.** Every remedy must carry
   `method + path + stream` so a UI can render a button without knowing what
   the failure is. A `SuggestedAction` string is layer C, never layer D.
5. **Resolve the fix per os/arch before claiming anything.** Offering an
   install that 404s teaches the user Yaver lies; declaring impossible what
   `flutter_install.go` has always supported withholds a working capability.
   **Wrong in either direction is a defect.**
6. **Render the route on every surface, from one shared renderer with a parity
   test** — and make sure it can be *seen*: advisory text may never squeeze the
   route out (§2c), and advisory work may never block it (§2b).
7. **Streaming the fix is part of the fix** — bytes, elapsed, last-output age,
   on the surface the user is looking at.
8. **Never advertise a remedy the product cannot perform.** Validate against
   the real table, in the same order the real command consults it.
   `missingToolchainRemedy` (`devserver_start_remedy.go:207-233`) is the model.
9. **Never report success for an operation that did not happen.** `if x != nil`
   with no `else` returning `{"ok":true}` is the same lie as a false green
   (F1, F2, F4).
10. **Escalate to a runner only when there is no deterministic fixer.** "Fix in
    Yaver" is the fallback, never the first answer to a known gap.
11. **A signal with no consumer is not shipped.** `recoverKind` (V1),
    `capture_error` (V2), `reason_codes.go`, `RelaySessionExpiredAt` and
    `RunnerPreflightByID` (R18) are all correct, well-designed producers that
    nothing reads. Emitting a field is not delivering a diagnosis. **Every new
    signal needs a consumer landed in the same change, and a test that fails
    when the consumer is removed.**
12. **Advisory content may never win over the route** — not in time (a blocking
    preflight, §2b) and not in pixels (an unbounded diagnostics wall, §2c).
    Cap it, bound it, and give the route a floor.

### Seams that already implement it well

- **`missingToolchainRemedy`** (`devserver_start_remedy.go:195-233`) — validates
  its own advice against `metaInstallPlan` + `lookupIntegration` in the same
  order `yaver install` does. Rule 8, done right. Its only sin is returning a
  `string` instead of a route.
- **The 412 structured refusal** (`devserver_http.go:1815-1828`) — the *shape*
  is exactly right: status code + `missingTools` + `installEndpoint` +
  `installable` + `helpHint`. Its sin is a Node-only, `package.json`-gated
  producer and an untyped inline map.
- **`flutter_install.go` + `install_http.go:89-119`** — per-arch resolution with
  a git-clone fallback for `linux/arm64`, a 60-minute budget because an SDK does
  not fit the registry path's 30, streamed throughout. Rules 5 and 7.
- **`LogStream` + `/streams/<name>`** (`logstream.go`) — generic, non-blocking,
  history-buffered, terminal `result` event. **The layer-D transport is solved.**
- **`relayDeny.ts` twins + relay reason codes** (`relay/server.go:1073-1096`) —
  a real wire contract, code-lookup on both clients, parity-tested. Rules 2, 3, 6.
- **`custodian_playbook.go`** — `Verb` + `Args` is a genuine machine-invocable
  route, 21 of 35 rows auto-applying. Its gap is surface reach, not shape.
- **`POST /agent/runners/test`** — a real subprocess probe rather than the
  signed-in badge. Rule 1, done right; §2b is about *where it sits*, not what
  it does.

### The generalized seam: `CapabilityGap` + `GapFix`

One type, one producer, one wire field, one renderer per surface. It is
deliberately `CapabilityTargetReadiness` (`capabilities_snapshot.go:12`) — the
existing type with the right idea — **plus the missing route**.

```go
// desktop/agent/capability_gap.go (new)
//
// A capability the operation needs and this machine does not have.
// Produced by ONE function so a new gap gets all four layers for free.
type CapabilityGap struct {
    Code       string  `json:"code"`                 // reason_codes.go value — the wire contract
    Capability string  `json:"capability"`           // "flutter", "claude", "xcode-simulator"
    Summary    string  `json:"summary"`              // one sentence, user-facing (layer C)
    Detail     string  `json:"detail,omitempty"`
    Fix        *GapFix `json:"fix,omitempty"`        // nil ⇒ no fixer; Constraint MUST be set
    Constraint string  `json:"constraint,omitempty"` // why no fix exists on THIS os/arch
}

// GapFix is the ROUTE — the thing seven existing remedy fields all lack.
type GapFix struct {
    Label  string `json:"label"`         // "Install Flutter"
    Method string `json:"method"`        // "POST"
    Path   string `json:"path"`          // "/install/flutter"
    Stream string `json:"stream"`        // "install:flutter" → GET /streams/<stream>
    Est    string `json:"est,omitempty"` // "~1.2 GB, 3-8 min"
    Retry  bool   `json:"retry"`         // re-issue the original request on success
}
```

**One producer.** `DetectCapabilityGap(op OperationContext, err error)` owns:
the missing-tool vocabulary (widened past Node by detecting the *project kind*,
not by requiring `package.json`), per-os/arch resolution against
`metaInstallPlan`/`lookupIntegration`/`PackageRegistry`, and the `Constraint`
sentence when nothing resolves. Existing helpers become its internals:
`installableViaAgent`, `installEndpointForTool`, `frameworkInstallTarget`,
`missingToolchainRemedy` (whose prose becomes `Summary`).

**Carried on every channel, additively** — nothing existing changes shape:

- HTTP: `jsonError` gains an optional `capabilityGap`; the 412 emits the struct
  instead of a hand-typed map.
- **SSE: `DevServerEvent` gains `Gap *CapabilityGap`.** This single field closes
  the Flutter case — the *asynchronous* start failure the 412 can never catch
  arrives typed on the channel the preview is already subscribed to (§2a step 2).
- Incidents: `IncidentEvent.Metadata["capabilityGap"]`, so custodian and every
  incident surface see the same object; `PlaybookEntry.Verb/Args` becomes a
  `GapFix` for free.
- Task events: the same field, so a Tasks-surface runner gap is the same object
  as a preview toolchain gap.

**One renderer per surface, parity-tested.** `mobile/src/lib/capabilityGap.ts`
and `web/lib/capabilityGap.ts`: take the typed object → render *name → Fix
button → subscribe `/streams/<stream>` with bytes + elapsed → auto-retry the
original operation on `result:ok`*, or *name + Constraint* when `Fix == nil`.
`capabilityGapParity.test.ts` pins that both surfaces cover the same codes, in
the style of `beaconParity.test.ts` — **and it must be proven by breaking it.**
Native surfaces (tvOS/watchOS/Wear) get the same object over the same JSON and a
small per-platform renderer; because they key off `Code`, they cannot drift the
way a copied regex does.

**Consequence.** A new capability gap — an SDK, a simulator runtime, `adb`, a
keychain, a runner login — is added by teaching **one** detector and **one**
install table. Layers B, C and D come for free, on every surface. Today each one
is a fresh per-call-site special case, which is exactly why the audit's D1a, D2
and D7 are three names for the same hole.

---

## 8. Ranked gaps for the follow-up pass

**P0 — the fix exists and the user cannot reach it, or a lie is reported.**

*Class 1 — a structured signal cannot be raised at all:*
1. **C1 / C2 / G3** — non-Node toolchain gaps produce no structured signal
   (`package.json` gate at `devserver_http.go:1807`, plus 200-OK-then-async-fail
   at `devserver.go:723`), so the Flutter case has no route on any surface while
   `POST /install/flutter` works. *Minimum fix:* `Gap *CapabilityGap` on
   `DevServerEvent`.
2. **R18** — `RunnerPreflightByID` (`runner_preflight.go:35`) already returns
   `{needsReauth, reason, action, spoken}` — the exact payload every runner row
   is missing — and is called by **voice only**. Neither `POST /tasks` nor
   `POST /vibing/execute` calls it.

*Class 2 — the signal is raised and dropped on the floor:*
3. **V1** — `recoverKind` + the full native-module mismatch report
   (`devserver_http.go:3958`): **zero consumers**.
4. **V2** — `capture_error` with real install remedies
   (`remote_runtime_video_track.go:139`): **zero consumers**; the only WebRTC
   failure carrying an actionable remedy.
5. **R6** — the agent sends the exact menu `options[]` the user must answer
   (`runner_session_turn.go:239`); `vibe.tsx:143` renders only `error`.

*Class 3 — false success / false green:*
6. **F1 / F2 / F4** — `feedback_fix` with no task manager returns
   `{"ok":true}` with no `taskId`; `launch-feedback` with no DataChannel returns
   `{"ok":true,"status":"accepted"}` and **both surfaces show a success alert on
   a no-op**; two MCP verbs discard HTTP status entirely.
7. **C7 / C8** — `installNodeBackedCLI` reports success having installed
   nothing (`install_cmd.go:1594`), risking a 412→install→412 loop; a *successful*
   Flutter install still fails detection because the agent never re-reads PATH
   (`flutter_install.go:192,222`).
8. **R5** — a prompt typed into a pane and never submitted returns **200
   `{ok:true}`** while the agent is holding the pane tail that disproves it.
9. **V3** — `HermesValidation` returns `OK:true` on a bytecode mismatch
   (`hermes_runtime.go:101-104`).
10. **S1–S7** — seven false greens across Electron, tvOS and Wear, including two
    success alerts for pure no-ops and a tvOS dashboard that keeps painting
    green for a box that is gone.

*Class 4 — the route is blocked, crowded out, or advertised and absent:*
11. **G1** — the PTY launch gate puts a ≤25 s advisory probe in the critical
    path of an operation that is usually already possible, violating the repo's
    own critical-path rule. *(In flight in another thread.)*
12. **C9** — `yaver install wda` is advertised at `remote_runtime_target.go:193,
    199,211` and resolves in neither install table → `POST /install/wda` 404s.
    The 2026-07-26 "the product refuses its own remedy" defect, still live.
13. **R14** — tmux auto-install exists for six package managers
    (`tmux.go:155-211`) as **boot-time, log-only code with no endpoint and no
    client trigger**, while a missing tmux degrades silently on the spawn path.
14. **R8** — the mobile **Restart** button is gated to states *not* in
    `{ok, loading, failed}` — hidden exactly when the runner failed.
15. **R3 / R4** — the empty-reply remedy blames the model when the usual cause is
    the MCP tool cap, which has no detection, no signal and no endpoint.
16. **N1** — custodian findings, playbook remedies and incidents are **web-only**
    — invisible on mobile, tvOS, watchOS, Wear, car, glass, Electron *and the
    CLI*, despite `PlaybookCatalog()` existing precisely to be rendered.
17. **F3** — the web feedback SDK swallows every upload failure to `console`.

**P1 — route exists on one surface only, or the remedy is prose:**
C3 (web has no install affordance at all), C4, C5, C6, C7a, C10, R1 (opencode
web CTA missing), R2, R7, R9–R13 (R11: the chown route exists on mobile and
renders *no card at all* on web), R15, V4–V7, F5–F8 (incl. the Kotlin/Swift SDK
inventory drift that `CLAUDE.md` still repeats), N2, N3, D1–D6 (drifted native
classifiers; the wake ladder's percentages disagree while its comments claim
they match).

**P2:** relay hint tables duplicated and drifted (N4); R17; seven remedy key
names for one concept; `reason_codes.go` unread by any client.

**🔧 Fixed in this pass:** C3b — `devInstallHelpHint` named `/streams/install`,
a path no install ever opens. Now derives the real path from the endpoint
(`installStreamPathForEndpoint`, `devserver_http.go:1011-1022`), pinned by
`TestDevInstallHelpHintNamesTheRealStreamPath` +
`TestInstallStreamPathMatchesHandleInstall`, **guard proven by breaking it.**

---

## 9. Cross-references

- `docs/audits/failure-recovery-audit-2026-07.md` — the failure *inventory*
  (R/T/D/L rows) and the 2026-07-27 fix pass. This document does not repeat it.
- `CLAUDE.md` → "A MISSING TOOLCHAIN IS A PRODUCT REQUIREMENT" and
  "Every incident must leave the product harder than it found it" — the rules
  this architecture serves.
- `AGENTS.md` → the same rules, condensed for non-Claude agents.
