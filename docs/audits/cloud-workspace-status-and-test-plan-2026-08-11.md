# Cloud Workspace & monetization — status + Kivanc-account test plan

Date: 2026-08-11 · Companion audit: `docs/audits/hetzner-access-and-monetization-2026-08.md`

This file is the executable state of the monetization work. It lists what is
done, what remains, every UI surface involved, and a test plan arranged to run
against **Kivanc's owner account** (the account bypasses the private-preview
gates — `isCloudPreviewUser` / `cloudAccessAllowed` / `canProvisionManaged`
owner-bypass / machine-quota exemption — so it is the only account that can
exercise the full lifecycle today).

---

## 1. Done (this session, 2026-08-11)

| # | Change | Files | Verified |
|---|---|---|---|
| 1 | Deep audit (security + monetization, decisions locked) | `docs/audits/hetzner-access-and-monetization-2026-08.md` | written |
| 2 | Landing page refocused on **remote AI runtime** (not MCP-first): hero, two-path CTA, "why this exists", FAQ, JSON-LD incl. pricing OfferCatalog | `web/app/page.tsx` | `tsc` + `next build` ✓ |
| 3 | Public pricing page (Model A: Self-hosted $0 / Cloud Workspace $29 / Relay Pro $9), comparison table, pricing FAQ | `web/app/pricing/page.tsx` (new) | `tsc` + `next build` ✓ (static route) |
| 4 | Pricing nav link | `web/components/Header.tsx` | ✓ |
| 5 | **`HIDE_PAID_UI` flipped `true → false`** — paid infra reintroduced; buy block + billing visible | `web/lib/launchFlags.ts` | `tsc` ✓ |
| 6 | Mobile BYO Hetzner removed (phone-direct token path) | deleted `mobile/src/lib/hcloud.ts`, `hcloud.test.mts`, `byoProvision.ts`, `components/HetznerSection.tsx`; stripped from `mobile/app/(tabs)/settings.tsx` | mobile `tsc` — 18 pre-existing errors, **none from this change** (verified identical on clean main) |
| 7 | **hcloud CLI removed from the agent** | deleted `desktop/agent/launch_hetzner.go`; hetzner branch removed from `launch_auto.go` + `launch_cmd.go` | `go build ./...` ✓ |
| 8 | Legacy managed-relay scripts retired (old single-password auth model, superseded by `provisionRelay.ts`) | deleted `scripts/provision-managed-relay.sh`, `scripts/deprovision-managed-relay.sh` | ✓ |
| 9 | `RemoteManager` (MCP `remote_provision`/`destroy`/`snapshot`) made **manual-only** — no provider API calls, no `HETZNER_API_TOKEN`/`DIGITALOCEAN_TOKEN` reads; `Provision` returns self-host instructions, `Destroy`/`Snapshot` manual + tar-over-SSH | `desktop/agent/remote.go` | `go build` + `go vet` ✓ |
| 10 | REST lifecycle verified headless against deployed backend — every route wired (auth-gated 401, no 404) | — | see §4.C |

## 2. Remains (not done)

| # | Work | Files | Effort |
|---|---|---|---|
| R1 | Remove the agent's **legacy cloud subsystem** BYO path: `cloud_byo_provision.go` ("spin up a box on YOUR OWN Hetzner from mobile/web" — the last user BYO provisioning surface), `cloud_deploy.go` `HETZNER_API_TOKEN` path | `desktop/agent/cloud_byo_provision.go`, `cloud_deploy.go`, `cloud_capacity.go` (its capacity ladder feeds BYO), `byo_golden.go` | medium — entangled with `agent_mesh.go`, `console_machines.go`, `machine_lifecycle.go`; build-verify per file |
| R2 | Decide fate of `cloud_stopstart.go` (managed stop/start ops verbs `cloud_stop`/`cloud_start`, `HETZNER_API_TOKEN`): the Convex control plane owns managed lifecycle now; these agent ops verbs should be owner-gated or removed | `desktop/agent/cloud_stopstart.go` | small |
| R3 | Update blog/docs that teach `hcloud` / `yaver launch hetzner` / user Hetzner provisioning | `web/app/blog/yaver-cloud-launch-anywhere/page.tsx`, `yaver-cloud-image/page.tsx`, `cloud/README.md`, `cloud-image/README.md` | small |
| R4 | **P2 hardening**: shared `hcloudFetch` helper in Convex (retry, 429 retry-after, structured reason codes, optional spend audit), stop raw provider bodies reaching client `errorMessage`, `HCLOUD_TOKEN`-only env, rotation runbook | `backend/convex/cloudProviders/hetzner.ts` + ~8 call sites in `cloudMachines.ts`/`provisionRelay.ts`/`cloudLifecycle.ts` | medium |
| R5 | **P3**: SKU ladder parity test (single ladder, test-pinned) | `backend/convex/cloudLifecycle.test.mts` | small |
| R6 | **Serverless isolation gate** — block `hosted` provisioning until `desktop/agent/serverless_isolation.go` reports ready for untrusted code (do NOT sell shared backends yet) | `backend/convex/cloudMachines.ts` | small/medium |
| R7 | GPU SKU verified orderable + real price, or no GPU checkout | `cloudMachines.ts` / `cloudLifecycle.ts` | small |
| R8 | Idle auto-stop UX (25-min warning / 30-min stop + "never stop during build" tests) | web/mobile + `monetization.md` Phase 4 | medium |

## 3. UI surface inventory (all six domains)

### 3.1 Cloud Workspace lifecycle (create / wake / sleep / delete)
| Surface | Component / route | Status |
|---|---|---|
| Web dashboard | `ManagedCloudPanel.tsx` (mounted in `SettingsView` + `DevicesView`): plan cards, region picker, subscribe → provision phase progress (creating/booting/installing-docker/pulling-image/starting-agent/registering/authorizing-runners/ready), Pause ⏸, Resume ▶, Delete, auto-park, allowance display | ✅ complete |
| Web dashboard | `BillingView.tsx`: Relay Pro $9 / Cloud Workspace $29, checkout, wallet, usage | ✅ |
| REST | `POST /billing/checkout` · `POST /billing/yaver-cloud/stop` · `start` · `auto-park` · `change-plan` · `GET balance` · `usage` · `GET /subscription` · `GET /billing/status` · `GET /cloud/wake-runs/recent` · `POST /billing/yaver-cloud/dev-deprovision` | ✅ wired (verified 401) |
| Mobile | `ManagedCloudCard.tsx` (infra tab): status/wake/park + `managedCloudFlow.ts` post-purchase setup | ✅ |
| CLI | `yaver cloud buy/create/status/ssh` (`desktop/agent/cloud.go`), ops verbs `ops_cloud.go` | ✅ |

### 3.2 User storage
| Surface | Component / route | Status |
|---|---|---|
| Web | `DeviceStorageFold.tsx`, `/project-artifacts/*` (upload-url, list, usage, cleanup, hide, public) | ✅ |
| Mobile | `StorageSection.tsx` (settings) | ✅ |
| Entitlement | `subscriptions.canUseManagedArtifactStorage` — bundled with Cloud Workspace only | ✅ |

### 3.3 Git projects + integration (GitHub / GitLab / yaver git)
| Surface | Component / route | Status |
|---|---|---|
| Web | `GitView.tsx` (1370 lines), `GitSettingsCard.tsx`, `GitMembersPanel.tsx` | ✅ |
| Agent | `/git/status|log|diff|branches|stash|checkout|commit|push|pull|revert|commit-push` (`code_control_plane.go`, `git_commit_push.go`) | ✅ |
| Agent | `/git/provider/setup` + GitHub/GitLab OAuth (`git_oauth_start`, device flow) | ✅ |
| Mobile | `gitPanelModel.ts`, `gitProviderAuth.ts`, `githubAuth.ts`, `SandboxGitPanel.tsx` | ✅ |

### 3.4 API keys / tokens
| Surface | Component / route | Status |
|---|---|---|
| Web | `APIKeysView.tsx` (dashboard) | ✅ |
| REST | `POST /sdk/token` (mint/validate/rotate/revoke), `POST /gateway/token/mint|revoke|rotate`, `/guests/sdk-token` | ✅ wired (401 verified) |

### 3.5 Runner preferences (opencode / claude code / codex)
| Surface | Component / route | Status |
|---|---|---|
| Web | `MachineRolesCard.tsx` (primary runner per project, `machineRolesForProject`), `OpenCodeModelCard.tsx` (model per device) | ✅ |
| REST | `POST /settings` (writes `machineRolesForProject`, `primaryRunnerByDevice`), `GET/POST /runners` | ✅ |
| Agent | `runner_auth` ops (`browser_start` for claude/codex), `opencode_config.go`, `runner_auth_setup.go` | ✅ |
| Mobile | `RunnerAuthModal.tsx`, `runnerBannerState.ts`, `tmuxRunnerSessions.ts` | ✅ |

### 3.6 Self-host path (the non-monetized route)
`npm install -g yaver-cli` → `yaver auth` → pair app; LAN/own-relay/Tailscale; `yaver launch ssh` (manual adoption). **No cloud tokens, no hcloud, no Hetzner.** ✅

## 4. Test plan — run against Kivanc's account

### Preconditions
1. Signed in as the owner (kivanc.cakmak@simkab.com on the owner allowlist, or the owner userId in `CLOUD_PREVIEW_OWNER_USER_IDS`) — web `/auth`, mobile app, and CLI `yaver auth`.
2. **Real (non-dry-run) Hetzner spend requires `HCLOUD_TOKEN` set in the Convex PROD env** (`npx convex env set HCLOUD_TOKEN <token> --prod`) plus `CF_API_TOKEN`/`CF_ZONE_ID`. Without it, provision/stop/start are fail-closed dry-runs (state transitions only) — safe to test the UX, but the box will not actually exist.
3. A Convex bearer token for headless REST: from the web dashboard devtools (`localStorage`/`yaver_auth_token` cookie), or run the CLI and reuse its config token. Use `Authorization: Bearer <token>`.

### A. Marketing web (no auth needed)
1. `/` — hero says "Your coding agent, running anywhere you are" (remote AI runtime), two CTAs (Install free / Cloud Workspace from $29), surfaces chips incl. watch/TV/car.
2. `/pricing` — three cards: Self-hosted $0, Cloud Workspace $29 (highlighted), Relay Pro $9; comparison table; pricing FAQ; header shows **Pricing** link.
3. JSON-LD: view-source shows FAQPage + HowTo + Organization + OfferCatalog.

### B. Web dashboard — Cloud Workspace lifecycle (auth as owner)
1. `/dashboard` → Devices → "Cloud Workspace" panel shows "subscribe for a saved workspace".
2. Subscribe → LemonSqueezy checkout → webhook → `cloudMachines.provision` schedules; panel shows phase ladder (reserving → booting → installing Docker → pulling image → starting agent → registering → ready).
3. **Sleep**: Pause → confirm → `POST /billing/yaver-cloud/stop` → status `paused`, "State kept · active compute stopped".
4. **Wake**: Resume → `POST /billing/yaver-cloud/start` → `resuming` → `active`.
5. **Auto-park**: `POST /billing/yaver-cloud/auto-park` (idleMinutes) — cannot be disabled (fail-closed).
6. **Delete**: Delete workspace → confirm → `POST /billing/yaver-cloud/dev-deprovision` → row removed, DNS cleaned, shared-host drain rules respected.
7. Allowance: `remainingStandardCredits` shown; heavy/build burn faster (wall-clock honesty).

### C. REST lifecycle — headless (owner bearer token)
```bash
TOKEN=<convex bearer>; BASE=https://perceptive-minnow-557.eu-west-1.convex.site
curl -s -H "Authorization: Bearer $TOKEN" $BASE/billing/yaver-cloud/balance      # wallet
curl -s -H "Authorization: Bearer $TOKEN" $BASE/subscription                       # plan
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"machineId":"<id>"}' $BASE/billing/yaver-cloud/stop                          # sleep
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"machineId":"<id>"}' $BASE/billing/yaver-cloud/start                         # wake
curl -s -H "Authorization: Bearer $TOKEN" $BASE/cloud/wake-runs/recent              # ladder
curl -s -H "Authorization: Bearer $TOKEN" $BASE/billing/yaver-cloud/usage           # hours
```
Expected: 200 JSON with wallet/allowance; stop→`paused`; start→`resuming`; wake-runs lists phases. (Real spend only with HCLOUD_TOKEN set.)

### D. Mobile (RN-web at iPhone 15 Pro viewport, `MOBILE_WEB_URL`)
1. Infra tab → Cloud Workspace card shows same status + Pause/Resume.
2. Git panel: connect GitHub (device flow) → list repos → commit/push via agent `/git/*`.
3. Settings → Storage section; Runner auth modal (claude/codex browser start).
4. Verify **no Hetzner wire section** remains in Settings (removed this session).

### E. Git integration
1. `yaver git provider setup github` (or dashboard GitSettingsCard) → OAuth → repo list.
2. Headless: `curl -H "Authorization: Bearer $TOKEN" $BASE/...` or CLI `yaver git status/log/commit-push` against a paired box.

### F. API keys / tokens
1. Dashboard APIKeysView: create an SDK token (scoped, IP-bound), copy once, list, rotate, revoke.
2. Headless: `POST /sdk/token` → mint → `POST /sdk/token/validate` → `rotate` → `revoke`.

### G. Runner preferences
1. Dashboard → Machine Roles card: set primary runner per project (claude/codex/opencode) + renderer split; OpenCode model card per device.
2. Headless: `GET /runners` returns installed runners; `POST /settings` with `machineRolesForProject` persists.

### H. Storage
1. Dashboard artifacts: upload → list → usage → hide → public link (Cloud Workspace entitlement).
2. Headless: `POST /project-artifacts/upload-url`, `GET /project-artifacts/usage`.

### I. Self-host (manual path, no cloud)
1. `npm install -g yaver-cli && yaver auth` → pair phone over LAN.
2. `yaver launch ssh user@host` (manual adoption still works — the automated Hetzner launch is gone).

## 5. Expected failures / notes for the owner account
- `POST /billing/yaver-cloud/provision` returns **410** intentionally (legacy prepaid path disabled; provisioning is webhook-driven after checkout).
- `topup-dev` is owner-only (fine — Kivanc is owner).
- Without prod `HCLOUD_TOKEN`: stop/start/auto-park mutate state but do **not** touch Hetzner (dry-run) — the panel still shows the right UX; the box will not appear in the Hetzner console.
- `HIDE_PAID_UI=false` now exposes buy/billing UI to **all** signed-in users, not just owner — the backend gates still enforce entitlement for non-owners (fail-closed), so a non-owner sees the UI but checkout denies without a subscription.
