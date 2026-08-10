# Launch Post-Audit Findings — re-audit of local HEAD (2026-08-09)

Status: re-audit of `main` @ `2d9a86ae3` (2026-08-09, post `376fa3079`
managed-relay wiring) against `docs/architecture/lemon-squeezy-provider-audit-2026-08-09.md`
and `YAVER_POST_AUDIT_EXECUTION_PLAN_2026-08-09.md`. Code is the source of
truth; every claim below was re-verified against files on disk on 2026-08-09.

This document answers the Phase-0 questions of the execution plan: which audit
claims are still true, which have drifted, and what remains.

Supersedes the earlier findings sheet (audited at `3f7c65890`): sections 1–2
below have been re-verified AFTER the `376fa3079` billing-state-machine work,
so several "still missing" rows are now FIXED and marked as such.

---

## 1. Lemon Squeezy event coverage

| Claim from audit | Verified? | Evidence |
|---|---|---|
| Webhook is HMAC-SHA256 signed, fail-closed | ✅ yes | `backend/convex/http.ts:6047` — `verifyLemonSqueezySignature`; unset secret + no `ALLOW_UNSIGNED` ⇒ reject |
| `subscription_created` handled | ✅ yes | `http.ts:6091` |
| `subscription_updated` handled | ✅ yes | `http.ts:6092` |
| `subscription_resumed` handled | ✅ yes | `http.ts:6093` |
| `subscription_unpaused` handled | ✅ FIXED 2026-08-09 (`376fa3079`) | `http.ts:6094` — converges to upsert + re-apply entitlements; never auto-starts compute |
| `subscription_plan_changed` handled | ✅ FIXED | `http.ts:6096` — refreshes local plan label via `subscriptionPlanFromPayload` (variant_id convergence, audit G1) |
| `subscription_payment_success` handled | ✅ FIXED | `http.ts:6095` — re-fires idempotent per-period allowance grant |
| `subscription_paused` handled | ✅ FIXED | `http.ts:6204` — status→paused, entitlements revoked, compute parked |
| `subscription_payment_failed` handled | ✅ yes | `http.ts:6298` — status→past_due, gateway policy off, machines parked |
| `subscription_cancelled` period-end semantics | ✅ FIXED | `http.ts:6228` — preserves paid service through `ends_at`; tears down only when period already past |
| `subscription_expired` full teardown | ✅ yes | `http.ts:6256` |
| `order_refunded` handled | ✅ FIXED | `http.ts:6357` — full refund (`isFullyRefundedOrder`) revokes entitlements + deprovisions relay/parks machines; partial refunds preserved + logged (explicit rule, plan §5) |
| Unknown events return `{ok:true}` silently | ⚠️ still true | default fall-through `http.ts:6392` — benign for genuinely-unknown events; plan §8 wants a visible counter/log. Not yet added. |

## 2. Billing state machine

| Claim | Verified? | Evidence |
|---|---|---|
| Subscription↔LemonSqueezy reconciliation | ⚠️ partial | `/billing/yaver-cloud/reconcile` (`http.ts:6756`) repairs missing relay/box for an ACTIVE sub; `cloudMachines.reconcileSubscriptions` (`cloudMachines.ts:2837`) is triggered from `/crons/run` (`http.ts:10388`, case `reconcileManagedSubscriptions`) and `/billing/yaver-cloud/reconcile`. NO periodic auto-sweep of all local subs against the LS API (plan Task 3 remains). `subscriptions.markExpired` (`subscriptions.ts:289`) is defined but has **no caller anywhere** — expired rows are only reached via the `subscription_expired` webhook |
| `past_due` counts as subscribed in `/billing/status` | ✅ FIXED | `http.ts:6962` — `billingStateFlags(sub?.status)`; only `active` ⇒ `subscribed:true`; past_due surfaces `paymentProblem` (audit G3) |
| Cancel tears down immediately, not at period end | ✅ FIXED | `http.ts:6228` — period-end semantics implemented; `/billing/cancel` keeps entitlement through `ends_at` |
| Allowance grant idempotent per billing period | ✅ yes (still untested) | `plans.applyPlanEntitlements` (`plans.ts:117`) dedupes via orderId `sub-allowance-{sub}-{YYYY-MM}`. **No test yet** proves the 100-replay invariant — plan Task 1 calls for one |
| Refund path | ✅ yes | `subscriptions.refund` (`subscriptions.ts:254`) + full/partial rule; webhook wired at `http.ts:6357` |

## 3. Hetzner / Cloud Workspace

| Claim | Verified? | Evidence |
|---|---|---|
| Wake/resume is capacity-aware (substitution + fallback + margin ceiling) | ✅ yes | `cloudLifecycle.ts:1079-1200` (`hetznerPickAvailableServerType`), `:2520-2566` (wake substitution), `:2664-2689` (transient retry) |
| Initial provision is NOT capacity-aware | ✅ still true | `cloudMachines.ts:2386-2404` — `createMachine` with hardcoded `sku` + `region:"eu"`; no availability pre-check, no fallback. **Plan Task 5 remains** |
| `reconcileSubscriptions` repeats one SKU/region | ✅ still true | `cloudMachines.ts:2837-2903` → `ensureForSubscription` with `region:"eu"`, `standard`. **Plan Task 6 remains** |
| Multiple SKU ladders | ✅ still true (4 sources) | `cloudLifecycle.ts:671`, `cloudProviders/hetzner.ts:104`, `desktop/agent/cloud_capacity.go:49` (BYO), `cloudLifecycle.ts:708`. **Plan Task 4 remains** |
| Placement ladder abstraction exists but unused by provision | ✅ true | `cloudProviders/placementLadder.ts` only referenced in its own file + tests |
| Pre-checkout availability endpoint | ❌ absent | no `/billing/availability` route. **Plan Task 7 remains** |
| Fulfillment compensation (`fulfillment_failed`) | ❌ absent | no such state anywhere. **Plan Task 8 remains** |
| AWS/GCP/Azure `productionEligible:false` | ✅ yes (keep) | `aws.ts:84`, `gcp.ts:89`, `azure.ts:94` |
| Park = delete + keep volume (cheapest idle) | ✅ yes | `cloudLifecycle.ts:760-777` |
| Orphan sweep report-only | ✅ yes | `cloudLifecycle.ts:2064` (`reconcileProviderResources`, dryRun default true) |

## 4. Relay Pro shared pool (NEW since `3f7c65890` — `376fa3079` + uncommitted pool work)

| Claim | Verified? | Evidence |
|---|---|---|
| Relay Pro rides a shared multi-tenant host by default | ✅ yes | `relayPool.ts` header + `provisionRelay.ts:251-274` (pool assignment before provider spend); dedicated ("Private Relay") rows skip the pool |
| Shared host is NOT deleted while other tenants use it | ✅ FIXED (uncommitted) | `provisionRelay.deprovision` marks the tenant row `stopped` FIRST, always removes the tenant's DNS record, then `sharedHostDeletionDecision` (`relayPoolPolicy.ts`) deletes the box only when the host is drained. Pre-fix: first tenant to cancel took the whole fleet offline |
| No billed-orphan grace snapshots for shared hosts | ✅ FIXED (uncommitted) | `sharedHostGraceSnapshotDecision` (`relayPoolPolicy.ts:105`) — snapshots only for dedicated relays; shared teardown measured leaving a billed 0.39 GB `yaver-predelete-relay-*` orphan (2026-08-09) |
| Pure pool policy unit-tested | ✅ FIXED (uncommitted) | `relayPoolPolicy.test.mts` (11 cases) + registered in `scripts/test-suite.sh` policy-test list |
| `/relay/validate` per-user auth, fail-closed | ✅ yes | `http.ts:5233` → `userSettings.validateRelayPassword` → `relayEntitlementForUser` (`userSettings.ts:578`) — owner ⇒ `owner-dev`, relay-pro sub ⇒ `relay-pro`, else `free` |
| Relay password never returned to clients | ✅ yes | `/subscription` (`http.ts:7620`) returns status/domain/region/ports only; `pendingDeviceClaims.listForUser` hashes for comparison only; `seedDefaults` never copies the platform password into user rows |

## 5. Cron / ops

| Claim | Verified? | Evidence |
|---|---|---|
| `crons.ts` is empty (all jobs on one self-hosted timer box) | ✅ still true | `crons.ts` is comment-only; meter/idle/orphan/reconcile run as systemd timers POSTing `/crons/run` (`http.ts:10069-10192`). **Plan Task 9 remains** |
| `cronHealth` / `recordCronTick` exist | ✅ yes | `cloudLifecycle.ts:2931,2961` |
| Second trigger / missed-tick alert | ❌ absent | no dual trigger, no alarm consumer. **Plan Task 9 remains** |
| Billing/provider failure analytics events | ❌ absent | no `billing_webhook_*` / `cloud_candidate_*` / `cron_*` events. **Plan Task 10 remains** |
| Operator ops dashboard | ❌ absent | no owner view for billing/cloud/cron health. **Plan Task 10 remains** |

## 6. Launch flags

| Flag | Value in code |
|---|---|
| `web/lib/launchFlags.ts` `HIDE_PAID_UI` | `true` (`web/lib/launchFlags.ts:12`) |
| `YAVER_CLOUD_PUBLIC` | unset → owner-only default (`http.ts:246-266`) |
| Checkout `mode` | defaults `sandbox` (`http.ts:6445`, `lsEnv("SANDBOX")` default true) |
| `LEMONSQUEEZY_YAVER_CLOUD_HOSTED_VARIANT_ID` | unset (variant never created — `docs/yaver-open-todos.md:10-42`) |
| Owner identity | env allowlist only (`ownerAllowlist.ts` — `CLOUD_PREVIEW_OWNER_EMAIL` / `CLOUD_PREVIEW_OWNER_USER_IDS`), never hardcoded; fail-closed when unset |

Note: the webhook checkout path is NOT gated by `cloudAccessAllowed` — only the
control routes are (`http.ts:6540-7362`). A non-owner can POST
`/billing/checkout` for Cloud Workspace; provisioning then passes the
`canProvisionManaged` gate because the subscription is active. "Owner-only"
today is a UI/control gate, not a checkout gate. Owner-only-dev paths
(`/billing/yaver-cloud/dev-relay`, `dev-deprovision`, `runners-authorized`)
ARE 403-gated by `isCloudPreviewUser`.

## 7. Test coverage gaps (unchanged)

- Webhook tests are shallow block-regex assertions (`http.test.mts:291-296`).
- No tests for paused/unpaused/plan_changed/payment_success/refunded event
  CONVERGENCE (the pure helpers are tested in `billingWebhook.test.mts`; the
  http wiring is not).
- No reconciliation test, no replay-idempotency test.
- No deterministic sold-out test on the provision path.
- `subscriptions.test.mts` covers only the plan classifier.
