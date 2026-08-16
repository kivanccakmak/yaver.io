# Closed-loop surface coverage — progress, 2026-08-05

Running record of which surfaces have been proven end-to-end, what is blocked,
and on what. Machine-verified verdicts live in `e2e/test-results/loop-ledger.json`
(written by `e2e/_loopLedger.mjs`); this file is the narrative the ledger cannot
carry.

## How the suite runs now

Three rules, all enforced in `e2e/all-surfaces-sfmg-loop.mjs`:

1. **Sequential.** One surface at a time, never a fan-out. Two simulators at
   once on a shared laptop measure contention, not the product.
2. **Local-first.** `TARGET` is derived from the box host, not declared. An arc
   reaches the 4 GB Hetzner box only after passing against a local agent **on
   the same code**. The box has 4 GB, a recorded OOM death-spiral past ~2.4 GB,
   and other people's work on it; a run that dies for lack of RAM teaches
   nothing and costs someone else their run. Override with `LOOP_FORCE=1`.
3. **Load-aware.** `e2e/_loadGuard.mjs` measures load-per-core and reclaimable
   RAM before each arc, waits up to 5 minutes for capacity, and then reports a
   **NAMED skip carrying the numbers** rather than starting. Heavy arcs
   (simulators, emulators, bundlers) get a stricter budget than light ones
   (dispatch and API probes).

Progress is **resumable**: a pass is honoured only for the current git HEAD plus
the tracked-file dirty fingerprint, and only within `LOOP_MAX_AGE_HOURS`
(default 12). Edit any tracked file and every entry stops counting — the ledger
can therefore skip work but can never hide a regression. Pinned by
`e2e/_loopLedger.test.mjs` (13 assertions, all refusals).

## Verified this session

| Surface | Verdict | Notes |
|---|---|---|
| visionOS (simulator, real app, real box) | **PIXELS** | peak red 4.9% (needs 3%); 5 screenshots + manifest |
| car (CarPlay) | **DISPATCHED** | drives the shipped `dispatchAndSummarize`; spoke "It needs your review." |
| watch (watchOS) | **DISPATCH LANE OK** | `desktop_voice` accepted and routed |
| web lane (sfmg colour loop) | **PIXELS** | earlier this session: `#0a1f14` → red → black |
| mobile RN-web browser lane | **PIXELS** | earlier this session, 2.9m, sfmg left at its 17-file baseline |
| Yaver-in-Yaver Hermes refusal (local agent) | **PASS** | 409 `YAVER_SELF_DEVELOPMENT_RECURSION`, `remedy=stream-over-webrtc`, `strategy=chrome-webrtc` |
| Yaver-in-Yaver capabilities (local + box) | **PASS** | `selfDevelopment=true`, Hermes omitted, `dev-server` primary, `remote-runtime` offered |

Car and watch **do not assert pixels, by construction** — CarPlay's voice
template forbids a preview while driving and watchOS has no frame path at all.
The arc says so on every run rather than inventing a colour verdict.

## Blocked, with the specific reason

* **tvOS / iOS / Android simulator arcs, and the local Yaver-in-Yaver render.**
  This MacBook measured a 1-minute load average of **224** (later 121) against
  10 cores. Cause is not this suite: a wedged VPN network extension at 99% CPU,
  `nesessionmanager` at 121%, an Android emulator, and several concurrent npm
  installs. Starting Metro or a simulator into that produces a timeout that
  reads as a product failure. The load guard now refuses this automatically and
  names the numbers.
* **The 4 GB box is not idle either** — two `whisper-cli` processes at 265% and
  153% CPU, a `git` at 130%, and 91% disk. Left alone deliberately.

## Yaver-in-Yaver: what is actually true per surface (corrected)

A first pass here recorded a "parity gap" — only mobile consumes
`YAVER_SELF_DEVELOPMENT_RECURSION` / `selfDevelopment` / `stream-over-webrtc`,
with web, tvOS, watchOS, Wear OS and visionOS all at zero. That grep was
accurate and the conclusion drawn from it was wrong, so it is corrected here
rather than quietly dropped.

**Measured:** the refusal fires only for `buildTarget == "mobile-hermes"`
(`devserver_http.go:3245`). Which clients ever ask for that target?

| Surface | Calls `/dev/build-native` | Requests `mobile-hermes` | Can reach the refusal |
|---|---|---|---|
| mobile | yes | yes | **yes** — and handles it: codes-first classification, "Preview Yaver a Different Way", remedy lane as a button |
| web | yes (`buildWebJSBundle`) | **no** — sends `web-js-bundle` | no |
| tvOS | **no** | no | no |
| visionOS | **no** | no | no |
| watchOS | **no** | no | no |
| Wear OS | **no** | no | no |

Web's only `mobile-hermes` references are in `capabilityReadiness.ts`, matching
a readiness code — never a build target.

So the refusal has exactly one surface that can reach it, and that surface
handles it correctly. **This is not a parity gap**; the other surfaces are
correct by construction, because Hermes is the one lane they never request.
Adding a recursion handler to tvOS or the watch would be dead code guarding an
impossible call.

**The real open question** — and the one the user's request is actually about —
is not the refusal but the permitted lanes: can each surface *render* the Yaver
project through `dev-server` (RN web in a WebView/iframe) or `remote-runtime`
(WebRTC), and vibe it? The agent already answers `selfDevelopment=true` with
`dev-server` primary and `remote-runtime` offered, verified on both the local
agent and the box. What is unproven is the pixels, per surface. That is arc
work, not classifier work, and it is blocked on machine load rather than on any
missing signal.

Lesson worth keeping: a grep for "who mentions this constant" answers a
different question from "who can encounter this condition", and only the second
one tells you whether coverage is missing.

## Landed this session (product, not harness)

* **`/ops` names the keys it ignored.** `encoding/json` silently drops unknown
  top-level keys, so arguments sent under `args` instead of `payload` produced
  "`transcript` is required" — true of the decoded payload and false of the
  request. `opsRejectMisnamedPayload` (`desktop/agent/ops_http.go`) now refuses
  with the ignored key names and a machine-readable `ignoredKeys`, on both
  `/ops` and `/ops/plan`. Guarded by `ops_misnamed_payload_test.go`, **proved by
  breaking it**: with the call unwired the test fails with "the handler did not
  name the ignored key".

## Harness defects fixed (all were false reds)

`e2e/render-incapable-vibe-loop.mjs` reported two surfaces broken three times
running while the box was doing the work correctly:

* read `body.id`; the agent replies `taskId`
* read `status` off the `/tasks/<id>` envelope instead of `body.task`
* sent `args`; the watch client sends `payload`
  (`watch/YaverWatch/DesktopVoiceClient.swift:69`)

Common cause: the arc re-implements shapes the shipped clients already know.
Where a client is importable it drives it and was right first time. Each copied
shape now carries a `file:line` citation to its source, and the arc **cleans up
its own edit** — two earlier runs left a marker line in `sfmg`, which corrupted
the next run's dirty-file baseline.

## Next, in order

1. Local Yaver-in-Yaver **render** (RN-web dev server + browser lane) once this
   machine is quiet. Note the resident local agent is a Jul 26 build that
   predates `/project/preview-capabilities`; the trial used a scratch agent on
   port 18099 with `--no-quic --no-relay --no-tls`, then removed it.
2. tvOS / iOS / Android simulator arcs locally, then the same set on the box
   through the local-first gate.
3. Prove the Yaver-in-Yaver **render** (not the refusal) on each surface that
   has a frame path: web, mobile, tvOS, visionOS. Car and watch have no frame
   path and are dispatch-only by construction.
