# Single-session mode per runner — audit before building

**Date:** 2026-08-02
**Question:** should a new task reuse an existing runner session instead of spawning a
cold one? Make it generic across runners, keep it optional, and decide whether it
should be the default.
**Scope:** analysis only — nothing implemented. Claims are `file:line` from the tree or
measured; anything unverified is labelled.

---

## 0. The short answer

Three things, in order of how much they should change your plan:

1. **This is already built, and switched off by one boolean.** The warm-session /
   resume machinery exists end to end — `WarmUp()`, `warmSessionID`, `resumeTransform`,
   a per-runner argv table — and `ResumeSupported` is assigned **`false` in the only two
   places it is ever assigned** (`tasks.go:121`, `main.go:9376`). `WarmUp()` is called
   (`main.go:3247`) and returns on the first line (`tasks.go:1456`). So the feature is
   dead code wearing a config flag.
2. **It should NOT be the default**, and the reason is not caution — it is that reuse
   makes some tasks *more* expensive, not less (§4), and the agent has almost no
   cross-process locking to make sharing safe (§3).
3. **The right unit is not "one session per runner".** It is **one session per
   (runner × workDir) with an idle TTL**, which is both safer and closer to where the
   savings actually are.

---

## 1. What exists today — three distinct layers, and only two are alive

Session continuity in Yaver is already three separate mechanisms. Conflating them is
the main risk in designing this.

| Layer | What it does | Alive? |
|---|---|---|
| **A. Per-task resume** (`task.SessionID` + `resumeTransform`) | A follow-up on task X resumes X's own session. | **YES** — this is what `/tasks/{id}/continue` uses. |
| **B. Scheduled-run resume** (`ResumeLast`, `ResumeSessionID`, `tasks.go:982`) | A recurring schedule picks up where its last run stopped. | **YES** |
| **C. Warm/shared session** (`warmSessionID`, `tasks.go:2752-2772`) | A *new, unrelated* task resumes a session established at agent start. | **NO — dead** (§2) |

What the user is asking for is **C**, generalized: a new task joins an existing session
rather than starting cold.

`resumeTransform` (`agent_runner_resume.go`) is already the generic, runner-agnostic
seam, and it is good work — per-CLI argv shapes in one place, unit-tested, with a
single oracle (`resumeCanCarryContext`) shared by the argv builder and the prompt
composer so a resumed process can't get a bare follow-up with no briefing:

- **claude** — `--resume <id>`, strips `--no-session-persistence` (a non-persisted
  session cannot be resumed).
- **opencode** — `--continue`, **id-independent**: resumes the most recent session *in
  the working dir*.
- **codex** — `exec resume <id>`, a distinct subcommand that rejects `--full-auto`, so
  the argv is rebuilt and sandbox/approval restored via global flags.

**Design consequence:** opencode's resume is already scoped to workDir and needs no id.
That is not an accident of that CLI — it is the correct granularity, and it is the one
§5 recommends for everyone.

### 1a. "A follow-up in the same task must stay in the same session" — does it?

This is a **separate, non-optional invariant** from the feature in this audit, and it
must hold whatever is decided about shared sessions. Where it stands today:

**The good news — it is preserved by design.** `task.SessionID` is cleared in exactly
two places (`tasks.go:3314`, `tasks.go:4114`) and **both are guarded by a runner
change**:

```go
if runner.RunnerID != prevRunner { task.SessionID = "" }
```

That is correct and deliberate: claude / codex / opencode do not share a session
format, so switching runner mid-task *must* start fresh (the fork path exists for
exactly that). Nothing else drops the id — not a failed turn, not a restart.

**The gap — capture, not retention.** For claude the id arrives structurally
(stream-json). For **codex and opencode it is recovered by REGEX from raw output**
(`parseRawSessionID`, best-effort, `tasks.go:3471`). If that regex misses:

- `resumeCanCarryContext` returns false →
- `resumeTransform` returns `(baseArgs, false)` → a **cold spawn**, and
- `ArmPreamble` flips true, so the runner is re-briefed about Yaver…
- …but **no prior conversation turns are carried.**

I checked for the fallback the code claims. `agent_runner_resume.go:112` says a miss
falls back to *"carry-memo (codex)"* — and the compacted-context builder
(`code_compact_context.go`) is called from exactly **two** places:
`code_control.go:936` (delegating to a child runner) and `task_fork.go:290` (the
runner-switch fork). **Neither is the same-runner follow-up path.** So the memo that
comment promises does not exist there; the file's own header notes it came from a
deleted hybrid-session module. Per CLAUDE.md, when the comment and the code disagree,
the comment is the bug.

**How likely is the miss in practice? Low, and I have live evidence.** `codex exec` on
`ubuntu-4gb-hel1-1` printed:

```
session id: 019fc2b5-f7e0-7be1-bfe4-af0e0b95861b
```

which the first `codexSessionIDPatterns` regex matches cleanly. So the common path
works today.

**But the failure is silent and total.** A changed banner, a quiet/JSON output mode, or
a truncated first chunk yields a follow-up where the model has no idea what came
before — and nothing tells the user, because the preamble *was* re-armed, so the reply
looks confident. That is the "vibe follow-up forgot everything" shape.

**Recommended, independent of the optional feature:**
1. Make the invariant explicit in a test — same task + same runner ⇒ session preserved
   across a failed turn, a restart, and a model/mode change; cleared **only** on runner
   switch.
2. When `resumeCanCarryContext` is false on a **same-runner follow-up**, actually carry
   the memo (the builder already exists) rather than spawning bare.
3. Record on the task whether the turn resumed or went cold, as a structured field, and
   show it. A cold turn the user believes is a continuation is the expensive kind of
   wrong.

---

## 2. The dead switch

```
tasks.go:121     ResumeSupported: false,
main.go:9376     ResumeSupported: false,
tasks.go:1456    if !tm.runner.ResumeSupported { log "Skipping — resume not supported"; return }
tasks.go:2764    if !resumedForSchedule && warmSID != "" && runner.ResumeSupported && …
```

No runner anywhere sets it `true`. So:

- `WarmUp()` never establishes a warm session (its whole body is unreachable),
- the shared-session branch at `2764` can never fire,
- and `GetWarmSessionID()` returns `""` forever.

The machinery also carries a 1-hour expiry (`warmSessionMaxAge`, `tasks.go:2752`) whose
comment says *"Claude Code purges them and resume fails"* — evidence someone ran this
for real and hit the wall.

**Before building anything new, find out why it was turned off.** `git log -S
"ResumeSupported"` will say whether this was "never finished" or "finished, shipped,
and reverted after an incident". Those lead to opposite plans, and the second one is
the plan-changing answer. I have not run it — the package does not currently build in
this tree, and the history question is cheap for you to answer definitively.

---

## 3. Why "one session per runner" is dangerous *today*

A session is a **single-writer** resource: one transcript file, one id, one process
appending. Sharing it across tasks is safe only if writes are serialized. The agent's
concurrency story does not currently support that:

- **Exactly one cross-process lock exists in the whole agent** — the vault's `flock(2)`
  (`vault_lock_unix.go:35`). Everything else is a Go `sync.Mutex`, which is worthless
  across `claude`/`codex`/`opencode` as separate OS processes
  (`memory/project_multirunner_race_inventory`).
- **`TaskManager.workDir` is process-global** and read unlocked at ~9 sites. A shared
  session plus a shared workDir means two tasks can disagree about which repo they are
  in — and `cmd.Dir` for the spawn comes from that value.
- **tmux sessions are already named by runner ID alone** (`runner_pty.go:105`), so two
  clients on `?runner=claude` land in the same TUI and `?fresh=1` kills the other
  mid-turn. That is precisely the collision single-session mode would generalize.
- **`tasks.json` is a bare `os.WriteFile`** (`store.go:77`) whose `Load` returns an
  empty map on parse failure — a torn write silently discards every task. More
  concurrent writers is exactly the wrong direction until that is `tmp+rename+fsync`
  (which `saveConfigUnchecked` already does correctly, one file over).

**Blast radius changes shape too.** Today a poisoned session breaks one task. Under a
shared session it breaks *every* task on that runner, and the failure is confusing
because the damage was done by an unrelated prompt.

---

## 4. The economics — reuse is not uniformly cheaper

This is the part most likely to be got wrong, because "reuse the session" sounds like
it can only save.

**Where it genuinely saves:**
- **Cold-start context.** A fresh run re-reads `CLAUDE.md`, re-explores the repo,
  re-derives what it already knew. That is real, repeated spend.
- **Provider prompt caching.** Both Anthropic and OpenAI cache prompt prefixes, so a
  turn that reuses a warm prefix is cheaper *and* faster. **The cache TTL is the whole
  ballgame and I have not measured it here** — it is short (minutes, extendable), not
  hours. That number should be measured, not assumed, before any TTL is chosen.
- **Rate-limit bucketing.** `tasks.go`'s own comment claims resume keeps you in one
  bucket. **Unverified** — worth confirming, because it is the strongest argument for
  the feature and the easiest to be wrong about.

**Where it costs more:**
- **Transcript growth.** If the provider re-sends conversation history each turn, a
  long shared session makes every *subsequent* task more expensive, and it grows
  without bound. Task #40 in a shared session pays for tasks #1–39.
- **Context pollution.** Unrelated work in the window degrades output quality and
  invites the model to "helpfully" act on a previous task's files. That is not just a
  cost — it is a correctness risk on a tool that edits repos.
- **Cache misses past TTL.** Beyond the cache window you get the *worst* case: a long
  uncached prefix re-sent in full.

**So the saving is real for related tasks in the same repo within the cache window, and
a loss for unrelated tasks or a long-lived session.** Any design that does not bound
the session by *scope* and *age* will make the average task more expensive while
appearing to be an optimization.

---

## 5. The generic design

Keep `resumeTransform` as the runner-agnostic seam; add affinity above it.

**Unit of sharing: `(runnerID, workDir, model, mode)` — not runner alone.**
`workDir` because a session carries repo context and crossing repos is the pollution
case; `model`/`mode` because they change the contract mid-session. Note this is exactly
what opencode's `--continue` already does natively.

**Bound it twice:**
- **Idle TTL**, set from the measured prompt-cache window, not a round number. Past it,
  reuse has no upside and a real downside (§4).
- **Turn/размер cap** — retire a session after N turns or when the transcript passes a
  size the provider would re-send expensively.

**Serialize hard.** One in-flight task per session key, enforced by a real lock, not a
`sync.Mutex` — the agent has one working cross-process primitive (`vault_lock_unix.go`)
and it is generic enough to reuse. A second task on a busy key either queues or spawns
cold; it must **never** attach to a session that has a live writer.

**Degrade to cold, always.** Every failure — expired session, purged id, lock timeout,
`resumeCanCarryContext` false — falls back to a fresh spawn. That is already the shape
`resumeTransform` returns (`(baseArgs, false)`); preserve it.

**Make the reuse visible and attributable.** A task that joined a session must record
which session and why, or debugging "why did my task know about someone else's repo"
becomes impossible.

---

## 6. Should it be the default? — No.

**Recommendation: opt-in, at project granularity, off by default.**

- **Correctness first.** §3 says the primitives to make sharing safe do not exist yet.
  Defaulting to it would turn a documented set of latent races into everyday ones.
- **It is not a strict win.** §4 shows a plausible majority case — unrelated tasks, or
  a session older than the cache window — where the default would *raise* cost and
  degrade output. A default that is sometimes a pessimization is worse than an opt-in
  that is reliably a win.
- **Silent cross-task context is a surprise.** A user who fires a new task expects a
  clean slate. Inheriting an unrelated conversation invisibly violates that, and the
  first time it edits the wrong repo it will read as Yaver being broken.

**What SHOULD be on by default is the thing that is already alive and uncontroversial:**
per-task and per-schedule resume (layers A and B). Those are scoped to one
conversation, and they are exactly right.

A defensible middle if you want the win sooner: default **on for follow-up-shaped work
inside one project**, default **off across projects** — i.e. make the affinity key do
the deciding, rather than a global switch.

---

## 7. UI wiring

The user asked for controls to close/open sessions. Per LESS IS MORE, this should be
**one line and one action**, not a session manager:

- **On the task view:** a quiet line when a task joined an existing session — *"continuing
  session · 12 turns · 40m"* — with an overflow action **"Start fresh session"**. That
  is the "close & open new" control, and it belongs where the consequence is felt.
- **On the project/device view:** the same affordance for the whole key, so a poisoned
  session can be retired without hunting for a task.
- **Never a modal, never a spinner.** Joining a session is a non-event; only *failure*
  to (falling back to cold) is worth a line, and only if it changes what the user should
  expect.
- **Cross-surface:** the state must be a structured field on the task (session id, turn
  count, joined-or-cold), not prose — same law the codex work just applied. Otherwise
  mobile/web/CLI each invent their own rendering and drift.

---

## 8. What I would verify before writing code

1. **`git log -S "ResumeSupported"`** — was this reverted after an incident? (§2). The
   single highest-value question; it can invalidate the whole plan.
2. **The prompt-cache TTL** for both providers, measured, not assumed — it sets the idle
   TTL and decides whether the feature pays at all (§4).
3. **The rate-limit bucket claim** in `tasks.go` — true, or folklore?
4. **What Claude Code actually does to old sessions** — the `warmSessionMaxAge` comment
   says it purges them; confirm the window.
5. **Whether `tasks.json` torn-write is fixed** before adding concurrent writers (§3).

---

## 9. Relationship to the Codex credential work

Two connections worth stating:

- **Same rule, different channel.** "Structured field, not prose" and "degrade to a safe
  default, loudly" are the same laws the parked-turn work just applied. Session state
  should ship as codes and fields from day one rather than being retrofitted.
- **Session reuse does not help credential expiry, and can hide it.** A resumed session
  still authenticates per spawn, so a stale credential fails the same way. But a
  long-lived session makes the failure *rarer and later* — which is worse, because it
  fails further from the change that caused it.
