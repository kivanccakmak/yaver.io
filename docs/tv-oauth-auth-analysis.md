# TV OAuth/Auth Analysis: Apple TV and Android TV

Date: 2026-07-25

This is a code-grounded analysis of how Yaver should let a user sign in on Apple TV and Android TV using the existing Yaver OAuth/account system. Markdown in this repo drifts; every claim below was checked against the current code paths named inline.

## Executive Summary

The most robust product shape is:

1. **Canonical TV login for both Apple TV and Android TV:** QR + short code device authorization, approved from the Yaver mobile app or a browser.
2. **No TV-native OAuth as the primary path:** native Apple sign-in and any future Android/Google native credential flow should be secondary escape hatches, not the first-class contract.
3. **No provider credentials on the TV remote:** Google, Microsoft, GitHub, GitLab, email, passkey, and TOTP should be completed on the phone/browser, then the TV receives only a Yaver session token.
4. **App-mediated approval first:** if the user has the Yaver mobile app installed, scanning the QR should deep-link into the app, preserve the TV code through any required login, and finish with one explicit approval. If the app is absent, the same URL should work in the browser.

This matches what Apple and Google recommend for limited-input devices. Apple specifically pushes tvOS sign-in through AuthenticationServices and iPhone/iPad-assisted authorization, and their tvOS guidance stresses a single clear sign-in entry with limited choices. Google documents OAuth for TVs and limited-input devices as a device-flow use case. The IETF device authorization grant is explicitly for devices that lack a browser or are input-constrained.

Current Yaver is directionally correct for a QR-first approach:

- `tvos/YaverTV/Views/SignInView.swift` currently leads with native Apple sign-in and shows QR/device-code fallback. This should be inverted.
- `mobile/app/tv-signin.tsx` uses QR/device-code for TV builds, currently labeling the non-iOS surface as Google TV.
- `backend/convex/deviceCode.ts` and `backend/convex/http.ts` provide the shared create/poll/info/authorize device-code contract.
- `mobile/app/approve-device.tsx` lets a signed-in phone approve a TV/headless-device sign-in and stashes the code across login if the phone starts signed out.

Main risks found before this implementation:

- The tvOS screen puts native Apple sign-in first, even though QR is the only flow that works for every existing Yaver OAuth/provider account. That is the main UX mismatch.
- The TV currently relies on periodic polling to learn that approval happened. Polling must remain as backup, but the robust path should be Convex-backed event/listen delivery with reconciliation.
- tvOS stores the Yaver bearer in `UserDefaults`, not Keychain.
- Device-code `pendingToken` is raw in Convex while waiting for the TV to poll.
- Device codes are about 25 bits of human-code entropy (`24^4 * 10^4`) and there is no obvious per-code/per-IP authorize rate limit in the route.
- Android TV has the right QR flow, but not the same polish/diagnostics as the native tvOS sign-in screen.
- If native Apple sign-in remains, it does **not pass a nonce** to `/auth/apple-native`; backend nonce validation is optional, so replay resistance depends only on Apple's JWT expiry/audience/signature.

## Implementation Status: 2026-07-25

The main QR-first fixes from this analysis are now coded:

- tvOS sign-in is QR-first. Native Apple sign-in remains as a secondary option below the QR.
- tvOS stores the Yaver session in Keychain through `tvos/YaverTV/TokenStore.swift`, with migration from the older `UserDefaults` token.
- TV device-code approval is now event-first with polling backup. Backend route: `GET /auth/device-code/events?device_code=...`.
- Token delivery is now split from approval. Backend route: `POST /auth/device-code/claim`, and TV/mobile claim the token after the non-secret authorization event.
- Normal TV device-code approval no longer stores a raw bearer token in `deviceCodes.pendingToken`; it stores `approvedUserId` plus a one-time `claimHandle` and mints the session during claim. The old pending-token path is retained for broker/preauthorized compatibility.
- TV sessions can now be minted with `scope: "tv"` and `deviceId`, and `requireFullScope` denies TV-scoped tokens on account-level routes.
- The phone and web approval surfaces now distinguish "approved" from "claimed", so a phone/browser does not show final success while the TV is still waiting.
- Android TV / RN TV sign-in now uses the same event-first path, keeps polling as backup, and shows elapsed/expiry/network retry status.
- The mobile Settings device action is labeled as TV sign-in, pointing users to the existing in-app scanner path.
- `/auth/apple-native` now validates a supplied nonce, matching the nonce-bearing iOS path and allowing native clients to be hardened without another backend change.

Verification run locally:

- `cd backend/convex && npx tsc --noEmit -p tsconfig.json`
- `cd web && npx tsc --noEmit`
- `cd mobile && npx tsc --noEmit`
- `cd tvos && xcodegen generate`
- `cd tvos && xcodebuild -project YaverTV.xcodeproj -scheme YaverTV -destination 'generic/platform=tvOS Simulator' build`

## Current Implementation Map

### Shared Yaver Session Model

Yaver sessions are opaque 256-bit bearer tokens on clients and SHA-256 hashes in Convex sessions. Schema: `backend/convex/schema.ts:249`. A session has `tokenHash`, `userId`, optional `deviceId`, `expiresAt`, and optional scope metadata.

Session refresh extends by one year. Rotation is opt-in so old/mobile/TV clients are not stranded by a lost refresh response. See `backend/convex/auth.ts:1301` and the HTTP route at `backend/convex/http.ts:1891`.

Implication: a TV should hold a Yaver session token, not Apple/Google/GitHub provider tokens. That is already the architectural direction.

### Apple TV Native Sign-In, Reclassified as Secondary

The native tvOS app keeps `SignInWithAppleButton` as a secondary option below the QR flow in `tvos/YaverTV/Views/SignInView.swift`. It calls `AppleNativeAuth.completeSignIn`, which extracts Apple's identity token and posts it to `POST /auth/apple-native` in `tvos/YaverTV/AppleSignIn.swift`.

The backend route verifies Apple's identity token signature using Apple's JWKS, issuer `https://appleid.apple.com`, and Yaver's Apple audience. See `backend/convex/http.ts:1946`. It also rejects missing email/sub and unverified email claims.

This should be treated as a secondary login path only. It is not robust enough to be the default because it cannot sign into existing Google/Microsoft/GitHub/GitLab/email/passkey Yaver accounts and cannot complete Yaver TOTP gracefully on the TV.

Important caveat: the Swift tvOS path still needs a client-side nonce if native Apple sign-in is kept long term. The backend now validates `payload.nonce` when `body.nonce` is present, matching the nonce-bearing iOS React Native path.

### Universal TV Device-Code Fallback

Both TV surfaces use the same backend flow:

- `POST /auth/device-code` creates a short-lived code.
- `GET /auth/device-code/poll?device_code=...` lets the TV wait.
- `GET /auth/device-code/info?user_code=...` lets the phone/browser show what is being approved.
- `POST /auth/device-code/authorize` authorizes it using the approving user's Bearer token.

Code: `backend/convex/http.ts:5262`, `backend/convex/deviceCode.ts:29`.

The flow properties are good:

- device code TTL is 15 minutes: `backend/convex/deviceCode.ts:6`.
- machine-readable `deviceCode` is 40 hex chars: `backend/convex/deviceCode.ts:63`.
- human code avoids ambiguous `I`/`O`: `backend/convex/deviceCode.ts:10`.
- token retrieval is one-time; approval and claim are separate states, and `claimDeviceCode`/`pollDeviceCode` share the same consume path.
- authorization is internal-mutation gated by the HTTP route, which derives the user from the approving Bearer token: `backend/convex/deviceCode.ts:156`.

Before this change, the TV-side notification model was too thin for a product that "must simply work." The old TV clients polled:

- tvOS: `DeviceCodeAuth.poll` calls `/auth/device-code/poll` and `SignInView.startPolling` sleeps 5 seconds between checks.
- Android TV: `mobile/app/tv-signin.tsx` polls every 5 seconds.

Polling is still necessary as a fallback, but it is no longer the only approval signal. A TV can miss or delay the winning poll because of sleep, DNS failure, captive Wi-Fi, app lifecycle suspension, transient 5xx, clock skew around expiry, or a code row that flips to authorized and then is consumed/cleared by a duplicate poll path.

The mobile approval screen is also well-shaped:

- extracts QR/manual code and fetches public machine info: `mobile/src/lib/deviceCodeApprove.ts:48`.
- requires the phone's Yaver Bearer for approval: `mobile/src/lib/deviceCodeApprove.ts:94`.
- if the phone is signed out, it stashes the code and routes to login, then resumes approval: `mobile/app/approve-device.tsx:44`.
- uses biometric confirmation when available: `mobile/app/approve-device.tsx:92`.

### Android TV Path

The shared React Native app routes TV builds to `tv-signin`: `mobile/app/index.tsx:31`. `mobile/app/tv-signin.tsx` creates a code, displays QR + short code, polls every 5 seconds, logs in with the returned token, and routes to `tv-home`.

Android TV packaging exists through the Expo config plugin in `mobile/plugins/withAndroidTV.js`, with tests in `mobile/plugins/withAndroidTV.test.mjs`. The plugin adds leanback launcher support and marks touchscreen as not required.

This is the right MVP for Android TV. The risk is not conceptual; it is parity and polish. Android TV should get the same elapsed-time, expiry, unreachable-network, and provider-aware copy that native tvOS already has.

## Recommended Product UX

### First Screen

Recommended final TV sign-in UI for both platforms:

- Primary visual: large QR code.
- Primary instruction: "Scan with the Yaver app".
- Secondary instruction: "Or visit yaver.io/auth/device and enter ABCD-1234".
- Status line: elapsed time, code expiry, and network reachability.
- Approval copy on phone: "Sign this Apple TV / Google TV into <email>?"
- After approval: the TV signs in automatically and moves to the 10-foot home.

Apple TV:

- Make QR/device-code the lead path for consistency and because it works with every existing Yaver identity.
- If native Apple sign-in remains, place it as "Use Apple on this TV" below the QR, not as the only obvious path.
- Keep the QR visible while Apple sign-in is available.

Android TV:

- Primary screen: QR + code, with "Open Yaver on your phone or visit yaver.io/auth/device".
- Do not make Google OAuth-in-a-TV-browser the default. The user may have created the Yaver account with Apple, Microsoft, GitHub, GitLab, email, or passkey. The phone/browser approver preserves the existing account system.

Both:

- The TV should show elapsed time and code expiry.
- The TV should distinguish "waiting for approval" from "TV cannot reach Yaver".
- The approval phone should name the target: "Approve sign-in for Apple TV / Google TV".
- The approval phone should show the account email it is about to authorize.
- The result should be "TV signed in" and then the TV should auto-select the best live machine.

Secondary non-QR login:

- Apple TV may show "Use Apple on this TV" below the QR.
- Android TV may later show an equivalent platform credential button if it can produce a provider assertion without a fragile embedded browser.
- These buttons must never hide or replace the QR path.
- If a secondary provider flow would create a fresh empty Yaver account instead of opening the user's existing one, stop and point them to the QR path.

### QR as State Transfer, Not Just a Code

The QR should encode the durable state URL, not merely a decorative short code:

`https://yaver.io/auth/device?code=ABCD-1234`

That URL should behave identically in five cases:

- Opened by the Yaver mobile app through Universal Links/App Links: route to `approve-device`, preserve code if the user must log in first, then approve with the phone's existing/new session.
- Opened in a normal mobile/desktop browser: sign into Yaver with any existing provider, then approve the device code server-side.
- Opened by a signed-out Yaver mobile app: stash the code, open the normal mobile login screen, let native Apple / browser OAuth / passkey / email / TOTP finish, then reopen approval automatically.
- Opened by a signed-in browser: authorize the code immediately after confirmation; if the code is already in the URL, the web device page auto-authorizes once it has a valid token.
- Manually entered on the TV/phone: normalize `ABCD1234` and `ABCD-1234` to the same code.

Do not require the TV to know whether the user will use Apple, Google, Microsoft, GitHub, GitLab, email, passkey, or TOTP. The QR URL should carry only TV sign-in state; provider selection belongs on the phone/browser where it is ergonomic and already implemented.

The current code already has most of this:

- Mobile deep-link routing recognizes `https://yaver.io/auth/device?code=...` and `yaver://auth/device?code=...`: `mobile/src/lib/pairLinkHandler.tsx:23`.
- Signed-out mobile approval is stashed and resumed across login: `mobile/src/lib/pendingDeviceApproval.tsx:1`.
- OAuth callback resumes pending approval instead of dropping the code: `mobile/app/oauth-callback.tsx:55`.
- Web `/auth/device` builds OAuth URLs with `return=/auth/device?code=...`: `web/app/auth/device/DeviceCodeClient.tsx:215`.
- Web OAuth callback extracts the device code from `state.returnTo` and calls `/auth/device-code/authorize`: `web/app/api/auth/oauth/[provider]/callback/route.ts:303`.

So the implementation task is not to invent a new auth stack. It is to make this the visible, polished, tested default on both TV platforms.

## Target QR-First Flow

1. TV starts unauthenticated.
2. TV calls `POST /auth/device-code` with:
   - `machineName`: user-visible device name, for example "Living Room Apple TV" or "Google TV".
   - `platform`: `tvos` or `androidtv`.
   - `environment`: `tv`.
   - future `installId`: stable TV installation ID for device-bound session/revocation.
3. TV displays:
   - QR for `https://yaver.io/auth/device?code=ABCD-1234`.
   - Manual code `ABCD-1234`.
   - Expiry and retry state.
4. User scans:
   - If Yaver mobile app is installed, Universal/App Link opens `approve-device`.
   - If not, the browser opens the same page.
5. Approver:
   - If already signed in, show target details and approve.
   - If signed out, save the code, run existing OAuth/passkey/email/TOTP, then return to approval automatically.
6. Backend:
   - validates approving Yaver session,
   - authorizes exactly that code,
   - mints a TV-scoped, device-bound Yaver session,
   - emits an approval event on the device-code row/session channel,
   - makes the token available exactly once to the TV.
7. TV receives approval through the event channel, or through backup polling, stores the token in secure storage, validates, then enters `tv-home`.

This is the Netflix-style model: the TV is a display and poller; the phone/browser is where identity happens.

## Robust TV-Side Delivery: Event First, Poll Backup

The reliable design is a small state machine, with Convex as the source of truth:

| State | TV behavior | Backend truth |
|---|---|---|
| `created` | Show QR/code, connect event listener, start backup poll. | `deviceCodes.status = pending`, `expiresAt = now + 15m`. |
| `waiting` | Event listener open; poll every 5s as backup; show elapsed/expiry. | Pending row still valid. |
| `approved` | Stop waiting UI, exchange/consume token exactly once. | Row marked `authorized`, approved metadata recorded. |
| `claimed` | Store session, validate it, route home. | Raw pending token gone; session row exists. |
| `expired` | Generate a new code automatically; keep old status visible briefly. | Row expired or consumed. |
| `unreachable` | Keep QR visible; show retrying/network status. | Unknown from TV side; do not tell user approval is pending if network is down. |

Recommended backend contract:

- Keep `/auth/device-code/poll` as a low-tech backup.
- Add a listen endpoint for TV clients, for example `GET /auth/device-code/events?device_code=...`.
- The event endpoint can be SSE over Convex HTTP action, or a thin long-poll endpoint that returns immediately when the row changes. For tvOS/Android TV reliability, long-poll is often enough and simpler than a full native Convex client.
- Events must be non-secret until the TV proves possession of `deviceCode`. The event can say `authorized` and include a one-time `claimNonce`/`claimHandle`; the token should be fetched through a claim endpoint.
- Add `POST /auth/device-code/claim` with `{ deviceCode, claimHandle? }` and return the raw Yaver token exactly once. This lets the event stream avoid carrying the bearer token.
- Preserve current `/poll` semantics during migration, but make both `poll` and `claim` share one atomic consume path so duplicate listeners cannot race.

TV client behavior:

- Start event listener immediately after code creation.
- Also start backup polling on a jittered interval, not a synchronized global 5 seconds.
- On app foreground/resume, immediately reconcile by calling `/poll` or `/claim`.
- On network error, keep both mechanisms alive and show "Can't reach Yaver - retrying" plus elapsed time.
- If the user scans and approves but the TV does not move within 2-3 seconds, the phone/web approval screen should keep showing "Waiting for TV to pick up the session" and offer "Show new code" guidance only after the TV-side code expires or claim fails.

Why Convex helps:

- The approval is already represented in Convex (`deviceCodes.status` + `pendingToken`).
- Convex is reachable by TV and phone without direct LAN/relay complexity.
- It gives one shared state machine for Apple TV, Android TV, CLI/headless, watch, and future surfaces.

The important invariant: **approval and token consumption are separate states**. A phone approving a code must not be considered complete until the TV has claimed and validated the session. Otherwise the phone says success while the TV still says waiting, which is exactly the failure mode users remember.

### Account-Fork Prevention

Yaver intentionally resolves identities by `(provider, providerId)` and not by email first. That is mostly right; silent cross-provider email merge is risky. But on a TV, a user who presses Apple sign-in while their account was created with Google can land in a brand-new empty account.

The tvOS fast path already tries to prevent this by checking `/auth/email-providers` before minting an Apple session. Keep that guard, but make it fail closed when the email is strongly available and the provider lookup endpoint is reachable. The current guard explicitly fails open on lookup failure.

The fallback QR path is the universal fix because it lets the user choose the original provider on the phone/browser.

## Security Risks and Fixes

### P0: Make QR/Device-Code the Canonical tvOS First Screen

Original issue: native tvOS visually led with Apple sign-in. That was elegant only for Apple-account users; it was not the robust universal login.

Implemented fix:

- Put the QR + code first on Apple TV, same as Android TV.
- Move native Apple sign-in below the QR as a secondary escape hatch, or remove it from TV entirely if product simplicity wins.
- Preserve provider-aware error copy: if Apple would fork the account, tell the user to scan the QR and use their existing provider.
- Add a screenshot/UI test or Swift-level state test that the QR route is present and usable on initial unauthenticated launch.

Why: QR/device-code is the only single flow that works for every existing Yaver account and both TV platforms.

### P0: Add Convex-Backed Event Listening, Keep Polling as Backup

Original issue: tvOS and Android TV depended on polling. This could fail silently or feel broken, especially when the approving phone said "done" but the TV had not observed the authorized state yet.

Fix:

- Add a TV listen path for device-code state changes.
- Implement atomic token claim separate from state notification.
- Keep polling as a fallback and reconciliation path.
- Add tests for:
  - approval event delivered before next poll,
  - event lost but backup poll succeeds,
  - duplicate event + poll racing consumes the token only once,
  - approved-but-unclaimed code expires safely,
  - phone/web approval does not show final success until the TV has claimed or the backend has at least recorded an authorized state with clear "waiting for TV" copy.

Why: "the phone approved it but the TV stayed stuck" is a false-green incident. The product needs a positive handoff state, not just independent optimistic UI on phone and TV.

### P0: Add Nonce to Native tvOS Apple Sign-In If It Remains

Current issue: native tvOS requests `.fullName` and `.email` but does not set `request.nonce`; `AppleNativeAuth.exchange` sends only `identityToken` and `fullName`. Backend nonce validation exists but is optional.

Fix:

- Generate a raw nonce in `SignInView` or `AppleSignIn`.
- SHA-256 it and set `ASAuthorizationAppleIDRequest.nonce`.
- Send the nonce value expected by the backend consistently. The iOS path currently sends the hashed nonce as `nonce`, and backend compares to `payload.nonce`.
- Add a backend regression test that `/auth/apple-native` rejects an otherwise valid identity token when a nonce is supplied and mismatched.

Why: Apple and OIDC guidance treat nonce as the replay/correlation defense for identity tokens. Signature/audience/expiry are necessary but not a substitute for binding the token to this sign-in attempt.

### P0: Store TV Bearer Tokens in Keychain, Not UserDefaults

Current issue: `YaverStore` persists `yaver.tv.token` in `@AppStorage`, which is UserDefaults. Machine list and selected box can remain in UserDefaults, but the bearer token should not.

Fix:

- Introduce a tiny tvOS `TokenStore` backed by Keychain Services.
- Keep `@AppStorage` only for non-secret UI state.
- On launch, migrate existing `yaver.tv.token` to Keychain and clear the UserDefaults key.

Why: the TV token is a full one-year Yaver session. `UserDefaults` is the wrong persistence tier for a bearer credential.

### P0: Rate-Limit Device-Code Authorization Attempts

Current issue: `userCode` has roughly 25 bits of entropy and `/auth/device-code/authorize` is authenticated but does not appear to have per-user/per-IP/per-code attempt throttling. A signed-in attacker cannot choose the victim user, but they can try to bind random visible/pending codes to their own account. The bigger risk is nuisance/phishing and accidental authorization confusion.

Fix:

- Add attempt counters to `deviceCodes`, or a separate short-lived attempt table keyed by normalized user code and requester.
- Lock a code after a small number of failed authorize attempts.
- Add route-level rate limiting on `info` and `authorize`.
- Consider making human codes 6 letters + 4 digits or adding a second confirmation phrase on the TV and phone.

Why: RFC 8628 calls out user-code brute forcing and recommends limits because the user code is intentionally short enough to type.

### P1: Avoid Raw Pending TV Tokens in Convex

Original issue: `deviceCodes.pendingToken` stored the raw Yaver bearer until poll retrieved it. This was short-lived and one-time, but violated the otherwise strong "sessions store hashes only" pattern.

Implemented fix:

- Normal approval now stores `authorized` plus a one-time claim handle, and the TV presents `deviceCode + claimHandle` to `/auth/device-code/claim`. The raw bearer is returned directly to the TV and is not stored as `pendingToken`.
- The existing `pendingToken` path remains only for broker/preauthorized compatibility and is consumed through the same one-time claim helper.

Why: a database/log leak during the 15-minute window currently yields a live one-year TV session.

### P1: Scope TV Sessions

Original issue: device-code approval created ordinary full sessions. A TV is a shared living-room surface and should not have the same authority as a phone/web owner session.

Implemented fix:

- Extend session scope beyond `full`/`machine` to include `tv`.
- Mint TV-created device-code sessions with `scope: "tv"`.
- Deny TV-scoped tokens in `requireFullScope`, matching the machine-token deny pattern for account-level routes.

Remaining work:

- Audit all TV runtime routes and explicitly document the allowed TV-scope surface: list own machines, connect to selected machine, runtime dashboards, and safe ops.

Why: if someone gets the TV token, the blast radius should be "operate this TV surface" rather than "full account".

### P1: Device-Bind TV Sessions

Original issue: the session minted by `authorizeDeviceCode` had no `deviceId`. That meant it was a generic surface token and could not be retired per-TV or reasoned about as a concrete device.

Implemented fix:

- `POST /auth/device-code` accepts `deviceId`.
- Claim-time session minting stores `deviceId` on the session.

Remaining work:

- Have Apple TV / Android TV generate and persist a stable installation ID.
- Show TVs in the account devices/session list with revoke controls.

Why: family TVs need revocation and visibility. "Sign out everywhere" is too broad; "revoke Living Room Apple TV" is the correct control.

### P1: Android TV and tvOS QR UX Parity

Original issue: `mobile/app/tv-signin.tsx` was simpler than native tvOS. It did not show elapsed time, expires-in, detailed network failure, or a retry button. Poll errors were silently ignored. If Apple TV moves to QR-first, both platforms should share the same state model even if the implementations stay SwiftUI and React Native.

Implemented fix:

- Port the tvOS sign-in state model to RN TV: elapsed clock, expires-in, unreachable reason, event-first wait, backup polling.
- Move tvOS layout to QR-first while keeping the richer status treatment.

Remaining work:

- Add explicit retry/regenerate controls.
- Keep D-pad focus stable.
- Use a large QR, short steps, and no touch-only controls.

Why: a TV wait screen with no clock and no network diagnosis reads as frozen.

### P1: Force QR Scanning Inside the Yaver Mobile App

Current issue: scanning with the system camera depends on Universal Links/App Links being correctly installed and associated. It is great when it works, but it is not the only robust path.

Fix:

- Add a prominent "Sign in a TV" action in the Yaver mobile app that opens the existing `DeviceCodeScanner`.
- Let the user scan the TV QR from inside Yaver, then route to `approve-device`.
- Keep manual code entry on the same screen.
- Keep system-camera scanning working as a convenience path.

Why: app-internal scanning removes OS association drift from the core login path. The user intent is also clearer: they opened Yaver to sign in a TV.

### P2: Web OAuth Hardening for Existing Providers

Current issue: web OAuth uses signed state and server-side code exchange, which is good, but does not show PKCE in `buildAuthorizationUrl` or `exchangeCodeForTokens`.

Fix:

- Add PKCE for Google/Microsoft/GitLab and any provider that supports it.
- For Apple web OAuth, add nonce to the authorization request and validate the ID token nonce on callback.
- Continue verifying OIDC ID tokens server-side for Apple/Microsoft and verified email status for providers.

Why: OAuth 2.0 current best practice has moved toward authorization code + PKCE even beyond pure public clients. This is especially useful for mobile/deep-link and browser-mediated flows.

### P2: Make Apple Account Event Notifications Useful

Current issue: `/auth/apple-notifications` logs the request and returns 200.

Fix:

- Verify Apple server notifications.
- On revoke/delete/credential state changes, mark Apple identity/session state accordingly and notify the user.

Why: Apple expects apps to handle account changes. Today the endpoint is effectively a placeholder.

## Recommended Flow Matrix

| Surface | Existing-provider login | Best primary flow | Fallback |
|---|---|---|---|
| Apple TV, any Yaver account provider | Existing OAuth via Yaver app/browser | QR to `yaver.io/auth/device?code=...`; phone/browser signs in with existing provider and approves | Manual short code; secondary native Apple only if retained |
| Apple TV, Yaver TOTP enabled | Existing OAuth plus TOTP on phone/browser | QR/device-code | Manual short code |
| Android TV / Google TV | Any existing provider | QR/device-code approved by Yaver mobile app or browser | Manual short code |

## Implementation Order

1. Make Apple TV QR-first and demote/remove native Apple as a primary path.
2. Add Convex-backed event listening for device-code authorization, with polling as backup.
3. Split approval from token claim so phone/web success cannot race the TV.
4. Move tvOS token persistence from `UserDefaults` to Keychain with migration.
5. Add device-code authorize/info rate limits and failed-attempt lockout.
6. Add `tv` session scope and device-bound TV sessions.
7. Add first-class in-app "Sign in a TV" scanner on mobile.
8. Bring Android TV QR UI to tvOS parity.
9. Reduce raw-token exposure in `deviceCodes.pendingToken`.
10. If native Apple sign-in remains, add nonce and test backend mismatch rejection.
11. Add PKCE/nonce hardening to web OAuth callbacks.
12. Verify and act on Apple account notifications.

## Sources

- Apple Developer, "Simplifying User Authentication in a tvOS App": https://developer.apple.com/documentation/authenticationservices/simplifying-user-authentication-in-a-tvos-app
- Apple WWDC21, "Simplify sign in for your tvOS apps": https://developer.apple.com/videos/play/wwdc2021/10279/
- Apple Developer, "Authenticating users with Sign in with Apple": https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple
- Apple Developer, "Verifying a user": https://developer.apple.com/documentation/signinwithapple/verifying-a-user
- Apple Developer, "Sign in with Apple REST API": https://developer.apple.com/documentation/signinwithapplerestapi
- Google Identity, "OAuth 2.0 for TV and Limited-Input Device Applications": https://developers.google.com/identity/protocols/oauth2/limited-input-device
- Google Identity, "Sign-In on TVs and Limited Input Devices": https://developers.google.com/identity/gsi/web/guides/devices
- IETF RFC 8628, "OAuth 2.0 Device Authorization Grant": https://datatracker.ietf.org/doc/html/rfc8628
- IETF RFC 9700, "Best Current Practice for OAuth 2.0 Security": https://datatracker.ietf.org/doc/rfc9700/
