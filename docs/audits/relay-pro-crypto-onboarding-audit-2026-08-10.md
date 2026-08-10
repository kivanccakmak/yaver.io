# Relay Pro — Credential Onboarding + Key-Exchange Deep Audit (2026-08-10)

Status: deep audit of `main` @ `473654482` (post shared-host deprovision fix),
guided by `YAVER_POST_AUDIT_EXECUTION_PLAN_2026-08-09.md` §19–20 (Relay Pro as
first live payment test, entitlement boundary) and
`YAVER_CLOUD_WORKSPACE_GITHUB_GITLAB_VAULT_PLAN_2026-08-09.md` (SECRET state
model, Vault, least-privilege hydration).

Scope per the owner's request: **make Relay Pro onboarding seamless for
credentials** and **audit the key-exchange machinery** — ed25519 device
signature auth, QUIC/TLS/Noise DH, pass-through relay invariants. Code is the
source of truth; every claim below was re-verified against files on disk on
2026-08-10.

---

## 1. Crypto model summary (what actually exists)

| Primitive | Where | Role |
|---|---|---|
| **X25519 NaCl box** (pairing encryption) | `desktop/agent/device_keys.go` (keypair at `~/.yaver/device.key`, 0600) | Encrypted device-pairing payloads (OAuth token delivery). DH-based; NOT used for relay auth |
| **ed25519 signing key** | `desktop/agent/device_sign_key.go` (`~/.yaver/device_sign.key`, 0600) | Per-device identity proof to the relay — replaces the shared password |
| **QUIC = TLS 1.3** (X25519 ECDHE on the wire) | `relay/tunnel.go`, `relay/server.go`, agent `client.go` | All relay traffic is QUIC-over-TLS-1.3: forward-secret ECDHE key exchange per connection |
| **Relay ECDSA P-256 cert** (self-signed, persisted) | `relay/tls_persist.go` (`YAVER_RELAY_KEY_PATH`, default `/opt/yaver-relay/relay-key.pem`, 0600) | Stable SPKI identity agents pin against |
| **SPKI pin** (SHA-256 of cert SubjectPublicKeyInfo) | `relay/tls_persist.go:79-86` (published to platformConfig `spki_pin`) ↔ `desktop/agent/relay_pinning.go` | Closes relay-impersonation / MITM (design doc §7, finding #10) |

**No Diffie-Hellman is hand-rolled anywhere.** The DH machinery is the
standard library: X25519 ECDHE inside QUIC's TLS 1.3 handshake, NaCl box X25519
for pairing, ECDSA P-256 for the relay cert. This is the correct posture — the
plan's §35 rule ("do not invent custom cryptography") is satisfied.

---

## 2. Per-device signature auth — the seamless credential

### 2.1 The wire contract (agent ↔ relay)

`desktop/agent/device_sign_key.go:99-104` (`canonicalRelaySigString`) is
byte-for-byte identical to `relay/sigauth.go:30-33` (`canonicalSigString`):

```
method\npath\ndeviceId\ntimestamp-ms\nnonce\nsha256-hex(body)
```

Pinned by `relay/sigauth_test.go::TestCanonicalGolden` (exact-bytes golden)
and the interop test `signLikeAgent` (relay verifies a signature produced
exactly as the agent produces it). Both files carry the "MUST stay identical"
warning. **Parity is tested, not assumed** — this is the same discipline as
the beaconParity test in AGENTS.md.

### 2.2 Verification chain at the relay

`relay/sigauth.go::verifyDeviceSig` (fail-closed on ANY malformed input):
- timestamp within ±60s window (`sigMaxSkew`) → replay window;
- signature length/size checked; base64 decoded strictly;
- `ed25519.Verify(pubKey, canonical, sig)`;
- nonce cache (`sigNonceCache`) rejects a repeated (deviceId, nonce) within
  the window — bounded, swept at 2×window;
- `sigDeviceMatches` — constant-time compare that the SIGNED deviceId equals
  the routed one (closes design finding #7: authorized ≠ routed).

### 2.3 How the relay gets the public key (no secret at rest)

`relay/server.go:801-837` → `resolveSigViaConvex` POSTs the signer/target
deviceIds to Convex `/relay/resolve-sig` (`backend/convex/http.ts:5283` →
`devices.ts:2774 resolveDeviceSig`). Convex returns **only public material**:
the signer's ed25519 public key, userId, plan/isPaid, and whether the reach is
same-owner or via an active access grant. The relay holds no private key and no
shared secret; breaching the relay yields nothing reusable.

### 2.4 Attributable failures (cutover honesty)

`relay/server.go:839-872` — every signature-failure reason is counted
(`no_signer_device`, `body_read`, `unresolved_signer`, `bad_public_key`,
`bad_signature`, `signer_mismatch`) so the password→signature cutover metric
(`/authmix`, `server.go:420-474`) cannot lie the way it did in the 2026-08-01
incident. Fallback to the password path stays non-fatal BUT visible.

### 2.5 Tests (all green on 2026-08-10)

`relay/sigauth_test.go` — valid/replay/tamper/wrong-key/expired/future/
unsigned; `TestSigDeviceMatches`; `TestCanonicalGolden`;
`TestAuthorizeProxyViaSig_OversizedChunkedBodyIsNotTruncatedIntoFallback`
(413 on oversized signed body — no truncation into the password fallback);
`TestSelftestRejectsForgedSignature` / `TestSelftestAcceptsAuthorisedSignature`.
Run: `cd relay && go test -run 'Sig|Canonical|AuthorizeProxy' ./...` → PASS.

---

## 3. Relay Pro onboarding seamlessness (credential flow)

### 3.1 Provision → wire → device pickup (no manual step)

1. **Pay / owner dev-relay** → `POST /billing/yaver-cloud/dev-relay`
   (owner-only, `http.ts:6628`) → `managedRelays.create` → `provision`.
2. **Provision** (`provisionRelay.ts:200`): pool assignment, box create/reuse,
   DNS, `updateProvisioned` → `wireUserRelayUrl` (`provisionRelay.ts:153`).
3. **wireUserRelayUrl** sets `userSettings.relayUrl = https://<subdomain>.relay.yaver.io`
   — ONLY when the user has no custom relay (never clobbers a self-hosted
   relay the user configured). Idempotent.
4. **Agent pickup** (`desktop/agent/main.go:2985-3050`): `FetchUserSettings`
   returns `relayUrl` + the user's per-user `relayPassword`; the agent matches
   the URL against platform config, or synthesizes a `RelayServerInfo`
   (`main.go:415-434`, `QuicAddr = host:4433`) — works even when the
   `/config` fetch races at boot.
5. **Free-relay fallbacks stay** (`appendFreeRelayFallbacks`, `main.go:436-472`,
   commit `735873f6f`): joint-inclusive Free + Relay Pro — a private relay
   that is down/out-of-capacity never makes the device unreachable.

### 3.2 Credentials never leave their home

- The **per-user relay password** is generated by Convex
  (`userSettings.relayPassword = randomHex(24)`, `auth.ts:95`), stored only in
  the user's row, validated per-connection at `/relay/validate`
  (`http.ts:5235` → `userSettings.ts:1435 validateRelayPassword`). The
  platform/shared relay password is NEVER copied into user rows
  (`seedDefaults`, `userSettings.ts:1284-1291` — comparison only, then
  rotated).
- The **device signing key** never leaves the device (`device_sign_key.go`).
- The **relay** holds public keys + the per-user validation verdict, never the
  private halves.
- `/subscription` (`http.ts:7620-7626`) returns relay status/domain/region/
  ports — **never `relay.password`**. `pendingDeviceClaims` uses
  `sha256(relay.password)` for comparison only and returns claim metadata,
  never the password.

### 3.3 Ownership proof on the managed relay

`/relay/validate` returns `{userId, plan, isPaid}` — entitlement is derived
server-side (`userSettings.ts:578 relayEntitlementForUser`: owner → `owner-dev`,
relay-pro sub → `relay-pro`, else `free`). The relay meters per-user, never
from client input.

---

## 4. Relay identity — pinning + rotation self-heal

- `relay/tls_persist.go` persists the ECDSA key so the SPKI is STABLE across
  restarts (fixes the 2026-08-01 incident where `/opt` was read-only under
  systemd and every restart minted an ephemeral key). Logs the pin to publish.
- `desktop/agent/relay_pinning.go::relayTLSConfig` — when `spki_pin` is
  configured for a relay in platformConfig, the agent enforces the pin via
  `VerifyPeerCertificate` (standard Go idiom: `InsecureSkipVerify` + pin).
  Rollout is fail-safe: no pin configured → keep working + one-line warning.
- `desktop/agent/relay_pin_selfheal.go` — on mismatch, re-pulls the pin from
  Convex `/config` (fetched over ordinary WebPKI HTTPS — a lane outside the
  QUIC path an attacker controls). Rotation vs MITM is distinguished; an
  unchanged pin that fails is NOT re-learned (loop guard) and surfaces
  `relayPinMismatchRemedy` naming the exact next step.

---

## 5. Pass-through relay invariants (unchanged, re-verified)

1. The relay **forwards ciphertext only**: signature auth proves device
   identity; the relay does not terminate, inspect, or decrypt payloads
   (AGENTS.md "the relay is pass-through + same-owner/access-graph-scoped").
2. Cross-tenant bridging is refused in **Convex** before the relay forwards:
   `devices.ts resolveDeviceSig` (same-owner or active grant only) and
   `userSettings.validateRelayPassword` (signer.userId === target.userId).
3. Free vs Pro is **not a security boundary** — Pro buys capacity
   (`relayPool.ts` header + `relayEntitlementForUser`).
4. Shared pool hosts validate per-user via `CONVEX_URL` (`relayCloudInit` sets
   no `RELAY_PASSWORD` on shared hosts — only `RELAY_ADMIN_TOKEN` + per-user
   validation; dedicated relays may set the tenant password as the shared
   secret since they are single-tenant).
5. No admin endpoint is reachable with a tenant password: `RELAY_ADMIN_TOKEN`
   is a random per-host value (`provisionRelay.ts relayCloudInit`).

---

## 6. Gaps / follow-ups (not blocking, not payment)

- **SPKI pin not yet published for every production relay**: agents log
  "encrypted but relay identity UNVERIFIED" until the operator publishes
  `spki_pin` in platformConfig `relay_servers`. Owner action, not code.
- **Password→signature cutover still gated on `/authmix`** being clean
  (`sigauth_cutover_test.go` enforces the two-sided gate). Correctly not
  flipped yet.
- **`canonicalRelaySigString` parity has no cross-process CI job** — it is
  pinned by two in-repo tests; a repo-merge could theoretically drift both.
  Low risk (both files warn), not blocking.
- **Relay Pro live checkout** remains unwired (owner instruction: no payment
  wiring). Owner dev-relay path exercises the full provision→wire→deprovision
  lifecycle headlessly.

---

## 7. Verification commands run (2026-08-10)

```bash
cd relay && go test -count=1 -run 'Sig|Canonical|AuthorizeProxy|Pin|RelayKey' ./...   # PASS
cd desktop/agent && go build ./...                                                    # PASS
cd backend && npx convex codegen                                                      # typecheck PASS
cd backend && node --experimental-strip-types --test \
  convex/accessSigPolicy.test.mts convex/billingWebhook.test.mts \
  convex/relayPoolPolicy.test.mts convex/wakeOnRequestPolicy.test.mts                # 43/43 PASS
```

---

## 8. Credential-leak checklist (audited)

| Credential | Stored | Returned to clients? | Logged? |
|---|---|---|---|
| Device ed25519 private key | device-local 0600 file | no | no |
| X25519 pairing private key | device-local 0600 file | no | no |
| Per-user relay password | userSettings row (hashed-compare paths) | no (`/subscription` omits) | no |
| Platform/shared relay password | platformConfig only | no (compared, then rotated) | no |
| Relay ECDSA private key | relay box 0600 | no | no |
| SPKI pin | public (safe to log — PUBLIC key) | yes (by design) | yes (by design) |
| HCLOUD_TOKEN / CF_API_TOKEN | Convex env | no | no |
