# Yaver Billing & Cloud Workspace Provider Audit — LemonSqueezy + Hetzner Capacity

Date: 2026-08-09
Scope: read-only deep audit of the Lemon Squeezy payment wiring for Relay Pro / Cloud
Workspace, and the Hetzner dependency failure mode ("paid, but no machine"). Per
`AGENTS.md`, code is the source of truth; every claim cites `file:line`.

**Status: audit only. No code was changed.**

## TL;DR

1. **The LS payment chain is built and mostly correct** (signed webhook, product→variant
   checkout, entitlements, cancel, portal, plan change, MCP buyer tools). It is **not
   launched**: `HIDE_PAID_UI=true`, `YAVER_CLOUD_PUBLIC` unset (owner-only), checkout
   defaults to sandbox.
2. **Five LS webhook events silently no-op** — most damaging: `subscription_paused` leaves
   the box running + entitlements active after billing stops (**cost leak**).
3. **No subscription↔LS reconciliation** — a missed webhook wedges billing state until
   someone notices.
4. **Hetzner capacity is the real "no machine at all" bug.** The *wake/resume* path
   substitutes SKUs and falls back across locations; the *provision* path does neither.
   Checkout takes money before anyone asks Hetzner if the box is orderable, and
   `reconcileSubscriptions` re-fires the same sold-out SKU forever.
5. **Hetzner's delete+volume park is already the cheapest scale-to-zero**; switching
   providers for cost is the wrong fix. If sub-second resume is the goal, **Fly.io**
   (true suspend, $0 compute while suspended, per-second billing) is the best fit; AWS
   EC2 stop is runner-up. The AWS/GCP/Azure facades are `productionEligible:false` and
   buggy — don't trust them.

---

## 1. Lemon Squeezy wiring

### 1.1 Working end-to-end

| Piece | Location |
|---|---|
| Webhook `POST /webhooks/lemonsqueezy`, HMAC-SHA256, fail-closed | `backend/convex/http.ts:5992` |
| Checkout `POST /billing/checkout` (product→variant, custom_data, sandbox default) | `http.ts:6250` |
| Status `GET /billing/status` | `http.ts:6711` |
| Customer portal `GET /billing/portal` | `http.ts:6755` |
| Cancel `POST /billing/cancel` (Convex row + LS DELETE + teardown) | `http.ts:6795` |
| Plan change `POST /billing/yaver-cloud/change-plan` → LS variant PATCH first | `http.ts:6875` → `plans.ts:229` |
| Entitlements (included hours / gateway / wallet, idempotent per period) | `plans.ts:117` |
| Subscription rows + fail-closed gates (`isActive`, `canProvisionManaged`) | `subscriptions.ts` |
| Web UI (plan cards, subscribe, pause/resume/delete, manage) | `web/components/dashboard/ManagedCloudPanel.tsx`, `BillingView.tsx` |
| MCP buyer tools (`yaver_billing_status/checkout/manage`) | `desktop/agent/mcp_billing.go` |
| MCP seller tools + Go LS manager | `desktop/agent/lemonsqueezy.go` |
| Signature parity test (Go ⇄ Convex) | `desktop/agent/lemonsqueezy_test.go` |

### 1.2 Gaps (what's missing / broken)

**G1 — Unhandled webhook events (silent no-ops).** The switch at `http.ts:6036` handles
`subscription_created/updated/resumed`, `cancelled/expired`, `payment_failed`, legacy
`order_created` (warn-only). **No** `subscription_paused`, `subscription_unpaused`,
`subscription_plan_changed`, `subscription_payment_success`, or `order_refunded`. Each
falls through and returns `{ok:true}`:

- `subscription_paused`: LS stops billing, Convex row stays `active`, box keeps running,
  entitlements keep granting. **Direct cost leak.**
- `subscription_plan_changed`: variant swap in the LS portal never refreshes the Convex
  `plan` label (only `variant_name` on create/update/resume does).
- `subscription_payment_success`: renewal doesn't explicitly re-fire
  `applyPlanEntitlements`; it relies on LS also sending `subscription_updated`.

**G2 — No subscription↔LS reconciliation.** Nothing polls `/v1/subscriptions`. A missed
webhook = wrong billing state permanently. `subscriptions.markExpired`
(`subscriptions.ts:244`) only promotes local `cancelled` rows after a 7-day grace. See
`docs/serverless-companion-audit.md:75`.

**G3 — `past_due` counts as subscribed** in `/billing/status:6729`. Defensible (the box is
parked by `subscription_payment_failed`), but the green "subscribed" flag can read true
while compute is parked.

**G4 — Cancel tears down at cancel time, not period end.** `http.ts:6159` deprovisions on
both `subscription_cancelled` and `subscription_expired`. A user cancelling (effective at
period end) loses their box immediately. Documented as deliberate cost-safety; confirm
it's the product you want.

**G5 — The funnel is switched OFF.** `web/lib/launchFlags.ts:12` → `HIDE_PAID_UI = true`
(buy block not rendered); `YAVER_CLOUD_PUBLIC` unset → owner-only; checkout `mode`
defaults to `sandbox`. Nothing is publicly sellable today regardless of code.

**G6 — Variant env gaps.** `docs/yaver-open-todos.md`: the $19 hosted "Cloud Agent"
variant was never created (`LEMONSQUEEZY_YAVER_CLOUD_HOSTED_VARIANT_ID` unset → clean
503, safe but unlaunched); BYOK falls back to the single `YAVER_CLOUD_VARIANT_ID`;
`YAVER_RELAY_PRO_VARIANT_ID` unverifiable from this box.

**G7 — Gateway daily-cap backstop still structurally dead** (inherited from the
2026-07-21 audit): `managedMeter.ts` gates real spend on `userOptedIntoKind` (no writer),
`gatewayPolicy` absent-row ⇒ default-enabled. Irrelevant for the current BYOK product
(gateway off) but caps nothing if hosted ever sells.

---

## 2. Hetzner dependency — "no machine at all"

### 2.1 Root cause: capacity, not the stop/start model

- `cloudLifecycle.ts:688` — *"cx23 … SOLD OUT everywhere in the EU as of 2026-07-21 —
  cpx22 is the cheapest ORDERABLE box in this class"*.
- `cloudLifecycle.ts:975` — *"every SKU Yaver uses was sold out in all three EU
  datacenters while a dozen others were available"*; `:984` — *"Hetzner has no
  reservation product"*.

**The resume/wake path is capacity-resilient:**
`hetznerServerTypeAvailable` + `hetznerPickAvailableServerType` (cheapest sufficient
substitute within a margin ceiling) + multi-location fallback (`fsn1/nbg1/hel1`,
`ash/hil`) + auto-retry with backoff on transient `resource_unavailable`. See
`cloudLifecycle.ts:1079-1200`, `2473-2566`, `2664-2689`.

**The provision path is NOT:**
`cloudMachines.provision` (`cloudMachines.ts:2390`) calls `cloudProvider.createMachine`
with a hardcoded SKU (`cpx22/cpx32/cpx42`, `cloudLifecycle.ts:692-694`) — no
availability pre-check, no substitution, no multi-location retry. Sold-out SKU ⇒
`status:"error"`, then `reconcileSubscriptions` (`cloudMachines.ts:2837`) re-provisions
the **same SKU in the same region** ⇒ fails again.

**That is the "paid but no machine" loop: checkout succeeds → payment taken → provision
hard-fails on capacity → recovery re-fires into the same wall.**

Checkout never probes capacity first — the product sells capacity it doesn't have (the
inventory-says-yes / operation-says-no class `AGENTS.md` forbids).

### 2.2 Conflicting SKU ladders (still 3–4 sources)

| Source | Types | Region |
|---|---|---|
| `cloudLifecycle.ts:671` `hetznerServerType` | cpx22/cpx32/cpx42/cpx51/gex44 | nbg1 / ash |
| `backend/convex/cloudProviders/hetzner.ts:104` `resolveSku` | cpx22/cpx32/cpx42/gex44 | fsn1 / ash |
| `desktop/agent/cloud_capacity.go:49` (BYO) | **arm cax11/cax21/cax31** | EU-only |
| `cloudLifecycle.ts:708` `hetznerServerTypeForDisk` | cpx11…cpx51 ladder | — |

A resize/resume across engines can pick a type a snapshot can't restore onto.
(July-audit R8, partially fixed.)

### 2.3 Park is already the cheapest scale-to-zero

Hetzner bills stopped servers, so park = **delete server + keep the volume**
(€0.044/GB/mo idle). Wake from volume ≈ 1–2 min (vs. ~10 min from snapshot).
**Hetzner is not the cost problem.**

### 2.4 Provider comparison for quick start/stop + ups/downs

| Provider | True stop? | Idle cost | Resume time | Production-ready adapter today? |
|---|---|---|---|---|
| **Hetzner (current)** | No (delete+volume) | volume only (€0.044/GB/mo) | ~1–2 min (vol) / ~10 min (snap) | ✅ the only `productionEligible` one |
| **Fly.io Machines** | ✅ true suspend | **$0 compute** suspended, per-second billing | ~1–2 s | ❌ no adapter; volume+image (no snapshot); egress per-GB |
| **AWS EC2** | ✅ stop (EBS persists) | ~$0.08/GB/mo | ~1–2 min | ❌ `productionEligible:false`; serverIp bug aborts after create; EIP for stable egress |
| **GCP Compute Engine** | ✅ stop, per-second | disk persists | ~1–2 min | ❌ broken (Operation-vs-Instance), 1h OAuth tokens |
| **DO / Linode / Vultr** | ❌ stopped still bills | — | — | ❌ |
| **Scaleway** | ⚠️ reduced-rate stop | — | — | ❌ |

**Verdict:** If the goal is cost control → **stay on Hetzner and fix capacity-awareness**
(its delete+volume park already beats every stop-based model on idle cost, and resume is
already resilient). If the goal is **snappy ups/downs** → **Fly.io is the best fit**
(true suspend, $0 compute while suspended, per-second billing) but needs a new
production-eligible adapter — and `cloudLifecycle.resumeMachine` is hardcoded to raw
Hetzner fetches (`hetznerCreateFromImage`, `hetznerDeletePrimaryIp`, …), so a second
provider is a real lift. AWS EC2 stop is runner-up. Do **not** relax
`productionEligible` to enable the broken AWS/GCP/Azure facades until their July-audit
bugs are fixed and probed live.

---

## 3. Other structural risks

- **crons.ts is empty** (`backend/convex/crons.ts`) — meter, idle-sweep, orphan sweep,
  and subscription reconcile run as systemd timers on a self-hosted Hetzner box POSTing
  `/crons/run` (auth: `CRON_TRIGGER_SECRET`). If that box dies,
  metering/auto-park/reconcile stop silently; only `cronHealth`/`recordCronTick` detect
  it. Ironically the cost-control system depends on the very provider whose capacity
  failures are the complaint.
- **Good news — the 2026-07-21 audit's big items are landed**: real
  `listYaverTaggedResources`, `reconcileProviderResources` (report-only),
  `reclaimAuxResources`, stable egress IPs, server-side provider selection, fail-closed
  entitlement+quota before spend, orphan cleanup on failed provision. Don't regress
  these.
- Mobile is correctly checkout-free (store policy); `ManagedCloudCard.tsx` is
  control-only.

---

## 4. Recommended changes (in order of leverage)

1. **Make provisioning capacity-aware** — port `hetznerServerTypeAvailable` +
   `hetznerPickAvailableServerType` substitution + multi-location fallback into
   `cloudMachines.provision`; make `reconcileSubscriptions` vary SKU/location instead of
   re-firing the same one. Kills the "paid but no machine" loop with machinery that
   already exists.
2. **Pre-checkout capacity probe** — `/billing/checkout` (or `GET /billing/availability`)
   checks orderability before charging; surface "eu is out of stock, try us / retry"
   instead of taking money.
3. **Wire the missing LS events** — `subscription_paused` (park box + revoke
   entitlements), `subscription_unpaused`/`subscription_plan_changed` (re-sync plan +
   entitlements), `subscription_payment_success` (refresh allowance), `order_refunded`
   (revoke).
4. **Add LS subscription reconciliation** — poll `/v1/subscriptions` for the user's row
   (or at minimum `payment_success` handling) so a missed webhook can't wedge billing
   state.
5. **Decide the provider question explicitly** — fix Hetzner capacity (recommended;
   smallest change, cheapest idle) vs. add Fly.io as a second production-eligible
   provider for true suspend/resume. Never enable the broken facades.
6. **Flip the funnel when ready to sell** — `HIDE_PAID_UI=false`,
   `YAVER_CLOUD_PUBLIC=true`, create the hosted variant, move checkout to live, confirm
   relay-pro variant env.
7. **De-risk the cron host** — move jobs into Convex `cronJobs` or add a second timer
   host + alarm on missed `cronHealth` ticks.

---

## 5. Not verified (no access from this box)

- Actual prod Convex env values (which variants are set, sandbox vs. live,
  `HCLOUD_TOKEN` presence).
- Live LS API state / the LS store's configured products.
- Any of this exercised against a real provider account.
