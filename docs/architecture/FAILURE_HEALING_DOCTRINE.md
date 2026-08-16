# Failure-healing doctrine — how "won't happen again" is managed

Distilled 2026-07-28 from a single 24 h period in which two boxes died the
same death in different units — the mac mini by fork-table exhaustion, the
ubuntu render box by memory exhaustion — and a ten-run closed-loop e2e
surfaced five silent product truths. Companion to
`FAILURE_PLUMBING_ARCHITECTURE.md` (the four-layer failure contract),
`docs/audits/agent-fork-exhaustion-deep-analysis-2026-07.md` and
`docs/audits/ubuntu-render-oom-incident-2026-07-27.md` (the evidence).

## The eight laws

1. **Fix the class, or the class fixes you.** The 07-24/25 incidents got
   point fixes (WaitDelay on the tailscale and git probes); the CLASS —
   ~1,000 unbounded exec sites — stayed live and took the mini down on
   07-27. Every incident fix must name its class in the commit; the class
   is either fixed in the same change or filed as a ranked debt with a
   grep-able marker. A point fix that ships without naming its class is a
   recurrence scheduled for later.

2. **The reporter must outlive the failure.** Both boxes died SILENTLY
   because the thing that reports was the casualty: the agent crashed
   (concurrent map write) or was OOM-killed mid-storm, and the
   `last-healthy` beacon kept looking green. Observation must be strictly
   more resilient than the observed: vital loops supervised, the beacon
   refusing to write while they stall, `OOMScoreAdjust` shielding the
   agent, a dead-man sentinel that needs NO fork to act, flight-recorder
   events for degradation (not just lifecycle).

3. **Probe the operation, never the inventory** — re-proven ~7× in one
   day: Hetzner said `running` while the OS thrashed; Tailscale said
   `active` with rx 0; the task said `review` while nothing was served;
   `/dev/reload` said 200 while rebuilding nothing; the dev server said
   `running` while serving a stale bundle; `ssh` authenticated and then
   could not exec. Every green that is not the operation itself is a
   liability to be hunted, not trusted.

4. **Every finite resource is product surface.** Fork slots, RSS, inotify
   watches, fds, disk, swap: the agent consumed all of them as if
   infinite, and each exhaustion was invisible until fatal. The law:
   meter → threshold → SHED (pause optional spawners, stop idle dev
   servers, refuse new work) → named refusal (`reason_codes.go`), carried
   on heartbeat + flight recorder + every UI surface. The kernel must
   never be the first to notice.

5. **Recovery is a product route, not operator folklore.** The only lever
   that saved ubuntu (`hcloud server reset`, in a NON-default context) and
   the only lever that will save the mini (smart-plug power cycle) lived
   in a human's head. Each rung of the recovery ladder (audit §4:
   prevent → shed → self-heal → dead-man reboot → provider/plug reset)
   must be an invocable `machine_repair` action with owner consent — the
   next tap, streamed, on the surface the user is looking at.

6. **A guard unproven is a guess.** Every guard lands with the
   break-it test: remove the mutex → race detector fires; remove the
   no-store header → the cache test fails; disable the warden → the
   drill box goes dark. Box-level chaos drills (ulimit-capped forks,
   memory balloon on a disposable box) graduate this from unit tests to
   the real failure shape.

7. **Admission control before every heavy action — especially builds.**
   The agent must know the hardware it stands on (cores, RAM+swap headroom,
   disk, fork/fd headroom, load, thermal/battery where relevant) and the
   COST CLASS of what it is about to spawn (xcodebuild/gradle ≫ Metro
   export ≫ npm install ≫ probe), and decide BEFORE spawning: proceed /
   queue behind the running build / shed optional load first / refuse with
   a named reason AND a route — "this box cannot afford this build now;
   run it on <other box> / managed cloud / CI" is a placement answer the
   runner-render split already knows how to route. Yesterday's kill list
   is exactly the actions an admission gate would have queued: concurrent
   Metro boots + codex + docker on 8 GB with no swap. One global
   build-slot semaphore sized by measured RAM, not by optimism; every
   deferral narrated (what is waiting, on what, since when).

8. **The closed loop is the oracle.** One evening of
   `e2e/remote-vibe-loop.mjs` falsified five layers of green (relay auth,
   task landing, reload semantics, file watching, HTTP caching) that unit
   tests and status endpoints all vouched for. A change that cannot be
   observed end-to-end from the surface the user actually holds is not
   finished; the loop runs before release, and SILENT is its only failure.

## The management loop (how lessons compound instead of drift)

- **Incident → audit doc, same day** (`docs/audits/`), stating the false
  green verbatim, the class, and RANKED deliverables with file:line.
- **Deliverables → code with proven guards**, consumer landed in the same
  change (a signal with no consumer is not shipped), cross-surface per
  the parity rule.
- **Class debt → the failure×route matrix** in
  `FAILURE_PLUMBING_ARCHITECTURE.md` grows a row; REMAINED-TASKS carries
  the ranked remainder so no session rediscovers it.
- **Release gate**: closed-loop e2e (single-box always; split when two
  boxes exist) + the race/cache/warden guard tests. The loop's verdict
  vocabulary is the release's: PIXELS ships, NAMED explains, SILENT blocks.
- **Memory**: session-crossing facts (levers, contexts, box state) go to
  the operator memory index the same hour they are learned.

## Why this is the snowball and not a runbook

Every mechanism above lands IN the product: the warden sheds for every
user's box, the named refusal renders on every surface, the repair action
is a button a phone user can tap. The re-auth/reset that fixed one machine
taught the product nothing; the doctrine exists so that by the time a
failure repeats, it finds the guard already waiting — and the guard has
already been watched failing on purpose.
