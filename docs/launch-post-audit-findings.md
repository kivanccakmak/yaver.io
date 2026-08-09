# Launch Post-Audit Findings — re-audit of local HEAD (2026-08-09)

Status: re-audit of `main` @ `3f7c65890` against
`docs/architecture/lemon-squeezy-provider-audit-2026-08-09.md` and
`YAVER_POST_AUDIT_EXECUTION_PLAN_2026-08-09.md`. Code is the source of truth;
every claim below was re-verified against files on disk on 2026-08-09.

This document answers the Phase-0 questions of the execution plan: which audit
claims are still true, which have drifted, and what remains.

---

## 1. Lemon Squeezy event coverage

| Claim from audit | Verified? | Evidence |
|---|---|---|
| Webhook is HMAC-SHA256 signed, fail-closed | ✅ yes | `backend/convex/http.ts:5992-6005` |
| `subscription_created/updated/resumed` handled | ✅ yes | `http.ts:6037-6139` |
| `subscription_cancelled/expired` handled (teardown) | ✅ yes | `http.ts:6142-6184` |
| `subscription_payment_failed` handled (park + gateway off) | ✅ yes | `http.ts:6186-6232` |
| `subscription_paused` **no-op** | ✅ still missing | not in switch at `http.ts:6036` |
| `subscription_unpaused` **no-op** | ✅ still missing | not in switch (only `subscription_resumed` is handled) |
| `subscription_plan_changed` **no-op** | ✅ still missing | not in switch |
| `subscription_payment_success` **no-op** | ✅ still missing | renewal relies on LS also sending `subscription_updated` |
| `order_refunded` **no-op** | ✅ still missing | not in switch |
| Unknown events return `{ok:true}` silently | ✅ still true | default fall-through `http.ts:6242-6244` |

## 2. Billing state machine

| Claim | Verified? | Evidence |
|---|---|---|
| No subscription↔LemonSqueezy reconciliation | ✅ still absent | no polling of `/v1/subscriptions` anywhere; `subscriptions.markExpired` (`subscriptions.ts:244`) is defined but never scheduled/called |
| `past_due` counts as subscribed in `/billing/status` | ✅ still true | `http.ts:6729` `subscribed = active \|\| past_due` |
| Cancel tears down immediately, not at period end | ✅ still true | `http.ts:6159` deprovisions on both `subscription_cancelled` and `subscription_expired`; `/billing/cancel` (`http.ts:6851`) deprovisions immediately |
| Allowance grant idempotent per billing period | ⚠️ mostly | `plans.applyPlanEntitlements` (`plans.ts:117`) dedupes via `grantIncludedHours` + `topUpForOrder` orderId `sub-allowance-{sub}-{YYYY-MM}`; **no test** proves the replay invariant |
| Refund path | ❌ absent | no refund API call in Go manager or Convex |

## 3. Hetzner / Cloud Workspace

| Claim | Verified? | Evidence |
|---|---|---|
| Wake/resume is capacity-aware (substitution + fallback + margin ceiling) | ✅ yes | `cloudLifecycle.ts:1079-1200` (`hetznerPickAvailableServerType`), `:2520-2566` (wake substitution), `:2664-2689` (transient retry) |
| Initial provision is NOT capacity-aware | ✅ still true | `cloudMachines.ts:2386-2404` — `createMachine` with hardcoded `sku` and `machine.region ?? "eu"`, no availability pre-check, no fallback |
| `reconcileSubscriptions` repeats one SKU/region | ✅ still true | `cloudMachines.ts:2837-2903` → `ensureForSubscription` with `region:"eu"`, `standard` |
| Multiple SKU ladders | ✅ still true (4 sources) | `cloudLifecycle.ts:671`, `cloudProviders/hetzner.ts:104`, `desktop/agent/cloud_capacity.go:49` (BYO), `cloudLifecycle.ts:708` |
| Placement ladder abstraction exists but unused by provision | ✅ true | `cloudProviders/placementLadder.ts` (`attemptAcrossLadder`, `classifyProviderError`) is only referenced in its own file + tests |
| Pre-checkout availability endpoint | ❌ absent | no `/billing/availability` route |
| Fulfillment compensation (`fulfillment_failed`) | ❌ absent | no such state anywhere |
| AWS/GCP/Azure `productionEligible:false` | ✅ yes (keep) | `aws.ts:84`, `gcp.ts:89`, `azure.ts:94` |
| Park = delete + keep volume (cheapest idle) | ✅ yes | `cloudLifecycle.ts:760-777` |
| Orphan sweep report-only | ✅ yes | `cloudLifecycle.ts:2064` (`reconcileProviderResources`, dryRun default true) |

## 4. Cron / ops

| Claim | Verified? | Evidence |
|---|---|---|
| `crons.ts` is empty (all jobs on one self-hosted timer box) | ✅ still true | `crons.ts` is comment-only; meter/idle/orphan/reconcile run as systemd timers POSTing `/crons/run` (`http.ts:10069-10192`) |
| `cronHealth` / `recordCronTick` exist | ✅ yes | `cloudLifecycle.ts:2931,2961` |
| Second trigger / missed-tick alert | ❌ absent | no dual trigger, no alarm consumer |
| Billing/provider failure analytics events | ❌ absent | no `billing_webhook_*` / `cloud_candidate_*` / `cron_*` events |
| Operator ops dashboard | ❌ absent | no owner view for billing/cloud/cron health |

## 5. Launch flags

| Flag | Value in code |
|---|---|
| `web/lib/launchFlags.ts` `HIDE_PAID_UI` | `true` (`web/lib/launchFlags.ts:12`) |
| `YAVER_CLOUD_PUBLIC` | unset → owner-only default (`http.ts:246-249`) |
| Checkout `mode` | defaults `sandbox` (`http.ts:6295`, `lsEnv("SANDBOX")` default true) |
| `LEMONSQUEEZY_YAVER_CLOUD_HOSTED_VARIANT_ID` | unset (variant never created — `docs/yaver-open-todos.md:10-42`) |

Note: the webhook checkout path is NOT gated by `cloudAccessAllowed` — only the
control routes are (`http.ts:6390-7391`). A non-owner can POST
`/billing/checkout` for Cloud Workspace; provisioning then passes the
`canProvisionManaged` gate because the subscription is active. "Owner-only"
today is a UI/control gate, not a checkout gate.

## 6. Test coverage gaps

- Webhook tests are shallow block-regex assertions (`http.test.mts:291-296`).
- No tests for paused/unpaused/plan_changed/payment_success/refunded.
- No reconciliation test, no replay-idempotency test.
- No deterministic sold-out test on the provision path.
- `subscriptions.test.mts` covers only the plan classifier.
