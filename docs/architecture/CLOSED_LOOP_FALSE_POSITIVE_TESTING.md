# Closed-loop false-positive testing — the "don't scare the user" harness

## The problem, stated precisely

A **false-positive scary label** is any user-facing status that reports
failure / danger / "you must act" while the underlying reality is healthy.
They are worse than silent bugs: they teach the user the product lies, and they
send the user (and us) chasing a problem that does not exist.

Canonical instance (2026-07-28, confirmed live): the web device card shows
**"Alive · can't reach (Unauthorized)"** for `ubuntu-4gb-hel1-1` while that box's
agent answers `/d/<id>/health` **200** and `/info` **200** over the relay — it
is reachable *and* authorized. The label is a false positive caused by the
**web's own stale relay password** (relay returns 401), misattributed to the
agent being unauthorized. The box was fine the whole time.

The class is bigger than one label. Anywhere the UI derives status from a
**proxy** (a heartbeat, a cached probe, an `authVerified` flag, a duplicate
Convex row) instead of the **operation** (an actual request that succeeded), it
can lie. This doc architects a harness that catches the whole class.

## The one rule the harness enforces

> **A surface may only show a scary label after it has (a) attempted the real
> operation, (b) attempted the cheap self-heal, and (c) still failed — and the
> label must name the TRUE cause.** Ground truth is what the operation returns,
> never what an inventory claims.

This is the UI-facing corollary of CLAUDE.md's "probe the operation, never the
proxy" and "every failure must carry a route to its fix."

## Method: a GROUND-TRUTH ORACLE diffed against the rendered UI

Every test cell is a triple **(surface, scenario, domain)** evaluated as:

1. **Establish ground truth independently** — hit the real relay / agent /
   Convex / task API from the harness (NOT through the UI) and compute the true
   state. Examples of oracles:
   - Connectivity+auth: `GET https://<relay>/d/<deviceId>/health` with a VALID
     bearer + relay password → **200 == reachable AND authorized**; 401 with a
     relay-credential body == *our* creds stale (self-healable); a genuine
     agent 401 body == truly unauthorized; no answer == offline.
   - Runner OAuth: `GET /info` → `runners[]`; `installed && ready` == usable;
     `authPresent && !authVerified` is NOT "not installed" and usually NOT
     scary. `status:"needs-auth"` == genuinely needs sign-in.
   - Yaver session: the bearer resolves at Convex `/devices/list` 200 == signed
     in; a rotation-grace window is NOT signed-out.
   - Task: `/tasks/<id>` `status` field is the truth (`running`/`completed`/…);
     no output for N s while `status:"running"` is NOT "failed".
   - Vibing lane: the transport tracker terminal phase (`delivered`) / the
     dev-server `/health` == lane works; a stuck streaming % is NOT "can't
     render."
   - Duplicate rows: two Convex device rows with the same display name but
     different `hardwareId` are two BOXES — the harness must key truth on
     `hardwareId`, not name.

2. **Capture the rendered label** — drive the REAL surface and read what the
   user sees:
   - Web dashboard: RN/Next in Chromium via Playwright (the pattern already
     proven in `scratchpad/rnweb_recursion_probe.mjs` and
     `e2e/transport-security-probe.mjs`) — read the device card / status chips.
   - Mobile: the RN-web build in Chromium at iPhone viewport
     (`e2e/tests/mobile-app-lane-matrix.spec.ts` lane), reading the pill.
   - Native surfaces (tvOS/watch): out of scope for the browser harness; their
     label derivations get UNIT tests against the same oracle shapes.

3. **Assert `label ∈ allowed(truth)`** and classify the verdict:
   - **TRUE-GREEN** — healthy truth, healthy label. Pass.
   - **TRUE-RED** — broken truth, honest scary label naming the real cause. Pass.
   - **FALSE-POSITIVE (the target)** — healthy truth, scary label. **FAIL.**
   - **FALSE-NEGATIVE** — broken truth, green label. Fail (secondary focus).
   - **VAGUE** — label doesn't name the true cause even if directionally right
     (e.g. "Unauthorized" when it's actually "relay password stale"). Warn.

## The domains × scenarios matrix (v1)

| Domain | Scenario (induced) | Truth oracle | Forbidden scary label |
|---|---|---|---|
| Connectivity | box up, our relay pw fresh | relay /health 200 | any "can't reach / Unauthorized / offline" |
| Connectivity | box up, our relay pw STALE | relay 401 w/ credential body | "agent Unauthorized" (must say "relay pw stale" + self-heal) |
| Connectivity | box genuinely down | no relay answer | (RED allowed) "offline" is honest |
| Runner OAuth | Codex installed+signed-in | /info runners[codex].ready | "not installed" / "needs auth" / scary "unverified" |
| Runner OAuth | Codex needs auth | runners[codex].status needs-auth | (RED allowed) |
| Yaver session | valid bearer, mid-rotation | /devices/list 200 | "signed out" / "RESUMING… forever" |
| Task | status=running, quiet 20s | /tasks status running | "failed" / "stuck" |
| Vibing | bundle delivered | transport delivered / dev /health | "can't render" / stuck streaming % |
| Device list | 2 boxes same name | distinct hardwareId | one box's state shown for the other |

Scenarios are induced by the harness where it can (present a stale relay
password to the web session; point at a genuinely-down deviceId; a task known to
be running), and observed where it cannot safely induce.

## Self-heal + fix-triggering (the "fix if possible" layer)

The loop is not just detect → report. On a detected false positive or a real
recoverable failure, it escalates cheapest-first (per FAILURE_PLUMBING):

1. **Deterministic self-heal, in-surface.** The scary-label code path must FIRST
   attempt the cheap repair and re-check before rendering scary:
   - relay-credential 401 → `repairRelayPassword()` (web) / repair rung (mobile)
     → re-probe once. The card only goes scary if the re-probe also fails.
   - session rotation → refresh token → re-check.
   The harness asserts the self-heal FIRED (not just that a label was chosen).
2. **Deterministic remote fix.** Where a one-shot endpoint fixes it
   (`POST /install/<runner>`, re-auth start), the route is offered inline and
   the harness can invoke it.
3. **Remote-runner auto-fix — ONLY when a runner is authenticated.** If the
   defect is a code class (a mislabel, a missing self-heal) and a healthy box
   with a signed-in runner is reachable (probe `/info` runners[].ready), the
   loop MAY dispatch a coding task on that box (never the failing one) with the
   diagnosis + the guard test, branch + PR only, security classes allowlisted
   out. This reuses the `remote-vibe-loop` substrate. Gate: a runner must be
   authenticated (checked via the SAME oracle), else stop at report.

## Where it lives

- `e2e/false-positive-scan.mjs` — the runner. Node ground-truth probes +
  Playwright UI capture + the verdict diff. Creds via env only
  (`YAVER_TEST_EMAIL`/`YAVER_TEST_PASSWORD`, relay pw from `~/.yaver/config.json`
  for the oracle), never written to the repo.
- Pure label-derivation UNIT tests (no browser) for the classifiers:
  `web/lib/connection-error.ts`, `device-lifecycle.ts`, `relayAuth.ts`;
  `mobile/src/lib/relayAuth.ts`. Each asserts the FALSE-POSITIVE case: a
  relay-credential body must never classify as agent-"Unauthorized"; an
  installed+signed-in runner must never derive "not installed"; etc. Run by the
  existing `npx tsx` harness so they're cheap and CI-cheap.
- Native surfaces: mirror the unit tests in Swift/Kotlin against the same oracle
  shapes (cross-surface parity).

## First fixes this harness already justifies (snowball backlog)

1. **Web reachability probe self-heals.** `probeDeviceStatus`
   (`web/lib/agent-client.ts:4253`) records a relay 401 and stamps the card
   "can't reach (Unauthorized)" WITHOUT repairing the relay password + re-probing
   — unlike the connect path. Port the connect path's repair rung into the
   probe. (This alone clears the confirmed false positive.)
2. **Auto-connect to the primary must not be blocked by a stale-probe
   "unreachable."** A real connect attempt (which self-heals) is the truth, not a
   cached probe verdict.
3. **Disambiguate same-name devices** by `hardwareId` in the device list so two
   Hetzner boxes both named `ubuntu-4gb-hel1-1` never show one's state for the
   other.
4. **"unverified" is not scary.** A present, working credential must not render
   in a warning color as if action is required.

Each fix ships with the matching oracle-vs-label test above, proven by breaking
it (flip the fix off, watch the false-positive test go red).
