# Why Codex keeps signing out on the remote box — and what "make it long" actually means

**Date:** 2026-08-02
**Trigger:** User on holiday, driving tasks from the TestFlight mobile app against an
Ubuntu 4 GB Hetzner box with Codex. Remote OAuth worked (codex included). The task ran.
Then the user tried to send a **follow-up in the same session** and Codex was signed out
**again**.
**Scope:** analysis only — no code changed. Every claim below is either measured on this
machine, read out of the shipped `codex-cli 0.142.5` binary, or cited as `file:line`.
Unverified claims are labelled **HYPOTHESIS** with the experiment that settles them.

---

## 0. The one-sentence answer

Codex's access token lasts **10 days** and is refreshed **only by a running Codex process
during a real turn**; Yaver never refreshes it, believes it *cannot* be refreshed
(a wrong premise written into `runner_preflight.go:15`), probes it with a command that
cannot see expiry, and can *manufacture* a sign-out that never happened — so the first
thing that ever discovers a dead credential is the user's next prompt, and the prompt dies
with it.

---

## 1. Measured facts — the Codex credential model

`codex-cli 0.142.5`, `~/.codex/auth.json` on this Mac (values redacted, shape and
lifetimes real):

| Field | Value |
|---|---|
| `auth_mode` | string |
| `OPENAI_API_KEY` | `null` (subscription mode, per house law) |
| `tokens.access_token` | JWT, `iat`→`exp` = **240 h = 10 days** |
| `tokens.id_token` | JWT, `iat`→`exp` = **1 h** |
| `tokens.refresh_token` | opaque, 211 chars |
| `tokens.account_id` | uuid |
| `last_refresh` | `2026-07-30T23:06:58Z` (3 days ago) |

From `strings` on the binary:

- Refresh is a standard `/oauth/token` + `grant_type=refresh_token` + `client_id` call.
- The response type is `struct RefreshResponse with 3 elements` carrying
  `access_token` **and `refresh_token`** — i.e. **the refresh token ROTATES on use**.
- There is an app-server JSON-RPC verb: `account/chatgptAuthTokens/refresh`.
- Codex ships a full **auth recovery ladder**: `Reloading auth` → guarded reload → refresh
  → retry, with telemetry tags `auth_retry_after_unauthorized`, `auth_recovery_mode`,
  `auth_recovery_phase`, `auth_recovery_followup_success`, `auth_error_code`.
- Two *distinct* terminal messages, and the difference matters enormously:
  - `Your access token could not be refreshed. Please log out and sign in again.`
    → the refresh call itself failed.
  - `Your access token could not be refreshed because you have since logged out or
    signed in to another account. Please sign in again.`
    → **account / credential-lineage mismatch.** This is the fingerprint of *two holders
    of one credential*, or a re-login elsewhere.
- `Skipping token refresh because auth changed after guarded reload.`
  → Codex itself defends against concurrent auth mutation. Yaver does not.

**Consequence:** a Codex login is intrinsically long-lived (10-day access token, renewable
indefinitely by rotation) — *provided something refreshes it*. Nothing in Yaver does.

---

## 2. Measured: `codex login status` cannot detect an expired token

```
$ time codex login status   →   "Logged in using ChatGPT"   real 0.08s   (×3)
auth.json mtime/size:       UNCHANGED before and after
```

So the probe Yaver leans on (`runner_auth.go:1238 codexLoginStatusOK`) is:

- **a presence check, not a liveness check** — it reads the file shape and returns 0;
- **it does not consult `access_token.exp`** — my local token has 7 days left, and a token
  with −7 days would report the same "Logged in using ChatGPT";
- **it never refreshes** — it does not touch the file at all.

The code comment at `runner_auth.go:1165` is honest about this ("PRESENT, not VERIFIED"),
and `DetectRunnerRuntimeStatus` correctly refuses to set `AuthVerified` from it. The gap is
not dishonesty — it is that **nobody ever computes the one number that matters (`exp`)**,
even though it is sitting in a file we already read.

Secondary defect at the same call site: the probe is killed at **2500 ms**
(`runner_auth.go:1253`) with `WaitDelay: 1s`. That is 0.08 s here and a coin-flip on a
swapping 4 GB box. A timeout silently degrades the verdict to file-presence-only.

---

## 3. The wrong premise that explains the whole absence

`desktop/agent/runner_preflight.go:15`:

> *"It cannot silently refresh a subscription OAuth token (claude / codex tokens are
> re-auth-only), so 'proactive' here means: detect early + hand back an actionable CTA."*

**This is false for Codex 0.142.5.** The refresh grant exists, is non-interactive, and
Codex performs it routinely (my `last_refresh` is 3 days old on a login from April —
`id_token.auth_time = 2026-04-27`). The credential has been alive for **three months**
purely on rotation.

That single sentence is why the product has:

- a health loop that **only observes** (`runner_auth_health_loop.go:29`, 6 h cadence,
  explicitly "no API call, no token spend" — and no refresh either);
- a preflight whose best outcome is a CTA telling a human to go do OAuth;
- no keep-alive anywhere, on any surface.

Yaver built an excellent *detection and reporting* layer for a problem that was
**preventable**.

---

## 4. Why it dies specifically on a holiday box

Refresh happens **only inside a Codex process during a real turn**. So credential freshness
is a function of *how often you run Codex on that box*. The failure window is:

```
day 0   OAuth on the box            access_token exp = day 10
day 1-2 a few tasks                 each turn refreshes → exp pushed out
day 3-9 box idle (you are at the beach)
day 10+ access token EXPIRED. Nothing has run. Nothing noticed.
        → your next prompt is the discovery mechanism.
```

A 6-hourly probe that cannot read `exp` (§2) sails through this entire window reporting
"Logged in using ChatGPT". The 10-day token and the "I use this box every few days" pattern
are almost perfectly tuned to collide.

---

## 5. "Again" — the three ways Yaver re-creates the sign-out

### 5a. Refresh-token rotation makes credential copies mutually destructive

Because the refresh token rotates (§1), **any two holders of one lineage race**, and the
loser is permanently signed out with the "signed in to another account" message.

Yaver ships this as a *feature*, twice:

- `runner_auth_mirror.go` — copies `~/.codex/auth.json` **verbatim** from a signed-in Mac
  to any other box ("Mirror copies the whole file verbatim", `runner_auth_mirror.go:15`).
- `runner_auth_credentials_import` (`mcp_tools.go:2065`) — same thing via MCP, and the tool
  description actively recommends it as *"the preferred path"*.

Neither records lineage or ownership. After a mirror, the Mac and the Hetzner box hold the
same refresh token. Whichever refreshes first consumes it; the other gets `invalid_grant`
and prints the account-mismatch line. Then you re-auth that one, and the *first* box
becomes the loser. **That is the "signs out again, and again" oscillation.**

The same race exists *within* one box: Yaver runs concurrent tasks and warm sessions, and
nothing serialises refresh. Codex guards its own (`Skipping token refresh because auth
changed after guarded reload`), which limits but does not eliminate it across processes.

### 5b. Yaver can mark a healthy runner signed-out from ordinary task output

`runner_auth_observe.go:44 ObserveRunnerAuthFromOutput` runs on **every terminal task**
(`tasks.go:3266`) and substring-scans **the entire task output** for phrases including
`` please run `codex login` ``, `codex login --device-auth`, `api error: 401`,
`401 unauthorized` (`runner_auth.go:496-568`).

A vibing session that greps, prints, diffs or writes about auth trips this. **This
repository's own source contains every one of those exact strings.** One match sets
`lastRunnerAuthFailure` for **30 minutes** (`runnerAuthFailureTTL`, `runner_auth.go:245`),
which forces `AuthConfigured=false` → `AuthVerified=true (negative)` → `Ready=false`
(`runner_auth.go:203-228`), which drops the box out of every picker and makes preflight
report "needs reauth" — **with a perfectly valid credential on disk and no file changed.**

The PTY path already does this correctly — it scans only a tail
(`terminal_session.go:308`, `authTail`). The task path scans everything.

### 5c. A 4 GB Hetzner box is the worst host for a mid-write credential — **HYPOTHESIS**

`project_ubuntu_oom_death_spiral` records the agent being OOM-killed at 2.4 GB on exactly
this SKU. A Codex process killed while rewriting `auth.json` leaves a truncated file → hard
signed-out, unrecoverable without re-login. Whether Codex writes atomically (tmp+rename) is
**not established** and cannot be read from the binary.
*Experiment:* on the box, `stat` + `md5` `auth.json` around an OOM event; check for
`auth.json.tmp`/partial files; check `dmesg -T | grep -i oom` timestamps against the
sign-out times.

---

## 6. Answering "does Hetzner/VPS make it shorter? Is Codex aware it's a VPS?"

**No evidence that the token is shortened for a VPS.** The lifetimes are baked into the JWT
(`exp - iat = 240 h`) and there is nothing IP-derived in the shape. Nothing in the binary
suggests a datacenter-specific session policy.

What *is* true is that a VPS multiplies every way a refresh can fail:

1. **Datacenter egress draws challenges.** A refresh from a Hetzner IP against an account
   normally used from a residential IP is exactly the pattern account-security systems
   flag. A blocked refresh looks identical to an expired one from where Yaver stands.
2. **It is the box you touch least** — §4's idle window is a VPS phenomenon.
3. **It is memory-starved** — §5c, and §2's 2.5 s probe timeout.
4. **It is headless** — so the *remedy* Yaver prints is wrong (§7).

**Verification needed on the box** (settles it definitively): decode `access_token.exp - iat`
in the box's `auth.json`. If it is also 240 h, VPS does not shorten anything and every
sign-out is one of §4/§5. **I could not run this** — this Mac's *Yaver* session is expired
(`yaver status` → `session expired`; `yaver devices` → 401), so I have no path to the box
without re-authing, which I have not done.

---

## 7. The follow-up turn — where "keep vibing" actually broke

`httpserver.go:5397 continueTask` decodes the body and calls `ResumeTaskWithOptions`
**directly**. There is:

- **no runner preflight** — `RunnerPreflightByID` exists (`runner_preflight.go:35`) and is
  wired to **voice only**, as previously recorded. The follow-up path never calls it.
- **no expiry check** — free to compute, never computed.
- **no held prompt** — the input is consumed into a doomed spawn and is not parked anywhere
  for replay.

So a follow-up on a stale credential = spawn a process that cannot authenticate, wait, and
report a corpse. The user's prompt is gone; the session thread is gone.

And when the CTA *does* render, it is wrong for this machine: `runner_preflight.go:73`
returns **`codex login`** for codex — the interactive browser flow, which cannot complete on
a headless VPS. The correct remedy is `codex login --device-auth` (which Yaver knows about —
it is in the classifier at `runner_auth.go:508` and in the error text at
`runner_auth.go:1190`). This is a route-to-fix that routes into a wall.

---

## 8. Token-usage economics (the "optimized token usage" ask)

The current design pays for auth knowledge **in LLM turns**:

- The *only* positive proof of a working credential is a completed generation
  (`runnerTurnProvesAuth`, `runner_auth_observe.go:69`) — i.e. Yaver learns the credential
  works by spending a run.
- The *only* discovery of a dead credential is a failed run — i.e. Yaver learns it is dead
  by wasting a run, plus the user's wait.
- Escalation is toward a coding-agent run ("Fix in Yaver") for a class whose real fix is one
  HTTP request.

Against that:

- A **refresh costs one HTTP request and zero tokens.**
- An **expiry check costs zero** — parse `exp` out of a file we already open. It is also
  *more* truthful than the 0.08 s fork we do every 60 s (`codexLoginStatusTTL`), because
  `login status` cannot see expiry at all (§2).

Cheapest correct signal, most expensive current signal — inverted.

---

## 9. What "make it long" means, concretely

Ordered by leverage. This is design, not implementation; nothing here is written yet.

> **The load-bearing insight (see §9b):** Yaver spawns a **fresh Codex process for every
> turn**. So refreshing *before the spawn* both keeps the credential alive and sidesteps the
> open upstream bug where a live session cannot pick up an external refresh
> (`openai/codex#17041`). Everything below hangs off that.

**A. A refresh leg on the ping-pong we already run.**
Yaver already heartbeats (~30 s device, 6 h runner health). Add *refresh*, not a new
surface. Decide from `access_token.exp` on disk — zero network, zero fork, zero tokens.
When inside the renewal window, perform the non-interactive refresh.

> **Open decision, and it is the important one:** drive **Codex's own refresh path**
> (its app-server verb / its own recovery ladder) rather than re-implementing
> `grant_type=refresh_token` in Go. Re-implementing means Yaver owns rotation correctness
> forever, and a bug there does not degrade — it **destroys the user's login**. Needs one
> verification on a box: does the CLI expose a non-interactive "refresh now"?

**B. Cadence from the token, not from a constant.** 6 h is wrong in both directions for a
10-day token. Re-arm at `exp − 24 h` (jittered) on every write.

**C. Single-writer lineage.** A mirrored/imported credential must record who owns the
lineage; a non-owner must **never** refresh (it will consume the owner's token — §5a).
Either mirroring transfers ownership explicitly, or Codex is device-auth-per-box and
mirroring is refused for it. Plus a real single-flight lock around refresh on one box.

**D. Stop manufacturing sign-outs (§5b).** Tail-scan like the PTY path already does; never
let a *successful* task's body assert a rejection; require the phrase to be terminal runner
output rather than anything in the transcript. This is a correctness fix independent of
everything else.

**E. Preflight the follow-up — silently.** `continueTask` consults the known expiry, and if
stale, refreshes **before** spawning. Nothing reaches the screen unless the refresh fails.

**F. Hold the turn and replay it.** When auth genuinely dies, park the prompt with the task;
on successful re-auth, replay it into **the same session** automatically. This is the
difference between "signed out again" and seamless. Today the prompt is simply lost (§7).

**G. UI law — a refresh is a non-event.**
No spinner, no toast, no modal, no banner, no transcript line, no re-render. Per CLAUDE.md's
*no surprise re-render* and *LESS IS MORE*: the only thing that may ever reach the screen is
a genuinely unrecoverable re-auth — **one line, one button, in place**, on the surface the
user is already looking at. A successful keep-alive must be invisible by construction, not
invisible by luck.

---

## 9b. Industry: has anyone solved this?

Researched 2026-08-02. Short version: **every mechanism I derived from the binary is
independently documented, two of the failure modes are open upstream bugs with no fix, and
the fix Yaver needs has a standard name and a standard shape.**

### What is confirmed externally

- **~8-day idle staleness.** Codex sessions are considered stale after roughly 8 days
  without a refresh; idle beyond that requires a fresh login. This corroborates the 240 h
  (10-day) `exp` I measured, and confirms §4 is a real, documented cliff — not a theory.
- **Codex already refreshes correctly *inside* a process.** It refreshes proactively during
  an active session and reactively (refresh-and-retry) on a 401. So the CLI is not the
  problem; **the gap is entirely "nothing runs between visits"** — which is Yaver's job,
  and which `runner_preflight.go:15` talked the product out of doing.
- **RFC 9700 (BCP, Jan 2025) makes rotation + reuse detection + family revocation the
  standard.** On detecting a replayed refresh token, the authorization server is expected to
  **revoke the entire token family**. That is the textbook mechanism by which *one stale
  copy can sign out every machine at once* — not just lose its own turn. It elevates §5a
  from "the loser re-auths" to "**everything re-auths**", which matches the user's
  experience of repeated, spreading sign-outs.

### The two open upstream bugs that bound what Yaver can fix

- **`openai/codex#22577` — `codex logout` on one instance logs out all instances across
  machines.** Explicitly filed by a user running local + VPS + SSH boxes. No maintainer
  response, no workaround documented, still open. *Implication:* on a multi-box account,
  some sign-outs are simply not Yaver's fault and cannot be prevented by Yaver — but they
  **can** be recovered from without losing the user's turn.
- **`openai/codex#17041` — a live session cannot pick up an external refresh.** "On token
  expiration an external refresh (login in a different process) does not fix existing live
  sessions"; the reporter notes "high impact on headless Codex use". Open, no fix.
  *Implication, and it is good news:* Yaver spawns a **fresh Codex process per turn**
  (`ResumeTaskWithOptions` → `startProcess`). So a **refresh performed before the spawn
  completely sidesteps #17041.** Yaver is in a structurally better position than the CLI's
  own long-running-session users. This is the single highest-leverage fact in this document.

### The canonical CI/VPS pattern — and Yaver does the exact opposite

The documented pattern for long-lived headless Codex is:

> Seed `CODEX_AUTH_JSON` from a stored secret **on first run only**, let Codex auto-refresh,
> and **persist the refreshed `auth.json` between runs**. *"Without it, every run overwrites
> the refreshed auth.json with the original (increasingly stale) secret, eventually causing
> auth failures."* Use **conditional seeding** and **concurrency serialization**.

Yaver's `runner_auth_mirror.go` copies the file **verbatim** on demand, and
`runner_auth_credentials_import` advertises itself as *"the preferred path"*
(`mcp_tools.go:2065`). That is *unconditional* re-seeding with an increasingly stale
secret — the precise anti-pattern the guidance names, shipped as a headline feature, with
no lineage record and no serialization.

### The general pattern this problem belongs to

The industry name is the **credential broker**: *one* component is the refresh authority;
runtimes hold only short-lived material and ask the broker when it is missing, past
`refresh_after`, near expiry, or after a forced auth retry. The failure Yaver hit is
described in those terms almost verbatim:

> "Copying the same refresh token into multiple auth stores lets more than one process act
> as a refresh authority. The first refresh rotates the token; the next runtime can then
> fail with a consumed/invalid refresh token."

The devcontainer/DevPod world solves the same problem the same way: the long-lived material
stays on the host, and a host-side helper hands the sandbox a **short-lived token plus its
expiry**, which the proxy caches and refreshes.

**Where this leaves Yaver:** Yaver is already the broker-shaped component — it is the
long-running daemon on every box, it already heartbeats, and it already spawns every Codex
turn. It has all the position and none of the behaviour. The correct design is not novel;
it is the standard one, and §9 A–G is that standard applied.

---

## 9c. What landed (2026-08-02, same session)

Implemented against §9. Uncommitted at time of writing.

| # | Change | Files |
|---|---|---|
| A | **Keep-alive.** Non-interactive `grant_type=refresh_token` renewal, single-flight in-process + cross-process, re-read under the lock, atomic all-or-nothing write, unknown fields preserved, lineage never blanked. Endpoint + public client id read out of the shipped binary, not assumed. | `runner_auth_refresh.go`, `codex_credential.go` |
| B | **Expiry oracle.** `exp` parsed from the JWT already on disk — zero network, zero fork, zero tokens. Now runs *ahead* of `codex login status`, which measurably cannot see expiry. A truncated `auth.json` is named as an interrupted write, not "no credentials found". | `codex_credential.go`, `runner_auth.go` |
| C | **Two consumers.** A 15-min background loop (the holiday case) and a pre-spawn hook on every follow-up (the case the user hit). Silent by contract; a transient failure never blocks a turn whose token is still valid. | `runner_auth_keepalive.go`, `httpserver.go` |
| D | **Parked turns.** A follow-up that cannot run is kept, not spent, and replays into the same session on recovery. Taking is atomic, so a prompt can never fire twice; 2 h TTL so stale intent expires. | `task_parked_turn.go`, `httpserver.go` |
| E | **No more manufactured sign-outs.** Auth classification now reads the last 4 KB, not the whole transcript. | `runner_auth_observe.go`, `tasks.go` |
| F | **Lineage ownership.** Mirroring is conditional seeding (refuses to clobber a healthy different lineage), records provenance, and a copied credential is never renewed here — renewing is what kills the source box. | `runner_auth_lineage.go`, `runner_auth_mirror.go` |
| G | **Route-to-fix that works.** `codex login` → `codex login --device-auth`; the wrong premise in the preflight header is corrected in place. | `runner_preflight.go` |
| H | **Surface contract.** Four new reason codes, and a mobile consumer that keys off `code` rather than a prose regex, so a parked turn reads as "message saved" rather than "failed". | `reason_codes.go`, `mobile/src/lib/parkedTurn.ts`, `mobile/src/lib/quic.ts` |

**Landed after the first pass (same session), while verifying the HEADLESS route:**

| # | Change | Files |
|---|---|---|
| I | **The keep-alive moved to the seam every dispatch passes through** — `startProcess`, not just `continueTask`. New tasks, MCP calls, webhooks, the scheduler and voice all inherit it. Non-fatal by design: a renewal that cannot happen must not stop a task whose credential is still valid. | `tasks.go` |
| J | **Three headless-hostile remedies fixed.** `diagnose_checks_v2.go` and `monorepo_start_auth.go` told users on browserless boxes to run bare `codex login` — the latter often prefixed with `yaver ssh <box> --`, i.e. explicitly *for a remote machine*. `runner_auth.go:513` said "Sign in again" with no command, so the obvious guess was the one form that fails. Guarded by a source-scanning test with a documented allow-list. | `diagnose_checks_v2.go`, `monorepo_start_auth.go`, `runner_auth.go`, `runner_auth_headless_remedy_test.go` |
| K | **Replay wired into ALL THREE recovery paths.** It fired only on keep-alive renewal — but `codex login --device-auth` establishes a NEW credential rather than renewing one, so on a headless box (the reported case) the replay never ran. The user would be told "it will send once you're signed in", sign in, and nothing would happen. | `runner_auth_browser_http.go` |
| L | **CLI surface.** The surface you are *on* when you SSH to the box to fix the credential — so the one most likely watching when the replay fires. Now prints "message saved" + the device-auth command instead of an error. | `client.go` |
| M | **Surface + parity tests**, proven by breaking: deleting one branch from the web copy fails the mobile test with the exact designed message. | `mobile/src/lib/parkedTurn.test.ts` |

**A correction worth recording.** The first version of the false-sign-out negative
control passed with the guard removed — it was asserting on the wrong runner. The
classifier attributes by *phrase*, not by which runner produced the output, so a
**codex** turn quoting Claude's wording marks **claude** signed out. The test now
covers both directions. A negative control that cannot fail is not evidence, and this
one nearly shipped as decoration.

**Still open / deliberately not done:**

- The keep-alive reads the agent's own `CODEX_HOME`, so a box running tasks under a
  different tenant home is not covered. (A turn there is never *blocked* by this —
  see the absence-is-not-evidence guard — it simply is not renewed.)
- Claude has no refresh lineage Yaver can drive and remains detect-and-report.
- **PRE-EXISTING copies carry no lineage marker, and this is the one gap worth
  stating plainly.** The marker is written when a credential is mirrored *from now
  on*. A box whose `auth.json` was copied there weeks ago is indistinguishable, on
  local evidence alone, from one that signed in for itself — so the keep-alive will
  renew it, and that renewal invalidates the source. Two honest caveats about the
  severity: this failure already happens today (any real Codex turn on either box
  refreshes and rotates, killing the other — that IS the reported symptom), so the
  change does not introduce a new class of failure; but it can make it fire while a
  box is *idle* rather than only when it is used. The durable fix is the operational
  one: **give each box its own `codex login --device-auth`.** The conditional-seeding
  guard now prevents new copies from being created; it cannot retroactively know
  about old ones. Question 3 in §10 is exactly this, and it is why that question is
  the highest-value one to answer before rolling the keep-alive out to a fleet.

---

## 10. Open questions (need the box; blocked on Yaver re-auth)

1. `exp − iat` in the box's `auth.json` — same 240 h, or shortened? (Settles §6.)
2. `last_refresh` vs. the observed sign-out timestamps — idle-expiry (§4) or rotation race
   (§5a)?
3. Was that box's credential ever **mirrored/imported** from the Mac, or always its own
   device-auth? (Decides whether §5a is the primary cause or irrelevant.)
4. Any truncated/partial `auth.json` or OOM kills correlated in `dmesg`? (§5c.)
5. Does the agent log show `auth-failure pattern detected for runner "codex"`
   (`tasks.go:3218`) on runs that actually **succeeded**? That is §5b, caught red-handed.

Question 3 is the highest-value single answer: it splits "the token quietly aged out" from
"we shot it ourselves", and the fixes differ.
