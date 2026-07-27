# Go agent deep analysis — fork exhaustion + silent death (2026-07-27)

Trigger: `Mobiles-Mac-mini.local` (render box) stopped heartbeating and lost its
relay tunnel for 3+ hours while the box stayed up (Tailscale active, ssh
authenticates). `ssh` exec failed with `exec request failed on channel 0` —
kernel fork/process-table exhaustion. No remote lever existed; only a physical
power-cycle recovers it. Third mini incident in this class (2026-07-24 hung
`find`/`git`, 2026-07-25 hung `tailscale status` — both fixed POINT-WISE, never
as a class; this doc is the class-level analysis).

All paths relative to `desktop/agent/`.

## The composite incident theory (most likely sequence)

1. **Days of leak pressure** filled the process table: unbounded periodic
   spawners + unreaped zombies + orphaned build subtrees (§2).
2. **The agent could not notice**: no spawn-capability probe, no child/fd/proc
   accounting, flight recorder has no degradation event kind (§4). Under pure
   fork exhaustion the heartbeat would have kept beating but LYING (exec
   failures degrade to defaults: `onTailnet:false`, `installedRunnerIds:[]`,
   0% CPU) — heartbeats actually STOPPED, so the process most likely died:
3. **Unguarded `relayManager` maps** (`main.go:10649-10667`, no mutex) are
   written by both `watchConfig` (2-min ticker → `applyRelayServers`,
   `main.go:10744,10748,10758`) and `healthCheckLoop` (60-s →
   `watchdogRelayTunnel` `main.go:10907` → `reloadNow` `main.go:10771`). The
   writers only collide once tunnels are already down — i.e. exactly under
   degradation. A collision is `fatal error: concurrent map writes`:
   unrecoverable, skips defers, writes no flight record.
4. **launchd KeepAlive could not restart** the dead agent — `fork()` fails on
   the exhausted box. Result: 3 h of silence with a green-looking "last agent
   signal" tail.

Triage once the mini is power-cycled: `tail ~/.yaver/logs/launchd-stderr.log`
for `fatal error: concurrent map writes` / `runtime: failed to create new OS
thread`. That one line separates process-death (§3) from goroutine-wedge (§1).

## §1 Heartbeat wedge surface (the 2026-07-25 bug as a CLASS)

`sendOne` (`main.go:10246`) runs INLINE in `heartbeatLoop` (`main.go:10048`,
bare `go` at `main.go:3317`) — no timeout, no recover, not supervised. Any
blocking exec stops all heartbeats forever. Execs reachable per beat with **no
WaitDelay** (grandchild-holds-pipe wedge, measured 40 min on the mini):

- `runner_resolve.go:158-162` — `bash -lc "command -v <runner>"`; login shell
  sources nvm/pyenv/direnv → grandchildren are the NORMAL case. Negative
  lookups never cached (`runner_resolve.go:64-70`) → forks every beat, and at
  dashboard poll rate (1.5 s) via `/agent/runners`.
- `runner_signature.go:79-81` — `<runner> --version` (Node CLIs fork children).
- `hwid.go:66` (`ioreg`), `hardware_profile.go:307` (`system_profiler`,
  `xcrun simctl list`, `emulator -list-avds`) — no timeout at all; both behind
  `sync.Once` (`hwid.go:31`, `hardware_profile.go:70`) so one wedge poisons
  every later caller permanently.
- `tasks.go:611-621` — `GetRunnerInfos` forks runner CLIs while holding the
  global TaskManager RWMutex.

Also unsupervised: both relay loops (`main.go:3989,3990`). The TaskSupervisor
header (`healer.go:5-8`) CLAIMS heartbeat coverage; actual registrations are
seven other loops. The `last-healthy` beacon (`healer.go:483`) keeps refreshing
while heartbeat/relay are dead → external watchdog sees green.

Relay reconnect itself (`runRelayTunnel` `main.go:11217`) is pure Go, infinite
backoff, no give-up state — it WOULD self-heal on a fork-exhausted box. The
only hole is the map race above (+ `defer resp.Body.Close()` inside the loop at
`main.go:10985`).

## §2 Fork/leak inventory (why the table filled)

~1,090 spawn sites, 305 files. **6** use `setProcGroup`; **~33** use
`WaitDelay`. Top contributors on a render mini:

| Rank | Leak | Site |
|---|---|---|
| 1 | tmux poll: 3 unbounded forks / 500 ms / adopted task (~518k/day) | `tmux.go:846` → `tmux.go:1041`, `tmux_panes.go:542`, `tmux.go:1178-1191` |
| 2 | screenlog: 2 `osascript` System-Events + up to 8 `screencapture` per 2 s tick, no timeout, reboot-durable (`main.go:2411`) — `osascript` hangs forever headless/locked | `screenlog_window.go:35,37,116`, `screenlog_capture.go:135` |
| 3 | `exec_command` sh -c: ctx kill hits leader only, grandchildren hold pipes, `Wait()` hangs, hung session unevictable | `exec.go:141,153,236,533` |
| 4 | shell runner jobs: no procgroup/WaitDelay → timeout orphans whole xcodebuild subtree | `runner.go:763,839-840` |
| 5 | 15-min loop re-forking `npm install`+`expo prebuild`+`pod install` per always-failing project, no in-flight guard, re-entrant | `mobile_projects.go:1281-1341` |
| 6 | `execOpen`: `Start()` never Waited — permanent zombie per open_url/auth-browser call | `main.go:10043-10046` |
| 7 | `flutter run` native path opts out of the dev-child registry (no Wait, no procgroup, no RecordDevChild) | `devserver.go:2972-2993` |
| 8 | `docker logs -f` zombie + pipe FD pair per dashboard SSE reconnect | `logs_stream.go:67-72`, `log_search.go:117` |
| 9 | peer-recovery `yaver ssh … sh -c` per offline edge per 60 s, ctx but no WaitDelay | `heartbeat_watcher.go:335,400` |
| 10 | re-entrant `discoverProjects` (status flag is not a lock) ~5 forks/repo | `discovery.go:39,168,183,632`, `httpserver.go:3349,3409` |

Plus ~30 files with `Start()` and zero `Wait()` (voice_*, testkit drivers,
netcapture, stream_webrtc, screenlog_input_capture, backend_pb, site, models,
testing.go emulator, …) and metrics/diskhealth loops (`process_unix.go:200-278`,
`diskhealth.go:162-334`) that fork unbounded probes whose wedge silently
flatlines gauges.

Existing reapers cover only registered dev children
(`devserver_child_registry.go`), WebRTC sessions, guest terminals — there is no
generic Cmd reaper and no orphan sweep; `killProcessGroup` on a non-procgroup
pid fails silently (`ci_selfhosted_runner.go:984`).

## §3 Hardening plan (ranked)

1. **Mutex `relayManager`** (`activeTunnels`/`healthStatus`/`lastSettingsRelay`
   /`noTunnelSince`) — removes the most likely sudden-death.
2. **Fix the wedge class, not sites**: shared spawn constructor (ctx +
   `WaitDelay` + `setProcGroup` + `cmd.Cancel = killProcessGroup`) adopted by
   the three bare helpers (`mcp_devtools.go:603` runCmd,
   `hardware_profile.go:306` runOutput, `screenlog_window.go:115` runOut)
   → ~150 sites in one change. Then tmux helper + screenlog + exec.go +
   runner.go + heartbeat_watcher per table above.
3. **Supervise the vital loops**: register device-heartbeat + both relay loops
   with TaskSupervisor; `sendOne` under abandon-on-timeout + recover; beacon
   refuses to write while any vital loop is stalled.
4. **Spawn-capability warden** (30 s): actually `exec /usr/bin/true`, read
   RLIMIT_NPROC/NOFILE, count own children/fds; on failure record a custodian
   finding + new `flightKindDegraded` flight event + `canFork`/`procCount`
   heartbeat fields (probe the operation, not the inventory — the layer's own
   rule, `custodian.go:46-48`).
5. **Negative-cache runner resolution** (~30 s) and move `GetRunnerInfos`
   probes outside the TaskManager lock.
6. **Point reaps**: `execOpen` Wait-in-goroutine; logs_stream/log_search
   Kill+Wait; flutter native → registry; mobile_projects in-flight guard +
   backoff; discoverProjects singleflight.

Prove each guard by breaking it (disable → watch the test fail), per the
snowball rule.

## §4 Production recovery ladder (how a wedged box gets unwedged without a human)

Constraint that orders the ladder: under fork exhaustion, anything that must
SPAWN is dead. Each layer must function with strictly fewer capabilities.

0. **Prevent** — the §3 leak fixes (spawn constructor, reaps, mutex).
1. **Foresee** — spawn-capability warden (`exec /usr/bin/true` every 30 s),
   `canFork`/child/fd counts on the heartbeat; agent sheds optional spawners
   (screenlog, tmux poll, metrics execs) under pressure and names it.
2. **Self-heal in place** — `kill()` is a syscall, not a spawn: the live agent
   SIGKILLs its own leaked children from in-process inventory to free slots,
   then exits for a clean launchd respawn. Recovers exhaustion WITHOUT reboot,
   provided the agent process survived (why the relayManager mutex is rank 1).
3. **Dead-man reboot, fork-free** — resident root sentinel watches the agent
   beacon and calls the reboot SYSCALL directly on prolonged staleness (a
   resident process needs no fork even at 100 % table exhaustion). Linux edge:
   kernel/systemd hardware watchdog petted by the agent. Cloud: provider API
   reset (hcloud) — already a Yaver lever.
4. **Remote physical** — macOS has no user hardware watchdog:
   `systemsetup -setrestartpowerfailure on` + smart plug driven by Yaver's own
   shelly/tasmota/govee verbs → owner-approved `machine_repair
   action:"power_cycle"`. ~€15 guarantees no on-site human even when 0–3 fail.

Corollary: render boxes are cattle — clones + toolchains only, safe to
power-cycle at any moment, by design. Pair with backup `# yaver-managed`
forced-command watchdog keys provisioned WHILE HEALTHY (the ubuntu→mini auth
gap found 2026-07-27) so Layer 3's peer path can also restart agents in the
non-exhaustion wedge cases.
