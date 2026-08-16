# Failure-plumbing synthesis — 2026-07-28 session

Every failure this session, mapped onto the four-layer failure contract
(`FAILURE_PLUMBING_ARCHITECTURE.md`: **detect → signal → UI → route-to-fix**),
with the missing layer named and — where possible — the **remote-runner
auto-fix** path (escalate to a coding agent on a healthy box to fix the CLASS,
not just the instance). Companion to `FAILURE_HEALING_DOCTRINE.md`.

## The auto-fix decision rule (when a remote runner should fix it)

For each failure, the route-to-fix is one of three, cheapest first:
1. **Deterministic fixer** — one command/config (`POST /install/flutter`,
   `hcloud reset`, raise a ulimit). Never spend an LLM run on this.
2. **Self-heal in-process** — a warden acts (reap zombies, shed load, redial).
3. **Remote-runner auto-fix** — the failure is a CODE defect with no
   deterministic fixer, and a healthy box + a runner (Codex/Claude) can be
   dispatched to patch it. ONLY when: (a) the diagnosis is structured enough to
   write a prompt, (b) a guard/test exists or can be generated to verify the
   patch, (c) the change is reversible (branch + PR, never direct-to-prod).
   The closed-loop `remote-vibe-loop` proved a runner CAN edit→verify a repo
   over the relay — that is the substrate for auto-fix.

## Session incidents × layers × auto-fix

| # | Failure (this session) | Detect | Signal | UI | Route-to-fix | Auto-fix by remote runner? |
|---|---|---|---|---|---|---|
| 1 | **mac mini fork exhaustion, silent 3h death** | spawn-capability warden (`/usr/bin/true`) — BUILT this session (`resource_warden.go`) | `resourcePressure` on heartbeat (BUILT) + `flightKindDegraded` | "⚠ Starving" chip (BUILT, web) | dead-man reboot / provider reset / smart-plug (§4 ladder) | **No** — infra, not code. Deterministic: `machine_repair provider_reset`. |
| 2 | **ubuntu OOM death-spiral** | RAM in resource warden + `journalctl -k oom` doctor probe (TODO) | heartbeat `availableMb`/`oomKillsSinceBoot` (partial) | starving chip | swap + OOMScoreAdjust (applied on-box); ship in unit files (TODO) | **No** — infra. |
| 3 | **Transport "pending" desync (sim)** | connectionMode null while presence green | pill label | FIXED — pill shows real path | decouple send from QUIC (FIXED) | **Maybe** — pattern is greppable; a runner could sweep other `connMode`-gated UI. |
| 4 | **Composer freeze on round-trip** | control disabled across await | none (silent spinner) | FIXED — fire-and-forget | fire-and-forget pattern | **Yes, ideal** — the pattern (`disabled={busy}` + `await` + finally) is mechanically detectable; a runner can apply the `handleFollowUp` template to `handleCreateTask` and the ~30 Tier-2 screens, each with a Maestro/parity test. |
| 5 | **~300 untimed `fetch()` hang the UI** | grep `await fetch(` w/o timeout | none | frozen control | FIXED (12s floor) — CI lint to ban raw fetch (TODO) | **Yes** — a runner + a lint rule fixes any regression automatically. |
| 6 | **tvOS `VibeTurnPanel` — stale gitignored xcodeproj** | build error `cannot find X in scope` | build log | red build | FIXED (always xcodegen); the CLASS = any gitignored generated project | **Yes** — a runner sees the compile error, greps the missing symbol's file, adds it to the project spec, rebuilds. Deterministic-ish. |
| 7 | **Browser-lane feedback occlusion (iOS)** | no shake overlay appears | none | FIXED — DOM icon in WebView | inject lane-aware SDK | **Partly** — SDK code fix landed; a runner could port to other guest apps. |
| 8 | **Relay cross-tenant (C1/C2/C3)** | no probe — found by audit | none | none | FIXED in relay code | **No** — security-critical, human review mandatory. |
| 9 | **Convex DB-wipe / bill amplifiers** | no probe — found by audit | none | none | FIXED (internalMutation, rate limiter) | **Partly** — a CI lint (public mutation taking userId/tokenHash w/o session check) is the auto-guard; runner can add it. |
| 10 | **CUPS internet-exposed on boxes** | port scan of own box | none | none | disable snap (applied) | **Yes** — a doctor probe + a runner/ops verb that closes known-bad ports. |
| 11 | **iOS CI dev-profile UDID wall** | CI archive error | CI log | red CI | switch to App Store distribution profile (TODO) | **Maybe** — a runner can rewrite the signing config; needs the profile secret. |
| 12 | **Flutter-web no lane-awareness** | no shake response | none | FIXED — dart:html listener | SDK fix | **Yes** — cross-SDK parity is a mechanical port a runner can do. |

## Where failure plumbing is MISSING across the product (the backlog)

Grouped by surface, each needs the 4 layers; ★ = a remote-runner auto-fix is realistic.

- **Mobile RN (shared quic.ts / all RN surfaces):**
  - ★ Every `disabled={busy}`+`await` control → fire-and-forget (audit found ~30). Detectable by lint; fixable by runner with a Maestro test per screen.
  - Screen-level raw `fetch()` outside quic.ts (mail/files/box-monitor…) → timeouts. ★ mechanical.
  - Undismissable modals → Dismiss never gated (fixed one; ★ sweep the rest).
  - No **spinner max-duration** primitive: every `loading` state should auto-exit to an error after N s. Build one hook, ★ apply everywhere.
- **Agent (Go):** resource warden RAM leg + `doctor_oom_history` + spawn shed order; the §3 spawn-constructor class fix (WaitDelay+procgroup across ~1000 sites) — ★ a runner can adopt the shared helper mechanically.
- **Native surfaces (tvOS/watchOS/Wear):** own network code — NO timeout floor, NO fire-and-forget. Each needs its own pass; ★ a runner fluent in Swift/Kotlin can port the pattern.
- **Relay:** C4 auto-subdomain overwrite, H1 relay-bridged-as-loopback, H2 sig doesn't cover query — human-reviewed (NOT auto-fix).
- **Convex:** the CI lint (§9) is the durable auto-guard; ★ runner writes it.
- **Cross-surface:** custodian findings, playbook remedies, incidents render **web-only** today — port to mobile/tvOS/watch/car/glass (the parity gap named in CLAUDE.md). ★ largely mechanical.

## The remote-runner auto-fix loop (proposed)

Substrate exists: `remote-vibe-loop` proved runner-edits-repo-over-relay works.
A **custodian → runner** escalation:
1. A warden/doctor emits a structured finding with a stable reason code + the
   file:line/class (not prose).
2. The custodian decides route: deterministic fixer → run it; else if the
   finding is a code class with a generatable test → dispatch a runner on a
   HEALTHY box (never the failing one) with: the diagnosis, the file, and
   "write the fix + a guard test; prove the guard by breaking it."
3. The runner works on a BRANCH, opens a PR — never direct-to-prod. A human
   (or a second adversarial runner) reviews before merge.
4. Security-critical classes (relay auth, Convex access-graph, signing) are
   **allowlisted OUT** of auto-fix — human only.

Guardrails: reversible (branch/PR), verified (guard test proven by breaking),
bounded (one class per run, token cap), and scoped (never security auth). This
turns the doctrine's "escalate to a coding agent only when there is no
deterministic fixer" into a running system.
