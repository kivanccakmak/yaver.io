# Launch Decisions — 2026-08

Recorded per `YAVER_POST_AUDIT_EXECUTION_PLAN_2026-08-09.md` §57 so future
agents do not reopen these decisions accidentally.

| Decision | Reason |
|---|---|
| **Lemon Squeezy remains the launch billing provider.** | Implementation already exists (signed webhook, checkout, status, portal, cancel, entitlements, MCP tools, Go manager, signature parity test). A Stripe migration now adds migration bugs and new test surface with zero additional proof that users want Yaver. Stripe can be reconsidered later only with a concrete commercial/legal/product reason. |
| **Hetzner remains the launch Cloud provider.** | Delete+volume park is already the cheapest scale-to-zero (~€0.044/GB/mo idle, 1–2 min volume wake). The defect is that initial provisioning is not capacity-aware while wake already is — fix the narrow correctness failure, prove demand, then earn a migration. |
| **Relay Pro may launch before Cloud Workspace.** | Relay Pro has much lower variable cost and fulfillment risk; it is the first willingness-to-pay validation. Cloud Workspace stays private/early-access until capacity + billing failure paths pass real-provider E2E. |
| **Cloud Workspace is BYO coding-agent/provider for launch.** | Simplifies billing, margin, gateway spend, and the product story. Legacy `cloud-agent`/`hosted` terms remain internal aliases only. |
| **No AWS/GCP/Azure production enablement before dedicated adapter verification.** | All three facades are `productionEligible:false` with known bugs (AWS serverIp abort, GCP Operation-vs-Instance, 1h OAuth tokens). Never solve a capacity bug by routing users into an unverified provider. |
| **Fly.io is a post-launch evaluation for resume latency, not the current cost fix.** | True suspend is attractive only if users demonstrate 1–2 min resume materially hurts retention. |
| **Cancel semantics: preserve paid access through period end.** | The customer paid through `ends_at`. `subscription_cancelled` with a future `ends_at` keeps the box + entitlements until period end (shows "cancels on DATE"); only `subscription_expired` (or an `ends_at` already past) tears down. Avoids the surprise "I cancelled and my workspace disappeared" incident class. |
| **Landing/pricing copy stays as-is for now.** | Owner confirmed: keep pricing and landing presentation; do not churn web copy while backend hardening is in flight. |

## Env checklist (values never written here — see deploy/operator runbook)

- [ ] LS API key configured in production
- [ ] live store ID configured
- [ ] live webhook secret configured
- [ ] Relay Pro live variant configured
- [ ] Cloud Workspace live variant configured
- [ ] sandbox flag disabled (checkout `mode` live)
- [ ] webhook endpoint reachable
- [ ] live webhook signature accepted
- [ ] `HIDE_PAID_UI=false` only after Relay Pro E2E green
- [ ] `YAVER_CLOUD_PUBLIC=true` only after Cloud go/no-go passes
