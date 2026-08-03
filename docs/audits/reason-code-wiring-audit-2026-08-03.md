# Reason-code audit — 2 of 31 codes are actually wired

**Date:** 2026-08-03 · **Method:** every `Reason*` constant in
`desktop/agent/reason_codes.go`, cross-referenced against emitters (the Go
symbol *and* the string literal, in `desktop/agent/` and `backend/`, excluding
tests and the declaration file) and consumers (`mobile/`, `web/`, `tvos/`,
`visionos/`, `watch/`, `wear/`).

## Result

| | count |
|---|---|
| **WIRED** — emitted and consumed | **2** |
| **NEVER-EMITTED** — a surface switches on it; nothing ever sends it | **8** |
| **NO-CONSUMER** — the agent sends it; no surface reads it | **7** |
| **DEAD** — neither end exists | **14** |

`reason_codes.go` exists to end prose-matching. Today 29 of its 31 codes cannot
close that loop, so every surface still falls back to regexing sentences — and
those regexes drift, which is the failure this file was created to prevent.

## The sharpest finding: eight codes are consumed but never emitted

These are **dead UI branches**. The client code is written, shipped, and can
never execute, because no producer exists on either the agent or the backend:

| code | client files ready | emitters |
|---|---|---|
| `capability.toolchain_missing` | **6** | 0 |
| `auth.session.scope_denied` | 4 | 0 |
| `runner.codex.refresh_lineage_lost` | 3 | 0 |
| `runner.codex.refresh_failed` | 2 | 0 |
| `runner.codex.credential_expired` | 2 | 0 |
| `runner.codex.credential_is_copy` | 2 | 0 |
| `runner.codex.credential_corrupt` | 2 | 0 |
| `capability.insufficient_disk` | 2 | 0 |

**`capability.toolchain_missing` is the one that hurts.** Six surfaces are
already built to render a missing toolchain as a named cause with an install
route. CLAUDE.md's worked example is exactly this case: Flutter was not
installed, the agent knew (`exec flutter: executable file not found in $PATH`),
`flutter_install.go` existed and was arch-aware, `POST /install/flutter`
worked — and the phone showed *"Waiting for the dev server to report its
address…"*.

The UI was never the missing layer. **The signal was.** Six surfaces were
waiting for a message the agent never sends.

## Full table

| code | emitters | client consumers | state |
|---|---|---|---|
| `connectivity.no_viable_transport` | 0 | 0 | **DEAD** |
| `connectivity.relay.auth_expired` | 0 | 0 | **DEAD** |
| `runner.codex.not_authenticated` | 1 | 2 | **WIRED** |
| `runner.codex.refresh_lineage_lost` | 0 | 3 | **NEVER-EMITTED** |
| `runner.codex.refresh_failed` | 0 | 2 | **NEVER-EMITTED** |
| `runner.codex.credential_expired` | 0 | 2 | **NEVER-EMITTED** |
| `runner.codex.credential_is_copy` | 0 | 2 | **NEVER-EMITTED** |
| `runner.codex.credential_corrupt` | 0 | 2 | **NEVER-EMITTED** |
| `runner.codex.linux_sandbox_blocked` | 1 | 2 | **WIRED** |
| `runner.claude.auth_required` | 1 | 0 | **NO-CONSUMER** |
| `runner.opencode.unusable` | 1 | 0 | **NO-CONSUMER** |
| `reload.dev_server_unavailable` | 1 | 0 | **NO-CONSUMER** |
| `reload.native_rebuild_required` | 1 | 0 | **NO-CONSUMER** |
| `reload.preview_worker.offline` | 1 | 0 | **NO-CONSUMER** |
| `build.hermes.failed` | 1 | 0 | **NO-CONSUMER** |
| `build.native.failed` | 1 | 0 | **NO-CONSUMER** |
| `deploy.testflight.xcode_missing` | 0 | 0 | **DEAD** |
| `deploy.play.android_sdk_missing` | 0 | 0 | **DEAD** |
| `auth.sdk.scope_denied` | 0 | 0 | **DEAD** |
| `auth.session.scope_denied` | 0 | 4 | **NEVER-EMITTED** |
| `capability.toolchain_missing` | 0 | 6 | **NEVER-EMITTED** |
| `capability.insufficient_disk` | 0 | 2 | **NEVER-EMITTED** |
| `browser_window.chrome_missing` | 0 | 0 | **DEAD** |
| `browser_window.chrome_profile_lock` | 0 | 0 | **DEAD** |
| `browser_window.chrome_runtime_dir` | 0 | 0 | **DEAD** |
| `browser_window.chrome_launch_failed` | 0 | 0 | **DEAD** |
| `browser_window.chrome_snap_confined` | 0 | 0 | **DEAD** |
| `device.identity_conflict` | 0 | 0 | **DEAD** |
| `agent.binary_unrunnable` | 0 | 0 | **DEAD** |
| `agent.not_serving` | 0 | 0 | **DEAD** |
| `connectivity.relay.pin_stale` | 0 | 0 | **DEAD** |

## Fix order

1. **Emit the eight NEVER-EMITTED codes.** The UI already exists — this is the
   cheapest user-visible win in the list, and `capability.toolchain_missing`
   alone closes a documented, repeated incident.
2. **Consume the seven NO-CONSUMER codes**, or delete them. A code the agent
   sends into silence is indistinguishable from prose.
3. **Decide on the 14 DEAD codes.** Five of them are `browser_window.chrome_*`,
   which is a real and frequently-hit failure family (snap-confined Chrome) —
   those deserve wiring, not deletion.
4. **Then remove the substring classifiers.** Not before: deleting a regex
   whose replacement code is never emitted turns a bad diagnosis into none.

## Guard

A code with neither producer nor consumer should not compile clean and silent.
This audit is a script's worth of work (see the commands in the commit) and
belongs in CI, so the next code added is wired or is visibly not.

## Provenance

Both counts verified twice — once by Go symbol, once by string literal —
because `rg` was observed mangling its own output in this environment during
this session and produced two confident, wrong readings before `grep` caught
them.
