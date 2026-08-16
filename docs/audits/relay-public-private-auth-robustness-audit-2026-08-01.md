# Public-Free and Private Relay Auth Robustness Audit

Date: 2026-08-01

Scope: Yaver relay password/auth failure modes across public-free, Relay Pro/shared managed hosts, dedicated/private relays, Cloud Workspace sidecar relays, web/mobile clients, and the desktop agent. This audit is code-grounded; Markdown architecture docs were treated as context only.

## Executive Summary

Yaver has the right security direction: the official relay is moving away from relay-password authority toward per-device signed requests, Convex-scoped ownership, and pass-through relay semantics. The code already contains important hardening:

- Public-free relay registration/proxy auth validates per-user relay passwords through Convex, including active session and device ownership checks.
- Proxy requests can authenticate via per-device Ed25519 signatures, with replay protection and `/authmix` telemetry before password cutover.
- Public relay HTTP denial bodies now carry stable machine-readable codes for password missing/invalid/rate-limit/backend-unavailable/device-not-connected/owner-mismatch.
- QUIC tunnel registration now supports same-user last-writer-wins eviction, which directly addresses stale registration black holes.
- Password rotation clears relay-side validation caches and forcibly disconnects existing tunnels.

The product is still fragile because relay passwords are not just a compatibility fallback. They remain threaded through Convex tables, Docker/env provisioning, client headers, query strings for browser-only surfaces, repair loops, admin compatibility paths, TURN fallback, pending bootstrap claims, and private/self-hosted relay mode. That keeps password drift as a first-class outage cause.

The target should be:

1. Public-free: per-device signature auth for proxy requests, Convex-scoped registration, password only as measured fallback until `/authmix.safeToCutOver`.
2. Relay Pro/shared managed hosts: same security model as public-free, with per-tenant ownership enforced by Convex. Pro buys capacity, not a stronger trust boundary.
3. Dedicated/private/self-hosted: secure by default, but honestly labeled as shared-password mode unless configured with Convex/device-signature validation. A single `RELAY_PASSWORD` must never be sold or surfaced as equivalent to the official multi-tenant model.
4. All surfaces: password failure must render as a named route-to-fix, not as generic unreachable/Unauthorized/Connecting.

## Current Architecture From Code

### Official Public-Free Relay

The production systemd unit sets `YAVER_RELAY_OFFICIAL=1`, points `CONVEX_URL` at production Convex, and configures the official expose domain. That means registration and `/d/<deviceId>` proxy auth use Convex-backed validation, not only the shared `RELAY_PASSWORD`.

Relevant code:

- `relay/deploy/yaver-relay.service:17-23`
- `relay/server.go:633-683`
- `backend/convex/userSettings.ts:1270-1354`

The public relay validates:

- `action=register`: relay password belongs to the same user as the agent token, and an existing `deviceId` row must belong to that user.
- `action=proxy`: relay password owner must own the target device row.

This is the correct public-free security boundary. The password is still a per-user bearer secret, but Convex scopes it to account/device ownership.

### Relay Pro / Managed Shared Hosts

Relay Pro is explicitly pooled: `RELAY_TENANTS_PER_HOST` defaults to 20, and rows are grouped by `sharedHostKey`.

Relevant code:

- `backend/convex/relayPool.ts:4-28`
- `backend/convex/schema.ts:1336-1379`
- `backend/convex/provisionRelay.ts:73-87`

The design note says sharing is safe because relay hosts are pass-through and cross-tenant bridging is refused in Convex. That is true only if managed relay hosts are also configured with Convex validation. The provisioning cloud-init currently injects only `RELAY_PASSWORD=${args.password}` into the relay container; no `CONVEX_URL` is visible in that generated compose fragment.

Relevant code:

- `backend/convex/provisionRelay.ts:138-151`

If a Relay Pro shared host runs in shared-password-only mode, then the multi-tenant safety story depends on each tenant having a distinct managed relay password and the relay accepting all of them somehow. The relay binary without `CONVEX_URL` only has one in-memory shared password. That is a serious audit point: either the deployed image/entrypoint supplies Convex validation elsewhere, or pooled Relay Pro provisioning as shown cannot safely support multiple tenant passwords on one host.

### Dedicated / Private / Self-Hosted Relay

Self-hosted install paths use shared-password mode. The public one-line installer writes `RELAY_PASSWORD` into Docker Compose and does not configure Convex validation.

Relevant code:

- `web/public/install-relay.sh:124-139`
- `relay/.env.example:1-4`
- `relay/server.go:642-653`

That mode is fine for a single-owner private relay, but it is not equivalent to public-free/managed multi-tenant security. In shared-password-only mode, any holder of the relay password can register any deviceId unless the local agent-side bearer token blocks the later operation. The relay cannot know account ownership because there is no Convex validation path.

## Security Findings

### P0: Confirm Relay Pro Shared Hosts Actually Use Convex Validation

The schema and pool code sell Relay Pro as shared multi-tenant infrastructure. The provisioning code shown for Relay Pro starts a relay container with only `RELAY_PASSWORD=${args.password}`. In the relay code, `convexURL == ""` means shared-password mode.

Impact: if this is the live deployment shape, a pooled shared host cannot safely serve multiple tenants with distinct row passwords, and the documented "Convex blocks cross-tenant bridging" invariant is not actually active on that host.

Required product fix:

- Managed/shared Relay Pro hosts must set `CONVEX_URL` and validate against Convex like public-free.
- Health check should fail if `sharedHostKey` is present and `/selftest` or `/admin/status` reports shared-password-only mode.
- Add a deploy/provisioning test that greps generated cloud-init for `CONVEX_URL` when `sharedHostKey` is used.

### P0: Passwords Are Stored Plaintext In Convex Tables

`userSettings.relayPassword` and `managedRelays.password` are plaintext indexed secrets.

Relevant code:

- `backend/convex/schema.ts:932-943`
- `backend/convex/schema.ts:1179-1180`
- `backend/convex/schema.ts:1368-1371`
- Existing doc acknowledgement: `docs/architecture/cloud-secrets-and-env.md:101-105`

Impact: Convex DB read access implies relay access. The relay password is not supposed to authorize final agent operations, but it still controls reachability, registration, preview, bus, and some recovery paths. It is enough to cause outages or attempt traffic steering in shared-password deployments.

Required product fix:

- Short term: hash-at-rest for validation rows plus a separate delivery envelope for clients that legitimately need the secret.
- Better: eliminate password delivery for proxy auth by cutting over to per-device signatures.
- Keep plaintext only where a process must launch a private relay with that password; encrypt it with a service key, not table plaintext.

### P1: WebSocket Fallback Does Not Match QUIC Same-User Reconnect Semantics

QUIC registration has same-user last-writer-wins eviction.

Relevant code:

- `relay/server.go:1200-1222`

The WebSocket fallback path still rejects duplicate live registrations whenever the existing tunnel appears alive.

Relevant code:

- `relay/server.go:1436-1458`

Impact: the exact stale-registration black hole fixed for QUIC can still exist on the fallback path used when UDP/QUIC is unavailable or blocked. This violates cross-surface/cross-transport parity.

Required product fix:

- Apply the same same-user eviction logic to the WebSocket registration path.
- Add a regression test mirroring the QUIC same-user reconnect test for WebSocket fallback.

### P1: Relay Passwords Still Travel In Query Strings For Browser-Only Streams

The web client appends `__rp=<relayPassword>` to stream/media URLs because `EventSource`, `<img>`, and browser asset requests cannot set custom headers.

Relevant code:

- `web/lib/agent-client.ts:3750-3794`
- `web/lib/agent-client.ts:5847-5875`
- `relay/server.go:1853-1861`
- `relay/server.go:1972-1989`

The relay strips `__rp` before forwarding to the agent, which prevents downstream leakage, but the secret still appears in browser history/devtools, reverse-proxy access logs unless scrubbed, and any monitoring that records full URLs.

Required product fix:

- Prefer scoped webview cookies/session tokens for subresources wherever possible.
- For SSE, use same-origin proxy endpoints that inject auth server-side instead of putting `__rp` in the URL.
- Add nginx/logging tests or config checks that query args containing `__rp` and `token` are never logged.

### P1: Shared `RELAY_PASSWORD` Is Reused As TURN Fallback Secret

TURN credential code falls back to `RELAY_PASSWORD` when `TURN_AUTH_SECRET` is absent.

Relevant code:

- `desktop/agent/turn_credentials.go:111-117`
- `desktop/agent/doctor_webrtc_ice.go:168-170`

Impact: one relay secret now spans relay registration/proxy and WebRTC TURN auth. A leak or rotation affects more product lanes than expected. Users experience it as "relay password issues" even when the failing operation is preview/WebRTC.

Required product fix:

- Require distinct `TURN_AUTH_SECRET` for production official and managed relays.
- Doctor should warn when TURN falls back to `RELAY_PASSWORD` outside local/dev.

### P1: Admin Compatibility Still Accepts Shared Relay Password

Admin/diagnostic endpoints accept `Authorization: Bearer RELAY_ADMIN_TOKEN`, but also accept `X-Relay-Password` if it matches the relay's own shared password.

Relevant code:

- `relay/server.go:369-418`

The code correctly refuses per-user Convex relay passwords for admin. Still, accepting the shared relay password as admin keeps one secret overpowered on private/self-hosted relays.

Required product fix:

- Make `RELAY_ADMIN_TOKEN` mandatory for official and managed relays.
- Keep shared-password admin only as explicit self-host compatibility with a startup warning.

## Robustness Findings

### R1: Password Repair Exists, But It Is Still A Reactive Loop

The web agent client has `repairRelayPassword()` and updates both active and cached relay passwords.

Relevant code:

- `web/lib/agent-client.ts:5878-5933`

The Go agent has a unified relay deny classifier and session-expired signal.

Relevant code:

- `desktop/agent/relay_deny_code.go:8-34`
- `desktop/agent/relay_auth_signal.go:5-30`

This is good, but the product is still reacting to a password failure after a user-visible connection failure. The better behavior is proactive:

- Fetch/refresh relay creds on sign-in, token rotation, settings change, and before tunnel registration.
- Include relay credential generation/version in settings so clients can detect stale local state without waiting for a 401.
- Record `relayCredentialState` in heartbeat/device rows so surfaces can show "refreshing relay credential" instead of "unreachable".

### R2: Stable Deny Codes Are Good, But Registration Rejects Still Use Prose

HTTP `/d/` failures use stable JSON `code` values.

Relevant code:

- `relay/abuse_guard.go:439-498`
- `relay/server.go:1903-1923`
- `relay/server.go:2041-2049`

QUIC/WS registration failures still return `RegisterResp{Message: "...prose..."}` with no structured reason field.

Relevant code:

- `relay/protocol.go:31-40`
- `relay/server.go:1071-1078`
- `relay/server.go:1128-1156`

Impact: the most important failure for agent reachability still relies on string matching. The code has improved prose with `reason=...`, but the wire type should carry `code` too.

Required product fix:

- Add `Code string json:"code,omitempty"` to `RegisterResp`.
- Populate `relay_password_missing`, `relay_password_invalid`, `relay_session_expired`, `relay_device_mismatch`, `relay_auth_backend_unavailable`, `relay_device_already_registered`.
- Keep existing `Message` for old clients.

### R3: Public-Free Has One Logical Relay First In Platform Settings

Settings seeding reads the first relay server from `platformConfig.relay_servers`.

Relevant code:

- `backend/convex/userSettings.ts:1084-1099`
- `backend/convex/userSettings.ts:1209-1223`

Impact: if platform config contains only one usable relay, password/auth bugs and regional outages collapse the product to "all relay(s) failed". Multi-home support exists elsewhere, but the credential seeding/repair path must preserve multiple relays with per-relay credentials and health.

Required product fix:

- Platform config should publish at least two public-free relays per region group.
- Repair should refresh all active relay credentials, not only the first default URL.
- The agent/mobile ladder should race healthy candidates and report `all N relays failed` with per-candidate structured reasons.

### R4: Private Relay Install Defaults Are Too Easy To Mis-Secure

The public installer accepts `--password my-secret`, writes it into compose, starts Watchtower, and sets up nginx. It does not generate a strong password by default, require `RELAY_ADMIN_TOKEN`, configure SPKI pin publication, or configure Convex validation.

Relevant code:

- `web/public/install-relay.sh:40-75`
- `web/public/install-relay.sh:124-139`

Required product fix:

- Generate a strong password by default; let explicit `--password` be advanced/manual.
- Generate separate `RELAY_ADMIN_TOKEN`.
- Print/copy an SPKI pin for agents to pin.
- Label mode clearly: "private single-owner shared-password relay" unless `CONVEX_URL` is configured.

## What Is Already Good

- DeviceId shape validation and reserved subdomain checks exist.
- Public relay validates account/device ownership through Convex.
- Proxy path has an ownership backstop even after exact tunnel lookup.
- Invalid auth rate limiting exists.
- Password rotation clears caches and disconnects tunnels.
- Per-device signature auth has replay protection and failure telemetry.
- Web/mobile relay deny classifiers have parity tests.
- HTTP failures now carry stable codes and avoid conflating auth backend outage with bad password.

## Recommended Hardening Plan

1. Verify live Relay Pro/shared-host environment. Confirm every pooled host runs with `CONVEX_URL`; if not, fix provisioning before selling/expanding Relay Pro.
2. Add structured `RegisterResp.Code` and consume it in Go/mobile/web. Keep prose for backwards compatibility.
3. Port QUIC same-user eviction to WebSocket fallback and add parity tests.
4. Make official/managed relays require `RELAY_ADMIN_TOKEN`; demote admin-by-relay-password to self-host compatibility.
5. Replace `__rp` query auth for web streams with same-origin proxy or scoped relay cookies.
6. Split `TURN_AUTH_SECRET` from `RELAY_PASSWORD` in production and doctor the unsafe fallback.
7. Move toward passwordless proxy auth: use `/authmix` as the cutover gate, fix signature failures until `safeToCutOver` is true, then disable password proxy auth on public-free first.
8. Hash/encrypt relay secrets at rest in Convex and add rotation generations so stale clients can detect drift before a failed operation.
9. Make public-free multi-relay by default and make repair refresh the full relay set.

## Tests To Add

- Relay Pro provisioning test: shared host cloud-init must include `CONVEX_URL`; private dedicated self-host may omit it.
- WebSocket fallback same-user reconnect test.
- Register response structured-code test for missing password, bad password, dead token, device mismatch, backend unavailable, duplicate registration.
- Log-scrub test for `__rp` and `token` in nginx/relay access logs.
- TURN production config test: official/managed relay startup fails or warns loudly when `TURN_AUTH_SECRET` is absent and TURN is enabled.
- Public/private mode selftest: relay reports `authMode: convex-scoped | shared-password`, `adminAuth: bearer | relay-password-compat`, and `signatureProxyAuth: enabled`.

## Bottom Line

Public-free relay is close to the right model: Convex-scoped per-user fallback plus device signatures. Private/self-hosted relay is still shared-password mode and must be labeled and hardened as such. Relay Pro/shared managed hosts are the highest-risk ambiguity: the architecture requires Convex-scoped validation, but the visible provisioning fragment only injects one shared `RELAY_PASSWORD`. Confirm and fix that first.

The product should stop treating relay password repair as a normal connectivity step. Relay passwords should become a temporary compatibility bridge, measured by `/authmix`, while device signatures and structured registration codes become the real secure and robust path.
