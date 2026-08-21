# Relay Pro — 100-User Launch Readiness Assessment (2026-08-10)

Status: headless readiness assessment against PRODUCTION
(`https://perceptive-minnow-557.eu-west-1.convex.site`) + code audit of `main`
@ `473654482`. Owner asked: **"if 100 users want to buy Yaver Relay Pro, are we
ready?"** — answered here by probing every gate the money-touching path crosses,
zero provider spend. Code is the source of truth; every claim was verified by a
live probe or a file read on 2026-08-10.

---

## 0. TL;DR — NOT READY TO SELL, READY TO TEST

| Gate | Verdict | Evidence |
|---|---|---|
| Relay Pro checkout (LS variant) | ❌ **BLOCKED** | `POST /billing/checkout {"productId":"relay-pro"}` → **503** `Relay Pro checkout is not configured (set LEMONSQUEEZY_YAVER_RELAY_PRO_VARIANT_ID)` |
| Cloud checkout | ⚠️ sandbox only | `POST /billing/checkout {"productId":"cloud-workspace"}` → real URL, `"mode":"sandbox"` |
| Webhook state machine | ✅ done | all LS lifecycle events handled (`http.ts:6091-6391`) |
| Entitlement gate | ✅ done + live-proven | `canProvisionManaged` fail-closed; live dev-relay provision → active → shared pool |
| Shared pool economics | ⚠️ workable, needs cap | 20 tenants/host × 20GB/day paid = 400GB/day vs ~666GB/day Hetzner allowance |
| Cost-control crons | ❌ single point of failure | meter/idle/orphan/reconcile all on ONE Hetzner timer box; no alarm consumer |
| Owner-only gating | ✅ live | `cloudPreviewOwner:true` for owner; fail-closed for everyone else |
| Orphan sweep | ✅ clean right now | `reconcileProviderResources` dryRun: `known:21, seen:2, orphans:[]` |

**Bottom line:** 100 buyers **cannot complete a purchase today** — the Relay Pro
LemonSqueezy variant is not configured in production. The moment it is, the
activation path is proven to work, but **two structural risks** remain for a
100-tenant fleet: (1) cost-control crons depend on one self-hosted timer box,
and (2) bandwidth economics are tight at 20 tenants/host with no hard per-tenant
cap tied to billing.

---

## 1. The buy path — gate by gate

### 1.1 Checkout → LemonSqueezy

`POST /billing/checkout` (`http.ts:6400`) authenticates the user, resolves
`productId` server-side (client can only say `relay-pro` / `cloud-workspace`),
then maps to a variant via `variantForBillingProduct` (`http.ts:516`):

```
relay-pro       → LEMONSQUEEZY_YAVER_RELAY_PRO_VARIANT_ID
                → LEMONSQUEEZY_MANAGED_RELAY_VARIANT_ID (alias)
                → LEMONSQUEEZY_YAVER_RELAY_VARIANT_ID (alias)
cloud-workspace → LEMONSQUEEZY_YAVER_CLOUD_WORKSPACE_VARIANT_ID (etc.)
```

**Live probe (owner session):**

```
POST /billing/checkout {"productId":"relay-pro"}
→ 503 {"error":"Relay Pro checkout is not configured (set LEMONSQUEEZY_YAVER_RELAY_PRO_VARIANT_ID)"}
```

The Relay Pro variant env is **unset in production**. Cloud Workspace returns a
checkout URL in **sandbox mode** (`"mode":"sandbox"`), so even a Cloud purchase
would be a test payment. **No real money can move today.** This is gate #1 and
it is closed. The fix is owner-side env config (deliberately not done by me —
setting billing env is owner-approval-only, and the owner said no payment wiring
yet).

### 1.2 Webhook → local subscription

Signed HMAC-SHA256 (`http.ts:6047`), fail-closed when secret unset. All events
converge (verified in the 2026-08-10 re-audit of
`docs/launch-post-audit-findings.md`): created/updated/resumed/unpaused/
plan_changed/payment_success/paused/payment_failed/cancelled/expired/refunded.
Idempotent upsert. **Ready.**

### 1.3 Entitlement + provisioning

`canProvisionManaged` (`subscriptions.ts:122`) — active sub OR owner allowlist.
Live-proven this session: owner dev-relay → provision → shared-pool assignment
(`relay-eu-0`) → active with real server/IP → health-check path → deprovision
with drain logic. **Ready.**

### 1.4 Relay Pro value delivery

`wireUserRelayUrl` points the user's devices at their managed relay; per-user
password validates on any Yaver relay; free relays stay as fallbacks. Verified
in `docs/audits/relay-pro-crypto-onboarding-audit-2026-08-10.md`. **Ready.**

---

## 2. Shared-pool economics at 100 tenants

Pool policy: 20 tenants per shared host (`relayPoolPolicy.ts`), first-fit
packing, box created once per host, deleted only when drained (committed
`473654482`).

- **Hosts needed:** 100 / 20 = **5 shared hosts** (EU) + a few for US.
- **Bandwidth worst case:** paid tier = 20GB/day/device (`relay/bandwidth.go`,
  `PaidDeviceLimitMB: 20000`). 20 tenants × 20GB = **400GB/day per host**.
  Hetzner included traffic for these boxes is roughly **20TB/month ≈ 666GB/day**.
  At full simultaneous saturation the host exceeds its allowance → overage fees
  or throttling. Real usage is a small fraction, but **there is no hard
  enforcement tying the Convex side to the relay's per-device cap** — the relay
  enforces `PaidDeviceLimitMB` itself, which is the safety net, but the margin
  is ~40% under worst-case saturation.
- **CPU/RAM:** 1 vCPU / 2GB is ample for pass-through (bandwidth is the scarce
  resource — same conclusion as `relayPool.ts` header).
- **Cost per tenant:** ~€0.35/user/month at 20/host vs €6.99 dedicated — the
  pool is what makes $9/mo Relay Pro viable. **Keep it.**

**Recommendation:** before public sale, add a Convex-side per-user bandwidth
ledger that the relay's cap can be reconciled against (or at minimum expose the
relay's `/authmix` + per-device usage in the ops dashboard), and set
`RELAY_TENANTS_PER_HOST` via env rather than the compiled default when the
fleet grows. Not a launch blocker at 100 users; a margin-safety item.

---

## 3. Cost-control crons — the structural risk

| Job | Trigger | Live? | Dry-run? |
|---|---|---|---|
| `cloudMeter` | Hetzner systemd timer → `/crons/run` | `YAVER_CLOUD_METER_LIVE` gates | dryRun default |
| `cloudIdleSweep` | Hetzner timer | LIVE (`dryRun:false`) | — |
| `cloudOrphanSweep` | Hetzner timer | report-only | `dryRun:true` |
| `reconcileManagedSubscriptions` | Hetzner timer | yes (idempotent) | — |
| `trialReaper` | Hetzner timer | LIVE | — |
| `cloudEgressIpSweep` | Hetzner timer | gated | — |

All six hang off **one self-hosted Hetzner box** (`http.ts:10280-10400`,
`crons.ts` is comment-only — no Convex built-in crons). `cronHealth` /
`recordCronTick` exist (`cloudLifecycle.ts:2931,2961`) and `/crons/run`
records a tick after dispatch, so a dead timer host IS detectable — but
**nothing consumes cronHealth as an alarm**. The plan's Task 9 (dual
independent trigger + missed-heartbeat alert) is **not done**.

**At 100 paying users this matters:** if the timer box dies, the idle sweep
stops → idle boxes keep billing Hetzner; the orphan sweep stops → leaked
resources stay invisible; reconciliation stops → "paid but no relay" goes
unfixed. The cost-control system's own availability is the same shape as the
2026-08-01 relay-key incident (one box, silent failure).

**Recommendation (pre-public-sale):**
1. Move the four critical jobs to **Convex built-in crons** (`crons.ts`) OR
   add a **second independent trigger** (e.g. a second box / GitHub Actions
   scheduled workflow / external uptime service hitting `/crons/run`).
2. Add a **missed-tick alarm consumer**: a job that checks
   `cronHealth.lastTick` for each name and alerts (email/push/webhook) when
   older than ~2 intervals.
3. Keep `cloudOrphanSweep` report-only but **schedule a human-visible report**
   (the ops dashboard gap — plan Task 10).

---

## 4. Owner-only + credential safety — verified live

- `/subscription` owner session → `cloudPreviewOwner:true`, `cloudAccess:true`
  (the owner identity is configured through the production env allowlist).
- `/relay/validate` bogus password → `401 {"ok":false,"reason":"bad_password"}`;
  missing password → 400. Fail-closed.
- `/subscription` returns relay status/domain/region/ports — **never
  `relay.password`**.
- Full credential-leak checklist in
  `docs/audits/relay-pro-crypto-onboarding-audit-2026-08-10.md` §8.

---

## 5. What must happen before the first REAL purchase

In order:

1. **Owner sets `LEMONSQUEEZY_YAVER_RELAY_PRO_VARIANT_ID`** in Convex prod
   (sandbox store first). — owner action, not code.
2. **Owner flips `LEMONSQUEEZY_SANDBOX=false`** only when ready for real money.
   Until then checkout stays sandbox. — owner action.
3. **One owner-controlled real purchase** (plan §19 Phase-7 acceptance):
   fresh test identity → checkout → signed webhook → subscription active →
   relay provisioned → devices wired → portal → cancel → period-end behavior.
   Proven manually; not automated (the LS hosted checkout page is third-party).
4. **Land LS reconciliation** (plan Phase 2 / Task 3): periodic sweep of local
   active-ish subs against the LS API, drift detection + repair, provider-failure-
   safe. Currently only manual `/billing/yaver-cloud/reconcile`.
5. **De-risk crons** (plan Phase 6 / Task 9): second trigger + missed-tick
   alarm, or Convex built-in crons.
6. **Optional margin-safety:** per-user bandwidth ledger visibility; env-config
   `RELAY_TENANTS_PER_HOST`.

What is NOT needed before sale (already done + verified): webhook state
machine, entitlement gate, shared pool, provision/deprovision drain, per-device
signature auth, relay SPKI pinning + self-heal, owner gating.

---

## 6. Verification log (2026-08-10)

```bash
# Live probes (owner session token, zero provider spend)
POST /billing/checkout relay-pro          → 503 (variant unset)  ← the blocker
POST /billing/checkout cloud-workspace    → URL, mode=sandbox
GET  /subscription                         → cloudPreviewOwner:true, relay {status,domain,ports}
POST /relay/validate bogus pw             → 401 bad_password
POST /relay/validate {}                   → 400
convex run relayPool:hostCountsForRegion  → {"relay-eu-0":1} → after drain {}
convex run cloudLifecycle:reconcileProviderResources {dryRun:true} → orphans:[], seen:2, known:21

# Code gates
cd backend && npx convex codegen          → typecheck PASS
cd backend && node --experimental-strip-types --test \
  convex/accessSigPolicy.test.mts convex/billingWebhook.test.mts \
  convex/relayPoolPolicy.test.mts convex/wakeOnRequestPolicy.test.mts → 43/43 PASS
cd relay && go test ./...                 → PASS
```
