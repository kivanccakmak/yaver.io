# ubuntu-4gb-hel1-1 OOM death spiral — 2026-07-27 21:17 UTC

The second resource-exhaustion box-death in one day, mirror-image of the mac
mini's fork exhaustion (docs/audits/agent-fork-exhaustion-deep-analysis-2026-07.md):
the mini ran out of PROCESS SLOTS, ubuntu ran out of MEMORY. Same product gap
both times — the agent neither observes nor sheds its own resource envelope,
and the failure presents as total silence.

## Timeline (kernel journal, boot -1 + hypervisor metrics)

- Jul 27 16:16:35 — global OOM storm #1. Killer takes Talos ERP docker
  containers (`ssioncontroller`, `viders.calendar`, memcg
  `talos-erp-migration.service`) AND **the yaver agent itself at
  anon-rss 2.44 GB** (`task=yaver, pid=1650641, oom_score_adj:0`).
  systemd restarts the agent; nobody is told a thing.
- 16:16 → 21:17 — box keeps serving (all ten closed-loop e2e runs, codex
  tasks, expo/Metro boots) while memory pressure rebuilds.
- Jul 27 21:17:12 — `claude invoked oom-killer`: storm #2. 88 OOM kernel
  events in the boot overall. This time the box thrashes instead of freeing:
  hypervisor CPU pins at ~200 % (both vCPUs), Tailscale peer shows tx-only
  (`rx 0`), ICMP/SSH/agent/relay all dead. Hetzner still reports `running` —
  the inventory says yes while every operation says no.
- 21:24 — `hcloud server reset` (context `my-hertzner`, the only working
  lever; the box is invisible to the `yaver-io` context token). Boot clean,
  agent back, relay tunnel re-established, ~7 min of total outage from
  detection to recovery.

## Why an 8 GB box died

Standing residents measured/observed this session: yaver agent (2.4 GB RSS at
kill time — see "agent RSS" below), a Talos ERP migration **docker stack**
(multi-hundred-MB Java/Python containers, uid 10115/10063), Metro/expo dev
servers (~500 MB+ each; a LEAKED `sfmg` expo from Jul 26 was still running —
`/dev/stop` only stops the CURRENT server), codex/claude runner processes
(Node, hundreds of MB each), plus tmux panes. **No swap at all** — so the
first storm the killer couldn't resolve became an unrecoverable thrash loop
instead of a slow box.

Agent RSS 2.4 GB is itself a finding: tasks accumulate full runner output in
RAM (`t.Output +=` in tasks.go, unbounded; 8 sessions were live), SSE
buffers, metro cache indexes. A Go agent on a render box should not be the
largest resident.

## Box-level mitigations applied (idempotent, persisted, 2026-07-28)

1. 4 GiB swapfile + `vm.swappiness=10` (`/etc/sysctl.d/91-yaver-swap.conf`,
   fstab entry) — converts "thrash to death" into "degrade slowly enough to
   act".
2. `yaver.service` drop-in `OOMScoreAdjust=-800` — the kernel now kills
   runners/Metro/docker before the agent, so the eyes-and-hands survive the
   storm and can report + shed. (Runner children inherit adj 0 → they die
   first, which is correct.)
3. Leaked Jul-26 sfmg expo gone with the reboot; the `/dev/stop`
   only-stops-current gap is recorded below.

## Product deliverables (extends the §3/§4 hardening plan)

1. **The resource warden must cover RAM, not just spawn capability**: sample
   agent RSS + box available MB + swap-in rate; on pressure, shed in order —
   pause screenlog/metrics spawners, stop idle dev servers (the leaked-expo
   class), refuse new task dispatch with a NAMED reason
   (`reason_codes.go`: `box_memory_pressure`), emit flight event + heartbeat
   fields (`memAvailableMb`, `agentRssMb`, `oomKillsSinceBoot`).
2. **Cap in-RAM task output** (ring buffer + spill to disk); 2.4 GB agent
   RSS on an 8 GB box is self-inflicted OOM bait.
3. **`/dev/stop` must stop ALL dev servers it started** (or the dev-child
   warden must reap servers whose project no longer has an active session)
   — the Jul-26 sfmg leak survived 30+ hours across this incident.
4. **OOMScoreAdjust belongs in the shipped unit files** (systemd + launchd
   equivalent `ProcessType`/`LowPriorityIO` tuning on macOS), not a hand
   drop-in on one box.
5. **Provider reset as a first-class repair route**: `machine_repair`
   should learn `action:"provider_reset"` gated on owner approval — the
   hcloud reset was the ONLY lever here and it lived outside the product.
   (Multi-context hcloud: the box was invisible to the default token —
   resolve credentials per machine row, not per install.)
6. **Kernel-truth triage in doctor**: after any unexplained agent death,
   `journalctl -k -b -1 | grep oom` — encode as a doctor probe
   (`doctor_oom_history`) so the next session reads it in ten seconds.

## The pattern across both incidents

Fork table (mini) and memory (ubuntu) are the same failure with different
units: a shared box accumulates resident load the agent neither meters nor
sheds, the kernel defends itself, the agent dies mid-defense, and the product
reports nothing because the reporter is the casualty. The §4 recovery ladder
(sentinel dead-man + provider/plug reset) is the floor; the warden that
observes-and-sheds BEFORE the kernel acts is the actual fix.
