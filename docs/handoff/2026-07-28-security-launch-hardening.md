# Security launch hardening — 2026-07-28 handoff

**Status at handoff:** main = `1ba4e2334` (security work) / `c4065550b` (HEAD incl. unrelated mobile fix), pushed, in sync with `github/main`. Convex deployed to prod twice. Agent fixes are **on main but NOT shipped** — they reach users only with the next `yaver-cli` release.

**Read this first if you are continuing:** the four "Traps that cost me time" at the bottom. Two of them are mistakes I made in this session, not hypotheticals.

---

## 1. Goal

The user was preparing to publish (open-source launch, public repo, anyone can sign up). The brief evolved across the session:

1. *"can hacker deploy to relay or add himself to owner list"* — a question. Became an audit.
2. *"make it secure we will publish"* — fix what the audit found.
3. *"disable guest feature too with flag we will open them later on, but make it with one config file… and make it secure"* — reduce launch surface, but leave the gated code **fixed, not abandoned**.
4. *"use industry standards two handshake"* — no ad-hoc auth schemes.

Working threat model, and the one to keep:

- **Anonymous internet attacker.** Public Convex deployment URL, public repo (they read every line, including the KDF).
- **Free self-signed-up account** attacking *other* users. This is the multi-tenant boundary.
- **Hostile LAN neighbour** — cafe, coworking, hotel, compromised IoT.
- **Malicious third-party repo** the user clones and opens in Yaver.

---

## 2. What I implemented

### 2.1 Convex — anonymous account takeover (CRITICAL, deployed)

`backend/convex/auth.ts` — `createPasswordReset` and `resetPassword` were public `mutation`s. `createPasswordReset` takes the reset **`tokenHash` as a caller argument** and binds it to any victim's `userId` with no proof of mailbox control; `resetPassword` then overwrites `passwordHash` and deletes every session. Two anonymous calls = permanent lockout of any email-provider account, and full takeover once `YAVER_EMAIL_PASSWORD_AUTH_ENABLED` flips. The KDF is in this public repo, so a valid `newPasswordHash` is computed offline.

Both are `internalMutation` now; `http.ts` (the only caller) moved to `internal.auth.*`.

**The general lesson, which still applies to unfixed code:** the three guards on the HTTP route never ran, because *a direct Convex call never passes through `http.ts`*. **`http.ts` is one of TWO front doors.** A guard living only in a route handler is bypassable by calling the function by name.

Verified by type probe (a runtime probe can't distinguish, Convex hides error detail in prod):

```ts
// temp file in backend/convex/, then npx tsc --noEmit -p convex/tsconfig.json
export const _x = api.auth.createPasswordReset;   // must ERROR
export const _y = internal.auth.createPasswordReset; // must compile
```

### 2.2 Convex — `CONVEX_INTERNAL_SECRET` fail-open (CRITICAL, deployed)

`http.ts::requireServerSecret` returns `null` (allow) when the env var is unset — a deliberate staged rollout whose step 3 never happened. It was **unset on prod**, leaving five identity-provisioning routes unauthenticated: `/auth/upsert-user`, `/auth/create-session`, `/auth/oauth-link/complete`, `/auth/totp/{check-user,create-pending}`. Chain: upsert-user auto-links by verified email and returns the victim's `users` id → create-session inserts a session with no proof → `scope` defaults to `"full"`.

Provisioned via `scripts/provision-convex-internal-secret.sh`. Verify any time, read-only:

```
./scripts/verify-convex-auth-gate.sh
```

It checks **both** halves — gated routes must 403, ungated (`/auth/login`, `/auth/device-code/*`) must NOT — because a gate broad enough to kill every mobile and agent login would otherwise show green.

### 2.3 Convex — two access-graph fail-opens (deployed)

- `projectShares.acceptByCode`: the `by_share_user` lookup matched on userId with **no status filter**, and `revokeMember` leaves `userId` in place while setting `status:"revoked"`. A removed member re-entering the (never-rotated) share code fell through to `materializeProjectGrant` and patched themselves back to `active`. Removal was undoable by the removed party. Guard added: `membership.status !== "invited"` → throw.
- `guests.applyDeviceScope`: when scoping *was* requested but the intersection resolved empty, it returned without writing an `infraAccessGrant` — and `access.ts:129` reads "guestAccess row with no grant" as **legacy unscoped = every host device**. Asking for a narrow scope granted strictly more than asking for a wide one, on a guest-controlled trigger. Now falls through and writes the grant with `shareAllDevices:false` and zero device links.

### 2.4 Agent — unauthenticated `/builds` → RCE (on main, unshipped)

Two independent defects that chained:

- `isLocalLoopbackRequest` (`httpserver.go`) tested only for `X-Forwarded-For`. The relay bridge never sets it — it re-issues against `127.0.0.1` stamping only `X-Yaver-Via-Relay` (`main.go:11828`, `:11935`). So every relay-delivered request read as "genuinely local" and `authBuildLocal` admitted it with **no auth**. `dev_bundle_sig.go::isLoopbackRequest` got this right in the 2026-07-13 audit — this was a **second, independent implementation** that never received the fix.
- `handleBuilds` passes caller-supplied args into a string run through `sh -c`. The metacharacter check lived **only** in `resolveNativeBuildCommand`, and it signalled refusal with `ok=false` — the same value meaning "not a native platform" — so a rejected arg **fell through** into the unsanitized general switch. Breaking the guard emits `SCHEME="$(id)"` into an `sh -c` string. Now one shared `validateBuildArgs`, applied before any resolver.

### 2.5 Agent — cross-tenant SDK token bypass (on main, unshipped)

`authSDKOrGuest`'s cached branch validated scopes and CIDR but **never checked whose token it was**, while `authSDK` rejects a foreign `userID` outright. The miss path made it trivially reachable: it `Store`d the cache entry **before** the owner check, so request 1 populated the cache and 403'd, and **request 2 was authorized as the owner**. Any Yaver account could mint a token, send it twice to a stranger's agent, and reach `/ops`, `/agent/runner/switch`, `/dev/reload`.

Owner-equality is correct, not an approximation: a legitimately delegated guest SDK token carries the **host's** id (`guests.ts:588` mints with `userId: hostUserId`) and is demoted by `applyDelegatedGuestSDKHeaders`, so guests still work.

### 2.6 Agent — host-share (on main, unshipped)

- `stripGuestRequestHeaders` stripped only `X-Yaver-HostShareAllowedRunners`, so a caller could attach `X-Yaver-HostShare` themselves. With `resolveHostShareRoot` honouring a caller-supplied **absolute** `rootPath`, one extra header on a support token turned `/files/read` into "read any file as the agent user" — starting with `~/.yaver/config.json`, which holds the owner's `auth_token`. Whole family stripped now.
- `hostShareCanAccessProject` returned `true` on an **empty** allowlist, and empty is the default (`--projects` is optional). Now fails closed.

### 2.7 The launch kill switch — three files, one per front door

| Surface | File | Constants |
|---|---|---|
| Agent | `desktop/agent/feature_flags.go` | `ENABLE_GUEST_FEATURES`, `ENABLE_DEPLOY_WEBHOOK` (+ `YAVER_ENABLE_*` env overrides) |
| Convex | `backend/convex/launchFlags.ts` | `ENABLE_GUEST_FEATURES`, `ENABLE_TEAM_FEATURES` |
| Web | `web/lib/launchFlags.ts` | `HIDE_PAID_UI`, `ENABLE_GUEST_FEATURES`, `ENABLE_TEAM_FEATURES` |

All `false`. **Flip together** — a dashboard offering to invite a guest while Convex refuses the mutation and the agent refuses the token is worse than not offering it.

Design decisions worth preserving:

- **Enforced ahead of the logic it protects.** Several findings were bugs *inside* scope/header handling, so the switch short-circuits before any scope lookup, header stamping or path matching.
- **Convex gates INSIDE the mutations** (13 grant-creating ones across `guests`/`projectShares`/`hostShare`), not only in `http.ts` — see 2.1 for why.
- **Existing rows are CANCELLED, not deleted**, at `access.ts::getActiveInfraGrant` + `getLegacyGuestAccess` — the two primitives every guest read path is built on. An invitation accepted last week stops granting instantly and resumes untouched when the flag returns. The legacy path matters most: a `guestAccess` row with no grant is read as access to *every* host device, so leaving it live is the widest possible grant.
- **revoke / leave / delete / archive stay OPEN.** Disabling a feature must never trap someone with access they cannot rescind.
- Env overrides can only ever turn something **ON**, so the constants tell you the floor.

### 2.8 Agent — companion tokens ran commands as the owner (on main, unshipped)

`httpserver.go` promises in a comment that "a stolen TV token can … not run commands". It could. A tvOS/watch/vision session reaches `POST /ops` legitimately (`companionSessionAllowed` admits it for the watch voice lane) but carries none of the guest/support/host-share headers, so `ops_http.go` fell through to `caller="owner"` — and `ops.go` restricts only `caller=="guest"`. It reached the `run` verb.

Three parts: the middleware stamps `X-Yaver-SessionScope` with the scope Convex **already** validated; that header is added to `stripGuestRequestHeaders` so it can't be forged in either direction; and the caller derivation — which existed **twice, verbatim, neither copy companion-aware** — is now one `opsCallerFromRequest`.

`companion_scope_parity_test.go` asserted `/exec` was denied **while explicitly admitting `/ops`** — a false green next to the hole.

### 2.9 LAN pairing — both halves (agent on main; mobile on main)

- **Agent stopped broadcasting the pairing secret.** `startBootstrapBeacon` put the passkey in the beacon, opt-**out** via `YAVER_BOOTSTRAP_NO_BEACON_PK=1`. The one secret authorizing the deliberately-unauthenticated `/auth/pair/submit` went to `255.255.255.255` every few seconds during setup. Now opt-**in** (`YAVER_BOOTSTRAP_BEACON_PASSKEY=1`, logs a loud warning). Discovery unchanged; only the secret is withheld, so pairing uses the passkey printed on the box's console — the Apple TV model.
- **Phone stopped acting on one.** The auto-pair loop POSTed the phone's 1-year bearer, in cleartext, to `http://<ip>:<port>` taken from a beacon — and `na:true` bootstrap beacons bypass **both** the fingerprint and known-device checks by design. Removed from the automatic path. After the agent fix it was *exclusively* an attacker vector: real agents no longer broadcast a passkey.

### 2.10 The mutual identity handshake (the "industry standard two handshake" ask)

`POST /identity/prove` — `desktop/agent/identity_proof.go` + `mobile/src/lib/identityProof.ts`.

The heartbeat's "upgrade to direct" probed `/health` **with `this.authHeaders`** and moved the whole session on a 200 — trusting an unsigned UDP packet with an authenticated session. The beacon's `th` is a short unsalted hash any listener can replay.

**A beacon tells you an ADDRESS. It never tells you WHO is there.**

Challenge-response, built only from NaCl box (the primitive encrypted pairing already uses — no new crypto):

1. Client generates a fresh 32-byte nonce + ephemeral X25519 keypair.
2. Seals the nonce to the device public key **Convex** records for the target.
3. POSTs it with **no credentials** — an unproven host must never see a token.
4. Only the holder of that private key can open the box and echo the nonce.
5. Client compares in constant time; only then attaches a credential.

The missing leg was always the *server's*: the client already proved itself with its bearer, but only after handing it over.

> **The detail that makes it work — do not "simplify" this.** The expected key comes from **Convex**, never from the beacon's own `dpk` field. Using the beacon's key would be circular: a forged beacon supplies its own key and passes its own challenge. `DeviceContext` feeds `setKnownDevicePublicKeys()` from the Convex device list.

Fails closed on every path (no recorded key, timeout, malformed reply, wrong nonce, mismatched key) — the cost is an optimisation, not a session.

### 2.11 Tooling

- `scripts/provision-convex-internal-secret.sh` — generates, sets Cloudflare **first** then Convex (both fail open independently; reverse order takes every login down), waits for worker rollout, probes before/after. `--rollback` unsets the Convex var and recovers logins instantly. Secret never touches stdout/argv/history; backed up to `~/.yaver/local-secrets.env` 0600 **before** either remote write.
- `scripts/verify-convex-auth-gate.sh` — read-only, idempotent, checks both halves.

---

## 3. Verification performed

```bash
# agent — ALWAYS scope with -run; a broad `go test` in desktop/agent SIGNS YOU OUT
cd desktop/agent && go test -count=1 -run '^(TestIdentityProve_.*|TestSealIdentityChallenge_.*|TestIdentityProofMatches_.*|TestOpsCallerFromRequest_.*|TestFeatureFlags_.*|TestAuthSDKOrGuest_.*|TestStripGuestRequestHeaders_.*|TestHostShareCanAccessProject_.*|TestSupportSessionRedeem_.*|TestIsLocalLoopbackRequest_.*|TestBuildAuth_.*|TestValidateBuildArgs_.*|TestResolveBuildCommand_.*)$' .

cd backend && npx tsc --noEmit -p convex/tsconfig.json
cd web && npx tsc --noEmit
./scripts/verify-convex-auth-gate.sh
```

Every guard was **proven by breaking it** — deleted, watched the test go red with the right message, restored. Live-verified against prod: five gated routes 403; `/auth/config` 200, `/auth/providers` 401, `/auth/login` 400, `/auth/device-code/poll` 404 (none 403); `/teams/members` GET+POST 403.

**Not verified, and only a human can:** a real OAuth sign-in at https://yaver.io. No script can drive it. The probe proves strangers are rejected; only a real login proves web sends `X-Internal-Secret` correctly. If it breaks, `./scripts/provision-convex-internal-secret.sh --rollback` first, diagnose after.

---

## 4. What is MISSING — ranked

### 4.1 `requireFullScope` lives only in `http.ts` — **highest leverage left**

Same shape as the password-reset CRITICAL. `validateSessionInternal` *returns* `scope`; the mutations discard it. Every scope-sensitive public mutation reachable at the Convex URL is callable by a `machine`/`tv`/`watch` companion token that `http.ts` would have refused: `agentRescue.queueRescueCommand`, `userSettings.setByToken`, `provisioning.*`, `pendingDeviceClaims.claim`, `totp.disableTotp`.

Fix by moving `requireFullScope` into a shared helper the **mutations** call. Closes a class, not an instance.

Related, confirmed: `userSettings.getByToken` scopes correctly to the caller's own user, but **bypasses a deliberate redaction** — `http.ts:4892` strips `speechApiKey` and `schema.ts:946` says it is "never returned by /settings", yet a direct call returns the raw row including `speechApiKey` **and `relayPassword`**.

### 4.2 Relay expose lane — unauthenticated cross-tenant reach

`relay/server.go:2527 tryExposeProxy` runs **before the mux** and calls **no** auth function. Every registering device is auto-given `<deviceId>.<EXPOSE_DOMAIN>` → its own port 18080 (`server.go:1274`); `EXPOSE_DOMAIN=dev.yaver.io` ships in `deploy/yaver-relay.service`. `r.Host` is honoured and the shipped nginx passes `Host $host` verbatim. It also never calls `CheckAllowed`, so an attacker burns the victim's bandwidth allowance and 64-slot concurrency budget for free.

**Deliberately not fixed** — the lane serves TWO features: an explicit user-published preview (public by design) and the auto route to the control port (must not be). Separating them is a product decision, and it needs a **manual scp redeploy to `public.yaver.io`** (see `project_public_relay_deploy_drift`). The agent-side `/builds` fix already broke the RCE half.

### 4.3 Convex, unfixed

- `passkeys.signupFinish` — anonymous account-squatting. `attestationType:"none"` + `requireUserVerification:false`; `signupStart({email:"victim@…"})` → `signupFinish` creates a `users` row for an address the caller doesn't own. When the real victim later signs in with Google, a **second row with the same email** is inserted, after which every `.unique()` by-email lookup **throws** — permanent, anonymous, unrecoverable-without-DB-surgery auth breakage. Nothing binds `signupStart` to `signupFinish`.
- Rate limiters in `rateLimiter.ts:90` (`auth-signup-ip`, `auth-login-ip`, `device-code-ip`, …) have **zero call sites**; the only consumer in the whole backend is the chat route. So `/auth/device-code/authorize` is unthrottled, its `authorizeAttempts > 8` counter is per-*code* (useless vs spraying), and `/auth/device-code/info` is a free unauthenticated hit/miss oracle over ~31.6 bits.
- `provisioning.revoke` — `if (row.ownerUserId && row.ownerUserId !== session.user._id) throw` is **vacuous** while `ownerUserId` is unset (the entire pre-claim window). Any account can brick a hardware production run.
- `guests.mintGuestFeedbackSdkToken` — no revoke path deletes `sdkTokens`, and `validateSdkToken` never re-checks `guestAccess`, so **revoked guests keep access indefinitely** (and `rotateSdkToken` re-issues at 365 days). Currently masked by the kill switch; becomes live the moment guests reopen.
- `guests.recordGuestUsage` doesn't verify the target is your guest and doesn't bound `secondsUsed`. `hostShare.findInviteByCode` returns host **and** invitee emails to any code holder. `/devices/presence` patches any deviceId on a shared secret with no user scoping. `/packages/accept` lacks an already-claimed guard.
- `backend/scripts/check-convex-public-auth.mjs` **exits 1 today** on two false positives and is **not wired to CI** — a real regression is indistinguishable from standing noise. It also `readdirSync`s non-recursively, so `convex/cloudProviders/` is never scanned.

### 4.4 Agent, unfixed (P1 from the audit — I verified none of these myself)

- `/dev/` and `/dev-web/` are **unauthenticated full reverse proxies** to the live dev server (`httpserver.go:1008,1016`) — anonymous LAN/relay read of entire app source incl. inlined `EXPO_PUBLIC_*`.
- SDK token **revocation has no effect** until restart (`authSDK` cache never checks `storedAt`).
- `builds` is in `DEFAULT_SDK_SCOPES` (`backend/convex/auth.ts:1813`) → every feedback-SDK token can `POST /builds`.
- `/clips/` + `/asciinema/` serve screen and **terminal recordings** unauthenticated, 8-char id, no rate limit.
- `/oauth/userinfo` returns **200 for any bearer string**.
- Relay SPKI pin exists in code, configured nowhere → relay MITM live.
- `safeJoin` returns `ok=true` on ENOENT → ancestor-symlink escape on every *create*.
- `git clone` blocks `-`-prefixed args but **not `ext::`** (`repos_http.go:619`) — `ext::sh -c …` is RCE.
- Stripe/LemonSqueezy webhooks have **no signature verification** and mark all invoices paid.
- `rateLimitKey` (`ratelimit.go:238`) buckets on the **caller-supplied `Authorization` header** — rotating a dummy bearer gives a fresh bucket, so `/auth/pair/submit` and `/support/redeem` brute-force limits are bypassable. `/support/redeem` is also **not single-use**.
- `/auth/reload-from-disk` loopback gate isn't relay-aware — a **third** copy of that predicate.
- Relay envelope `TargetPort` is unvalidated → a hostile relay reaches any loopback service.

### 4.5 Mobile, partially fixed

The relay/direct auto-pair for an **already-known** device (`DeviceContext` ~3251) still falls back to a plaintext `submitPair` over LAN HTTP. Materially safer than the beacon path (host comes from the device's Convex row, passkey from that box's own `/info`) but it is still a cleartext token — it should adopt the `/identity/prove` handshake.

### 4.6 Repo hygiene before going public

A full scan of 6,813 tracked files and 45,880 blobs across 4,643 commits found **no attacker-usable credential** ever committed. But:

- `docs/security/security_audit.md:560` is one grep line concatenating the Android keystore password with **both real Hetzner IPs** and the Apple issuer UUID — a curated index for a hostile reader. Table at 483–492 restates them. **Cheapest high-value fix before launch.**
- Android keystore password `yaver2024release` **is** in history (`b8361ffc6`, `61412da1a`) and re-published in three tracked files today. The keystore binary was never committed, so it isn't usable alone. Rotation status not verifiable from the repo; the tracking checkbox at `arbitrage-resale-threat-model.md:281` is open.
- `.gitignore` does **not** cover `*.p12`, `*.pfx`, `*.jks`, `*.pem`, `*.key`, `*.mobileprovision`, `id_rsa`/`id_ed25519`, `local-secrets.env`. CLAUDE.md's own `~/.yaver/local-secrets.env` (login + sudo password) has no matching rule.
- Real infra IPs at HEAD: `desktop/agent/main.go:8705,8708`, `ssh_resolve_test.go`, `remote_status_cmd.go:870`, `docs/handoff-connectivity-2026-07-13.md:367`. CLAUDE.md forbids these.
- `IstanbulDigerK4.pdf` (11 MB personal PDF) still retrievable from history. Stray tracked artifacts: `.codex-tmp/` (66 files, unrelated project), `sdk/feedback/swift/.build/`.

---

## 5. Traps that cost me time — read these

1. **A test that asserts only the status code is a false green.** My first cross-tenant SDK test passed *with the guard deleted*, because the request then failed the **scope** check instead and still returned 403. Assert **why** something was refused. An attacker picks their own scopes at mint time, so a scope check is not an identity check.
2. **`git cherry` counts SUPERSEDED branches as unmerged.** Auditing ~40 branches for lost work, 8 of 9 "unmerged" branches had already landed under different SHAs. `tasks-list-payload-guard` looked the most convincing (549 insertions, tests, incident doc) — every symbol was already in main, in a *more advanced* form, and merging it **conflicted and would have regressed main**. Audit by **symbol** (`git grep -q <sym> main`), never by commit count. A merge conflict on a "clearly unmerged" branch is a strong signal the work already landed.
3. **BSD/macOS `sed` does not support `\s`.** My provisioning script used it, silently matched nothing, made the whole line the URL, and every curl failed — returning `000000` (curl's `000` plus my own `|| echo "000"`), which slipped past a `== "000"` guard. The script then mutated **both sides of production** on a probe that never left the machine, and reported "enforcement did NOT take effect" when it had. *"We learned nothing"* and *"the gate is open"* are different states and must never collapse into one.
4. **The duplicated derive is this codebase's defining bug shape.** It caused three separate findings today: `isLocalLoopbackRequest` vs `isLoopbackRequest`; `opsCallerFromRequest` existing twice, verbatim, neither companion-aware; and a third un-fixed copy in `/auth/reload-from-disk`. When you fix a predicate, `grep` for its siblings.

Also: **a broad `go test` in `desktop/agent` signs you out** — always `-run`-scope it (`project_go_test_wipes_real_yaver_auth`).

---

## 6. Suggested order for the next session

1. **`requireFullScope` into the mutations** (§4.1). Closes a class. Same shape as the CRITICAL already fixed, so the reasoning is already written down.
2. **`passkeys.signupFinish`** (§4.3) — anonymous, permanent, unrecoverable damage to any email address. Stage a pending signup; create the `users` row only on verification-token consumption.
3. **Wire the rate limiters** (§4.3). They already exist — this is connecting a producer to a consumer, the classic "signal with no consumer" defect.
4. **`docs/security/security_audit.md:560`** (§4.6) — one commit, removes the hostile reader's index. Do before the repo gets attention.
5. **Ship a `yaver-cli` release.** Every agent fix in §2.4–2.10 is inert until boxes update. Needs the user's explicit go-ahead (`feedback_no_builds_without_permission`).
6. **Relay expose lane** (§4.2) — needs a product decision from the user *and* a manual relay redeploy.

---

## 7. Memory notes written this session

- `project_security_audit_2026_07_28_relay_convex` — the audit itself, deploy state, the three flag files, what's still open.
- `project_branch_audit_cherry_false_unmerged` — trap 2 above.
- `feedback_no_vault_for_ops_secrets` — user directive: keep `yaver vault` out of the ops/deploy secret path; use 0600 env files. Vault re-derives its key per device, so a re-registration leaves it undecryptable and every `eval "$(yaver vault env … || true)"` proceeds with empty env and fails later with an unrelated-looking error.
