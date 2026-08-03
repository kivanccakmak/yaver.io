# Failure plumbing, measured — layer D exists once

**Date:** 2026-08-03 · **Scope:** `desktop/agent/*.go` HTTP replies + client
error handling in `mobile/`, `web/`.

CLAUDE.md requires four layers on every failure:
**DETECTION → SIGNAL → UI → ROUTE-TO-FIX.** This is what is actually there.

## The numbers

| | count | share |
|---|---|---|
| `jsonError(...)` — prose-only error replies | **1764** | — |
| replies carrying a `"code"` | 124 | **7%** |
| replies carrying a `"remedy"` | 4 | **0.2%** |
| …of those, an *invocable* route rather than a sentence | **1** | **0.06%** |
| `"ok": true` replies | 814 | — |

## Reading

**Layer B (SIGNAL) is prose in ~93% of failure paths.** That is not a style
problem. A bare `{ok:false, error:"<sentence>"}` forces every surface to invent
a regex over English, and those regexes drift — mobile already carries three
different relay-auth matchers, none a superset of the others, and this morning
a fourth (`includes("hermes")`) put two contradictory causes in one alert on a
real phone.

**Layer D (ROUTE-TO-FIX) exists once in the entire agent.** Of the four
`"remedy"` fields, three are English sentences in a field whose name promises a
route:

| file | remedy | actionable? |
|---|---|---|
| `devserver_http.go` | `stream-over-webrtc` | **yes** — a lane a surface can dispatch |
| `mcp_appdev.go` | "Set APP_STORE_KEY_PATH, …" | no — prose |
| `runner_model_probe.go` | "Codex is the runner whose model set is gated…" | no — prose |
| `runner_model_probe.go` | "Install it first — ops verb install_tool…" | no — names a verb, does not carry it |

A prose `remedy` is worse than an absent one: it *looks* structured, so a
reviewer ticks layer D off, and the surface still has nothing to render as a
button. The one real route — `stream-over-webrtc` — was itself unconsumed
until today; the phone showed "Tamam" while the agent was naming the lane that
works.

**814 `ok:true` replies** are the population where "never report success for an
operation that did not happen" has to hold. CLAUDE.md already names two that
do not (`feedback_fix` with no task manager, `launch-feedback` with no
DataChannel). This audit did not classify all 814; that is the next pass, and
it is the highest-risk one, because a false green is invisible by construction.

## Cross-reference

The companion audit `reason-code-wiring-audit-2026-08-03.md` shows why layer B
cannot simply be switched on: of 31 declared reason codes, **2 are wired**, 8
are consumed but never emitted, 7 emitted but never consumed, 14 dead. The
vocabulary for structured signalling exists and is 94% unconnected.

Together the two audits say one thing: **the four-layer law is documented,
partially built, and almost entirely unwired.** Nearly every piece exists
somewhere — codes, remedies, install routes, client branches — and the pieces
do not meet.

## Order of work

1. **Emit `capability.toolchain_missing`.** Six surfaces already render it.
   One emitter closes a repeatedly-documented incident.
2. **Make `remedy` a typed route, not a string.** Three of four current uses
   would fail the type, which is the point.
3. **Give the top-N `jsonError` paths codes**, chosen by how often users hit
   them — preview-session-active (#16) first; it currently offers a "Try again"
   button that cannot succeed while the lock is held.
4. **Then** delete client prose matchers (6 files in `mobile/`). Not before:
   removing a regex whose replacement code is never emitted trades a wrong
   diagnosis for none.
5. **Audit the 814 `ok:true` replies** for operations that did not happen.

## Method note

Counts were taken with `grep`, twice, by symbol and by literal. `rg` was
observed mangling its own output in this environment today and produced two
confident wrong readings before `grep` caught them.
