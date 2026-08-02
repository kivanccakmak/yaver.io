# Vibing false-green cascade — deep audit, 2026-08-02

One click on **Fast Reload** in Vibing produced seven independent defects in a
single chain. Every one of them was knowable for **zero tokens and zero
seconds** before the click. The chain ended by spending an LLM run on the
cheapest possible question, and that LLM run was itself broken in two ways the
product already knows how to detect.

Machines are referred to by role (`ai-box`, `render-box`) per the public-docs
alias rule. No credential, address, or account identifier appears in this file.

---

## 0. The chain, in order

| # | Defect | Layer | Cost to detect |
|---|---|---|---|
| 1 | Picker offers a project that is not on the render machine | web | free (data already held) |
| 2 | "Probe" is a name lookup that returns in 0s and calls itself a probe | agent | free |
| 3 | Remedy names a CLI command, on a web surface, for a box the user has no shell on | agent | free |
| 4 | Panel headline and panel CTA describe **different faults** | web | free |
| 5 | A deterministic fault escalates to a paid LLM run | web | free |
| 6 | Runner shows `✓ SIGNED IN` while its token is expired | agent → web | free (`RunnerPreflightByID` exists) |
| 7 | Model `gpt-5.4` can never work on this account type; picker still offers it | web | free (already in 3 comments) |

Bonus, visible in the failed run's own output: the render box's git remote is
still the pre-migration URL, so `pre-task git pull` exits 128 and is **silently
skipped** — the runner then edits a stale tree and says nothing.

---

## 1. Project identity is a NAME, so it cannot be machine-scoped

`RuntimeLabView.tsx:1357` logs `projects loaded: 36` — the union of every
machine's projects. Identity is the display name (`yaver / mobile`), so the
picker cannot express "this project exists on `ai-box` but not `render-box`".

The user's split is `AI: ai-box · Render: render-box`. `yaver / mobile` lives on
`ai-box`. The picker offered it anyway; the render probe went to `render-box`
and correctly found nothing:

```
desktop/agent/devserver_http.go:3201
  "no mobile project named %q on this machine — check `yaver projects mobile`"
```

The agent's sentence is **true**. The client turned a truth into a dead end.

This is the same root cause recorded on 2026-07-28 (`webui-session-cascade`
memory): *"project picker merges ALL machines' projects with NAME-based
identity … probe failed by name on render machine while the fix task got the
other machine's absolute path shipped to the Linux box."* It was diagnosed five
days ago and the identity model was never changed.

**Fix:** project identity is `(deviceId, path)`, never the name. Where a chosen
project is absent on the render machine but present on another, that is not an
error — it is a **routing question with a deterministic answer**: *"`yaver /
mobile` is on `ai-box`, not `render-box`. Render it there, or pick a project
that exists here."* Two buttons, no LLM.

## 2. A 0-second "probe" is not a probe

The console reads `probed in 0s` and `targets: 0 primary, 6
advanced/unavailable`. A name lookup against a cached project list is an
**inventory** check wearing the word "probe" — the exact inversion CLAUDE.md
forbids ("probe the operation, never the inventory"). It cannot distinguish
"the project is not here" from "the project is here but the dev server cannot
start", and it reports both as one string.

## 3. The remedy is a CLI command on a surface that has no CLI

`check \`yaver projects mobile\`` is correct advice for someone with a shell on
`render-box`. On the web dashboard it is unreachable — the user is three
transport hops away. This is the documented Flutter-install defect verbatim
(CLAUDE.md worked example): the remedy string names a fix that no surface
exposes as an action.

**Fix:** the agent already knows the project list for that machine. Return it as
**structured data** (`availableProjects: [{deviceId, name, path}]`) alongside a
stable reason code, and let each surface render a picker. A remedy that cannot
be tapped is prose.

## 4. Headline and CTA describe different faults

The panel reads:

```
Runtime target probe failed
no mobile project named "yaver / mobile" on this machine
✓ Connection to render-box: OK via relay (449ms) — the box is up;
  the failure is in the operation, not the connection.
[ Sign in OpenAI Codex to fix ]
```

The connection line is **excellent** — it is the honesty work from
`connectivity-truth-loop` doing exactly its job, and it correctly separates
transport from operation. But the CTA is bound to the *runner auth* fault while
the headline is the *project routing* fault. Signing into Codex will not create
a project on `render-box`. A user who follows the button re-authenticates, taps
again, and lands on the identical error.

**Fix:** one panel, one fault. If two faults are live, show two rows, each with
its own route. The CTA must be derived from the same reason code as the
headline, not from the highest-priority unrelated incident.

## 5. A deterministic fault bought an LLM run

`fix task 4ba2546a started with codex`. CLAUDE.md is explicit:

> Escalate to a coding agent only when there is no deterministic fixer.
> "Fix in Yaver" costs an LLM run; `POST /install/flutter` costs one command.
> Spending the former on a class that has the latter is the most expensive
> possible answer to the cheapest possible question.

"Project not on this machine" has a deterministic fixer (§1). It should never
reach a runner.

**Fix:** a reason-code → fixer table, consulted before any escalation is
offered. Only codes with no deterministic entry may render "Fix with …".

## 6. `✓ SIGNED IN` over an expired token — the false green

The sidebar renders `runner: Codex ✓ SIGNED IN` (green). The task then died on:

```
HTTP 401 … "code": "token_expired"
failed to connect to websocket: HTTP 401 Unauthorized
```

The detection already exists and is correct:

- `runner_preflight.go:35` `RunnerPreflightByID` returns `NeedsReauth`, a
  `Reason`, an `Action` (the exact re-auth command) and a TTS `Spoken` line.
- `runner_auth.go:1154` asks `codex login status`, which reads the credential
  file and **checks expiry**.

It has exactly **one** caller:

```
desktop/agent/voice_dispatch.go:70
```

So the car can be told its Codex login expired, and the Vibing dispatch path
cannot. This is the "signal with no consumer" defect CLAUDE.md names, and
`RunnerPreflightByID` is listed there by name — it was known and left unwired.

Compounding it: `runner_auth.go:196` gates on `runnerAuthProofRecent(id)`, so a
stale positive proof keeps `AuthConfigured` true after the token has actually
expired. The green is not merely unverified; it is **cached**.

**Fix:** call `RunnerPreflightByID` on the task-dispatch path (not only voice),
and let its verdict own the `SIGNED IN` chip. When proof is stale, the chip says
"unverified", never "signed in".

## 7. The model was guaranteed to fail, and the repo already knew

```
"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."
```

The repo states this in three places and encodes the correct default:

- `web/components/dashboard/DevicesView.tsx:2556-2560` — *"general gpt-5.x
  require API billing and error on a ChatGPT-account Codex login"*;
  `DEFAULT_MODEL_BY_RUNNER.codex = "gpt-5.3-codex"`.
- `desktop/agent/httpserver.go:3901-3907` — same comment,
  `gpt-5.3-codex` is `IsDefault: true`.
- Classifiers for the exact 400 string already exist and are tested:
  `runner_auth_invalid_test.go:29`, `runner_failure_classification_test.go:11`,
  `web/lib/runnerFailure.test.ts:25`, plus mobile
  (`DeviceContext.tsx:238`, `TaskTargetWizard.tsx:109`).

And yet the **pickers still offer it**:

- `DevicesView.tsx:2684` — `gpt-5.4`, hint **"current default"**
- `DevicesView.tsx:2808` — `gpt-5.4`, hint **"stable default fallback"**
- `RuntimeLabView.tsx:510` — `gpt-5.4`, **`isDefault: true`**

The knowledge landed in the classifier and the constant; it never reached the
list the user actually picks from. The session shows `MODEL / gpt-5.4` — the
picker's default, not the agent's.

**This is not a billing problem.** See §9.

**Fix:** one exported compatibility predicate
(`modelRequiresApiBilling(runner, model)`), consumed by every picker. Models
that cannot work on a subscription login are either hidden or shown disabled
with the reason. The three lists stop being hand-maintained twins.

## 8. Bonus: the silent stale-tree pull

```
[yaver] pre-task git pull skipped: exit status 128 — From <old-org URL>
(continuing on the local tree)
```

The render box's remote is the **pre-migration** URL. CLAUDE.md warns exactly
this: *"GitHub still redirects the old URL, so a stale remote keeps working and
will quietly hide its own staleness."* Here it does not even redirect — it exits
128, and the runner proceeds on a stale tree having *reported the skip as an
aside*. Any edit it makes is against unknown-age code.

**Fix:** a failed pre-task pull is a **named, blocking** condition with a route
(`git remote set-url`), not a log line the run continues past.

---

## 9. "Is it money?" — no, and the distinction matters

Two failures in that run, neither solved by paying:

**a) `token_expired`** — the Codex OAuth session on `render-box` lapsed.
Re-auth on the box. Free. Detectable pre-dispatch (§6).

**b) `gpt-5.4 not supported … with a ChatGPT account`** — an *account-type ×
model* constraint, not a quota. A ChatGPT-subscription Codex login exposes the
Codex-native models (`gpt-5.3-codex`, `gpt-5-codex`); the general `gpt-5.x`
line is reachable only through **API billing**, which the house rule
(`feedback_no_api_keys_subscription_only`) forbids Yaver from using.

So the resolution is not "buy API access" — it is **select the model the
existing subscription already covers**. The subscription is not short of money;
the picker is short of a compatibility check. Paying would *also* work and would
be strictly wrong for Yaver.

**Can we learn it?** It is already learned six times over (§7). The gap is
distribution, not knowledge — the classifier learned it, the picker did not.
That is the cross-surface parity law failing inside a single surface.

---

## 10. On "send hello first to avoid the false green"

The instinct is right; the placement decides whether it is a fix or a
regression. There is a live precedent both ways.

`web/lib/runnerLaunchGate.ts` documents what happens when a hello sits on the
**click** path: `POST /agent/runners/test` ran a real inference round trip —
**5.3 s and 6,212 tokens of the user's quota, per click** — to rediscover
something `/runner-auth/status` answered in 0.20 s for free. That was removed on
purpose, and CLAUDE.md now forbids "a blocking preflight in front of a
capability that already works".

So the rule is a ladder, cheapest first, and the hello is the **last** rung:

1. **Free, cached:** `codex login status` (already reads expiry) and
   `modelRequiresApiBilling()` (§7). **Both of today's failures die here.** No
   token round trip needed at all.
2. **Free, structural:** does the project exist on the render machine (§1);
   does the pre-task pull succeed (§8).
3. **Cheap hello — dispatch only, never click.** A one-token round trip before a
   task that will cost minutes is ~0.1 % overhead and converts a mid-task crash
   into an up-front CTA. It must **never** gate opening a terminal, and it must
   fail *open* with a named banner, exactly as the launch gate does.

Concretely: wire `RunnerPreflightByID` into the dispatch path (§6), add the
model predicate (§7), and only then consider the hello — because with 1 and 2 in
place, the hello would have had nothing left to catch today.

---

## 11. What this says about one-to-many

The 2026-08-01 audit named the blocker: `AgentClientPool` exists, but the
dashboard is still wired to the legacy singleton `agentClient`, and
`connectToDevice()` disconnects it on switch. Today's session adds the sharper
point — the pool's own contract is:

```
web/lib/agent-client.ts:9187-9190
  Auth is per-user, not per-device — every client in the pool uses the same
  Convex Bearer token, and the relay password is shared too.
```

So a single missing account-level relay password fails **every** client in the
pool identically — which is exactly why the Devices list showed three separate
machines with one identical sentence. One-to-many inherits a single point of
failure by construction, and the UI renders that as three independent problems.

Related, and still unfixed on the read path:

```
web/app/dashboard/page.tsx:1276
  const pw = sd.settings?.relayPassword || sd.relayPassword;
  if (pw) { relays = relays.map(...) }        // ← no else
```

A `401/403` from `/settings` is handled (a `SessionDeathError` banner, added
after the 2026-07-28 incident). **A `200 OK` carrying no relay password is
not.** That path yields the same fleet-wide "relay password missing or stale"
with no banner and no route — a false green in the shape CLAUDE.md names
directly (`if x != nil` with no `else`).

---

## 12. Verified-good (do not "fix" these)

Measured this session, so the audit is not read as a general indictment:

- `e2e/connectivity-truth-loop.mjs` — **6/6 PASS** against production.
- Public relay — 200, healthy; anonymous probes return **stable deny codes**
  (`relay_password_missing`), not bare 401s.
- `desktop/agent` Go tests (`Relay|Rescue|SelfHeal|DeviceIdentity|Transport`) —
  all pass.
- Mesh-audit faults 1, 2, 4, 5 (2026-07-19) — all fixed at the named seams.
- The "Connection to `render-box`: OK via relay (449ms) — the failure is in the
  operation, not the connection" line is the single best piece of diagnostics on
  the screen. It is what let this audit start at the right layer.

## 13. Credential-handling review (requested)

- `.env.test` — gitignored via `.env.*`, never tracked, **never committed** in
  any branch's history. Verified.
- All 63 deterministic client tests are pure: no `process.env` credential reads,
  no network. Safe to run in CI without secrets.
- **`?__rp=<relay password>` in URLs** (~20 call sites, `agent-client.ts`,
  `pair/page.tsx`, `quic.ts`) is a *known, mitigated, documented* residual, not
  an oversight: the relay strips `__rp` before forwarding
  (`relay/server.go:1987`), sets `Referrer-Policy: no-referrer`
  (`server.go:2810`), and does not log request URLs. Residual exposure is
  browser history and any future intermediary. The code names the real fix
  itself — asymmetric per-device tokens — and the 2026-08-01 relay audit sets
  the same target. **Recommend: keep, do not widen; no new `__rp` call sites.**
- Query-string credentials exist only because browsers cannot set headers on
  iframe/WebSocket loads. Every non-browser path uses `X-Relay-Password` or a
  bearer header.

---

## 14. Priority

| P | Item | § | Effort |
|---|---|---|---|
| **P0** | Wire `RunnerPreflightByID` into dispatch; chip stops lying | 6 | small |
| **P0** | `modelRequiresApiBilling()` + filter all three pickers | 7 | small |
| **P0** | Reason-code → deterministic-fixer table; gate "Fix with …" | 5 | medium |
| **P1** | Project identity `(deviceId, path)`; cross-machine routing CTA | 1 | medium |
| **P1** | `if (pw)` else-branch names the missing account relay password | 11 | small |
| **P1** | Failed pre-task pull blocks + routes instead of logging | 8 | small |
| **P2** | Structured `availableProjects` instead of a CLI string | 3 | medium |
| **P2** | One panel, one fault — CTA derived from the headline's code | 4 | medium |
| **P3** | Pool becomes the source of truth (true one-to-many) | 11 | large |

Everything P0 is deterministic, free at runtime, and would have prevented
today's cascade outright.
