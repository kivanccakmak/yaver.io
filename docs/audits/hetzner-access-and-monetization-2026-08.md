# Hetzner access & monetization deep audit — 2026-08-11

Status: owner decisions locked in-session (see §0). This file is the audit
record; the decisions it records are the source of truth for the removal work
in P1–P5 below.

---

## 0. Decisions locked this session

1. **No hcloud binary, no hcloud SDK, anywhere in production.** The Convex
   control plane is the only Hetzner caller, via plain REST (`fetch` to
   `api.hetzner.cloud/v1`) with `HCLOUD_TOKEN` from Convex env. The `hcloud`
   CLI is removed from the shipped agent entirely (was: `yaver launch hetzner`).
2. **No user-driven Hetzner deployment — full removal.** Clients never hold a
   Hetzner token and never provision Hetzner. Removed: mobile phone-direct
   Hetzner client (`mobile/src/lib/hcloud.ts`), Go-agent `RemoteManager`
   Hetzner path (`HETZNER_API_TOKEN`), `yaver launch hetzner`, legacy
   `provision-managed-relay.sh` / `deprovision-managed-relay.sh`.
3. **Yaver owns the provider account and monetizes it.** Relay Pro and Cloud
   Workspace are Yaver's own Hetzner boxes, provisioned server-side behind
   entitlement/quota, billed fail-closed.
4. **Non-monetized path = manual install / self-host only.** A user can
   `npm install -g yaver-cli`, run their own machines, self-host their own
   relay, use Tailscale/mesh. No automated cloud provisioning for them.
5. **Pricing model locked = Model A.** Cloud Workspace **$29/mo BYOK**
   (120 standard-hours, wallet overage, scale-to-zero park) is the single
   compute plan. Relay Pro stays **$9/mo pooled**. `cloud-agent` (managed
   model) is legacy / never-ship at $19 — it fails the 70% margin floor at
   full usage (see §4).
6. **Serverless (hosted backend) is NOT shippable until microVM isolation.**
   Placement-ready ≠ runtime-ready; do not sell shared backends until
   `desktop/agent/serverless_isolation.go` reports ready for untrusted code.

---

## 1. Security audit — Hetzner access surfaces

### 1.1 Inventory (as of 2026-08-11)

| Surface | Mechanism | Token | Reachable by |
|---|---|---|---|
| Convex control plane (`cloudMachines.ts` provision/destroy/quota, `provisionRelay.ts`, `cloudLifecycle.ts` wake/park/resize/purge/recreate, `cloudProviders/hetzner.ts` facade) | Pure REST `fetch` | `process.env.HCLOUD_TOKEN` (Convex env) | Server-side functions only, per-user gated |
| `desktop/agent/remote.go` `RemoteManager` (MCP `remote_provision`/`remote_destroy`/`remote_snapshot`/`remote_cost`) | Pure REST via `hetznerAPI()` | `HETZNER_API_TOKEN` on the box running the agent | **REMOVED (P1)** — was BYO |
| `desktop/agent/launch_hetzner.go` + `launch_auto.go` (`yaver launch hetzner`) | Shells out to `hcloud` binary on PATH | `HCLOUD_TOKEN` env | **REMOVED (P1)** — was operator dev tool |
| `mobile/src/lib/hcloud.ts` + `HetznerSection.tsx` + `byoProvision.ts` | REST, phone-direct | User's own token in SecureStore, never transits Convex | **REMOVED (P1)** — was BYO |
| `scripts/provision-managed-relay.sh`, `scripts/deprovision-*.sh` | curl REST + inline SSH/Docker | Operator shell / CI secrets | **REMOVED (P1)** — legacy duplicate of `provisionRelay.ts` |
| `ci/hcloud/*.sh` + GitHub workflows | `hcloud` binary on CI runner | `HCLOUD_TEST_*` / `HCLOUD_SSH_PRIVATE_KEY` CI secrets | Operator CI only — KEPT |
| hcloud Go SDK | — | — | Never vendored (`desktop/agent/go.mod` clean) |

### 1.2 Multi-tenant posture that must not be eroded

- **The multi-tenant boundary lives in Convex, not the provider.** Every
  client-visible operation is a server function: auth → ownership
  (`machine.userId === session.userId` or owner allowlist) → entitlement
  (`subscriptions.canProvisionManaged`, fail-closed) → quota
  (`managedMachineLimit`, owner-exempt) → server-side placement
  (`selectComputeProvider()`, user cannot influence provider/SKU) → then the
  Hetzner call. See `cloudMachines.ts:2274`, `provisionRelay.ts:237`.
- **Relay Pro shared host:** pass-through only (forwards ciphertext, holds no
  keys, executes no tenant code). Shared hosts run **no** `RELAY_PASSWORD`;
  per-user auth only, relay validates each connection against Convex
  `POST /relay/validate` → `userSettings.validateRelayPassword` which
  requires `passwordOwner.userId === deviceOwner.userId` and distinguishes
  `bad_password` / `dead_token` / `device_mismatch` (`userSettings.ts:1492`,
  `relay/server.go:730`). Per-host random `RELAY_ADMIN_TOKEN` gates `/admin/*`
  and `/tunnels`.
- **Pool placement is server-side and deterministic** (first-fit, not
  least-loaded) so hosts drain and die; user cannot influence which box they
  land on (`relayPoolPolicy.selectRelayHostSlot`).
- **Deprovision safety:** a shared host is deleted only when drained
  (`sharedHostDeletionDecision`); DNS for the departing tenant is always
  cleaned. Grace snapshots only for dedicated relays
  (`sharedHostGraceSnapshotDecision`).
- **Tenant-aware SSH:** Yaver's operator root key
  (`MANAGED_CLOUD_SSH_PUBKEY`, Convex env) is attached **only** to owner
  boxes; customer boxes carry the customer's own key, never ours.
- **Machine auth token:** random 24-byte; only SHA-256 hash persisted
  (`machineTokenHash`); plaintext exists only in `/etc/yaver/machine.json`
  via cloud-init.
- **Fail-closed by construction:** no `HCLOUD_TOKEN` ⇒ dry-run; nothing is
  created or deleted. A leaked *access* cannot spend money either.

### 1.3 Token hygiene (the "token must never leak" requirement)

- `HCLOUD_TOKEN` lives in exactly: Convex env (`npx convex env set --prod`),
  CI secrets (`HETZNER_TEST_SNAPSHOT_ID`, `HCLOUD_SSH_PRIVATE_KEY`, etc.),
  and the operator's local shell. Never in git, never in cloud-init user-data,
  never in client-readable fields, never on a client box.
- The one client-visible leak surface found: raw provider error bodies
  (`Hetzner API error ${status}: ${errText}`) written into
  `cloudMachines.errorMessage` / `managedRelays.errorMessage`
  (`provisionRelay.ts:365`). Hetzner does not echo the Authorization header,
  so this is not a token leak today — but it forwards internals to clients and
  is fixed in P2 (structured reason codes only).

### 1.4 Security gaps found (all addressed in P2/P3)

1. **Raw provider error text → client-facing fields.** Map to reason codes.
2. **No 429/rate-limit handling** in hand-rolled REST paths.
3. **No spend audit trail** — nothing logs `userId + action + machineId/
   relayId + serverId` per Hetzner mutation.
4. **Env-name drift:** `HCLOUD_TOKEN` (Convex) vs `HETZNER_API_TOKEN`
   (Go agent) — same provider, two names. Unify to `HCLOUD_TOKEN`.
5. **Token rotation undocumented** — long-lived token in two stores.
6. **Divergent SKU ladders** — see §3.

---

## 2. Monetization audit — what the code actually charges

### 2.1 The unit-economics guard (owner directive, in code)

`unitEconomics.ts` encodes **"no business at 16% gross"** as a preflight:
`MIN_GROSS_MARGIN = 0.70`, `TARGET = 0.80`. The failure class it exists to
catch is **always-on cost**, and the codebase already applied the fix
(pooling) to both products:

| Product | Dedicated | Pooled | Code ref |
|---|---|---|---|
| Relay Pro ($9/mo) | cax11 €6.99/mo always-on → **16% gross** | 20 tenants/host → €0.35/user → **~96%** | `relayPoolPolicy.ts:15` |
| Cloud Workspace ($29/mo BYOK) | parks (snapshot+delete+volume) → viable at markup | — | `unitEconomics.assessViability` |
| Serverless backend (hosted) | cpx22 €22.99/mo always-on → **14% gross** | 10 tenants/host → €1.15/user → **~86%** | `serverlessPool.ts:12` |

### 2.2 Cost model (integer cents, `chargedCents = providerCost × markup`)

- Markups (`cloudLifecycle.ts:42`, `managedMeter.ts:32`): standard 2×, heavy
  2.3×, build 2.5×, cpu 2×, gpu 3×; inference 1.5×, backend 2×, web 2×,
  publish 1.3×, ci 2×, studio 1.6×.
- Base SKU: `cpx51` €54.90/mo (16 vCPU/32 GB/360 GB) ≈ 7.5c/h live, ~0c/h
  stopped. Class ladder: standard cpx22 (€0.0368/h), heavy cpx32 (€0.0673/h),
  build cpx42 (€0.1314/h) — credit weights validated against measured prices
  2026-07-21, charged rounded UP (`cloudPlacementCapacity.ts:24-31`).
- Included: **120 standard-credits/period** — `$29 (≈€26.7) buys 120 h on the
  default class`. Burn-rate derived from real prices, never hardcoded
  (`unitEconomics.burnRateForHourly`). UI must show wall-clock hours, not
  standard-hours (`allowanceView` — double-scaling is the classic bug).
- Floor costs scale-to-zero cannot remove: volume €0.044/GB/mo + reserved
  egress IP €1.20/mo + snapshot storage (~€0.80/mo) ≈ **€2.44/mo parked**.
- Inference (hosted/cloud-agent, legacy): per-user OpenRouter key with limit
  pinned to the **COGS budget** (retail wallet ÷ 1.5× markup → max ~$5.33 of
  Yaver's money per month) — `openrouterKeys.ts:10`.
- Fail-closed launch posture: everything `dryRun` until
  `YAVER_MANAGED_METER_LIVE` + per-user capability opt-in
  (`managedMeter.userOptedIntoKind`).

### 2.3 Price-model audit vs the 70% floor (why Model A won)

Worst-case = full burn of grant + wallet monthly; realistic ≈ 10 active hours
+ parked floor. `€≈$` per `cloudLifecycle.ts:64`.

| Model | Revenue | Included compute | Max COGS | Margin worst-case | Margin realistic | Floor |
|---|---|---|---|---|---|---|
| **A — Cloud Workspace $29 BYOK** (locked) | $29 | 120 std-hrs (€2.40) | €2.40 + €0.75 overage + €2.44 parked = €5.59 | **79%** ✓ | **91%** ✓ | PASSES |
| B — Cloud Agent $19 (managed model) | $19 | 40 hrs (€0.80) | €0.80 + €5.33 inference + €2.44 = €8.57 | **55%** ✗ | ~70% | FAILS at full usage |
| B — Cloud Workspace $9 BYOK | $9 | 40 hrs (€0.80) | €0.80 + €0.75 + €2.44 = €3.99 | **56%** ✗ | **62%** ✗ | FAILS |

Why Model A is the only one that passes: $29 is the minimum price that clears
the 70% floor with a 120h grant + parked floor. `$19` fails because the AI
wallet is 42% of revenue (would need ≥3.25× inference markup + token meter —
a rebuild, not a tweak). `$9` cannot carry any always-on component (parked
floor alone is 27% of revenue). `plans.ts:6-9` already treats
`cloud-agent`/`hosted` as legacy aliases.

---

## 3. Drift & gap inventory

1. **Two divergent SKU ladders (live bug).** `desktop/agent/remote.go:508`
   provisioned `cx22/cx32/cx42` on `ubuntu-22.04`; `cloudMachines.ts:57`
   marked `cx32/cx42` **deprecated** (422 "server type is deprecated",
   2026-08-10). The Go-agent path would 422 today. P1 removes the path; P3
   pins the surviving ladder with a parity test.
2. **Legacy `scripts/provision-managed-relay.sh`** duplicates
   `provisionRelay.ts` with the OLD auth model (single shared `RELAY_PASSWORD`
   per box, hardcoded `cax11`, inline SSH+Docker+certbot). If anything still
   calls it, it reintroduces the shared-host auth hole. P1 retires it.
3. **Serverless isolation not ready.** `serverlessPool.ts:19-44` + provision
   warn: a shared serverless host runs tenant functions; shared-kernel
   containers are not enough — microVM (Firecracker) or equivalent required
   before third-party production traffic. **Do not sell shared backends yet.**
4. **GPU price is a placeholder** (€199/mo, `cloudLifecycle.ts:67`) — not
   verified orderable. Same failure class as the 2026-07-21 `cx32` incident.
5. **No pricing page** on the web surface (`web/app/pricing` absent) — P4.
6. **Three price points existed in repo** — resolved to Model A (§0.5).

---

## 4. What's missing / what should exist (monetization, technical)

Already exists (keep):
- 70% margin floor preflight in code (`unitEconomics.ts`) ✓
- Pool placement (relay 20, serverless 10) with first-fit packing + drain ✓
- Fail-closed billing gates (`canProvisionManaged`, quota, signed webhook) ✓
- Per-user relay auth via Convex validation ✓
- Burn-rate / standard-hour accounting + wall-clock honesty (`allowanceView`) ✓
- COGS-pinned per-user inference keys ✓
- Idle sleep 15 min / delete 2 h (`providerCatalog.ts:319`) ✓
- Orphan reconciliation via label inventory (`listYaverTaggedResources`) ✓
- Per-capability burn breakdown for the cockpit (`managedServices.ts`) ✓
- Daily/hourly/request inference caps (hosted tier) ✓
- Monthly wallet top-up idempotent per (subscription, period) ✓

Missing / should-have (P2–P5):
1. **Shared Hetzner HTTP client** — retry + 429 retry-after backoff +
   structured error mapping + optional audit. All ~8 call sites currently
   hand-roll `fetch`.
2. **Spend audit trail** — `{userId, action, resourceId, serverId, costClass,
   at}` on every provider mutation (create/delete/snapshot/wake/park/resize).
   Today nothing logs who triggered what Hetzner spend.
3. **Reason-code mapping for provider failures** — no raw provider bodies in
   client-facing `errorMessage` (aligns with the failure-plumbing doctrine).
4. **Token rotation runbook** for `HCLOUD_TOKEN` (Convex env) + CI secrets.
5. **SKU parity test** — one ladder, test-pinned.
6. **Serverless isolation gate** — hard gate on
   `serverless_isolation.go` readiness before any hosted-backend provisioning.
7. **Verified GPU SKU + price** or no GPU checkout at all.
8. **Pricing page** — one primary CTA (Cloud Workspace $29), secondary (Relay
   Pro $9), free/self-host path clearly separate; copy per `monetization.md`
   (no "GPU/Hetzner/VM/tokens" language on the normie path).
9. **Idle auto-stop UX** — 25-min warning, 30-min stop, "never stop during
   build/task/git" tests (monetization.md Phase 4 — partially implemented).
10. **Relay bandwidth metering per tenant** — the pool's scarce resource is
    bandwidth (~20 TB/mo allowance); `relay/bandwidth.go` exists but no
    per-tenant metering/limit wired to billing. Before oversubscribing past
    20/host, measure.
11. **Stripe** (monetization.md Phase 6) — currently LemonSqueezy-only; env
    placeholders + webhook + reconcile are the documented path.
12. **Wallets vs grants separation** — hosted-tier inference grant currently
    rolls over (documented P2 refinement: non-rollover inference ledger).

---

## 5. Removed surfaces checklist (P1) — verify after deletion

- [x] `mobile/src/lib/hcloud.ts`, `HetznerSection.tsx`, `byoProvision.ts`, `hcloud.test.mts` — deleted 2026-08-11, import stripped from `settings.tsx`
- [x] `desktop/agent/launch_hetzner.go`, `launch_auto.go` hetzner branch, `launch_cmd.go` provider list/dispatch — deleted 2026-08-11 (`go build` ✓)
- [x] `desktop/agent/remote.go` RemoteManager Hetzner/DO provisioning — made manual-only 2026-08-11 (`go build` + `go vet` ✓)
- [x] `scripts/provision-managed-relay.sh`, `scripts/deprovision-managed-relay.sh` — deleted 2026-08-11
- [ ] `desktop/agent/cloud_byo_provision.go` + `cloud_deploy.go` `HETZNER_API_TOKEN` path + `cloud_stopstart.go` decision — **REMAINS** (entangled with agent_mesh/console_machines/machine_lifecycle)
- [ ] Blog/docs that teach `hcloud server create` / `yaver launch hetzner` (`web/app/blog/yaver-cloud-launch-anywhere`, `yaver-cloud-image`, `cloud/README.md`, `cloud-image/README.md`) — **REMAINS**
- [x] `grep -rn "hcloud\|HETZNER_API_TOKEN" desktop/ backend/ mobile/ web/` — remaining hits are: Convex env name + CI + this doc + the not-yet-removed cloud_*.go files (R1)

## 6. Supported user paths after removal

- **Self-host (free):** `npm install -g yaver-cli` on your own machines,
  `yaver auth`, pair the mobile app; own relay or Tailscale/mesh for
  connectivity; no cloud provisioning.
- **Monetized (Yaver-owned Hetzner):**
  - **Relay Pro $9/mo** — pooled shared host, per-user Convex auth.
  - **Cloud Workspace $29/mo BYOK** — 120 standard-hours, wallet overage,
    scale-to-zero park, private relay sidecar on the box.
  - **(future) Serverless** — gated on microVM isolation.
- **BYO cloud tokens are not a product.** Users do not bring Hetzner/AWS
  credentials to Yaver; they bring runners (Claude Code/Codex/OpenCode).
