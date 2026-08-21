# Optional authenticator 2FA audit — 2026-08-21

Code is authoritative. This audit names the implementation symbols and is
paired with `web/lib/totpSecurityParity.test.ts`; re-grep them before relying on
this document after later auth changes.

## Decision

Yaver supports optional RFC 6238 TOTP. This is the common six-digit,
30-second authenticator-app protocol, so it works with Google Authenticator,
Microsoft Authenticator, 1Password, Authy, and other compatible apps. Yaver
does not integrate with or call a Google/Microsoft API for code generation or
verification.

The feature is default-off. A user must explicitly select it in Settings,
scan/open the `otpauth://` enrollment value, and prove the first generated code
before `users.totpEnabled` becomes true. The signup invitation is unchecked by
default.

Prefer passkeys when available: TOTP is a useful second factor but is still
phishable. Passkeys are the stronger phishing-resistant option; TOTP remains
valuable for compatibility and offline code generation.

## Where users manage it

| Surface | Enrollment / management | Sign-in behavior |
| --- | --- | --- |
| Web | Account & Settings → Two-factor authentication; QR + manual key | `/auth/totp` accepts authenticator and one-time recovery codes |
| iOS / Android / RN-web | Settings → Security → Two-factor authentication; opens `otpauth://`, with copy fallback | `two-factor-challenge.tsx` |
| Desktop GUI | Settings → Security opens the account-security page | Native email login challenge accepts TOTP or recovery code |
| CLI / MCP | `yaver 2fa status|enable|disable`; `totp_*` tools | Browser OAuth completes through the same web challenge |
| tvOS / Android TV / visionOS | Management stays on phone/web (a QR/approval surface is already present) | Direct email/Apple login refuses a session on `requires2fa`; trusted-device approval is the recovery route |
| watchOS / Wear OS | Management stays on phone/web | Standalone mode uses device-code approval by an already authenticated owner; paired mode inherits the phone session |
| CarPlay / Android Auto | No independent account settings or token mint | Inherits the signed-in mobile app session |
| Browser AR/VR surfaces | Web account settings | Uses the web auth/TOTP route; native visionOS follows the tvOS shared client |

The constrained-surface design is intentional. Typing a 32-character recovery
code with a TV remote or watch crown is worse than handing the sign-in to an
already authenticated phone. Those surfaces must never turn inconvenience into
a bypass: the backend returns no session before either TOTP completion or an
explicit trusted-session device approval.

## Session-mint audit

Every first-factor path that can target an existing account must check
`totpEnabled` before creating a full session:

- email/password: `backend/convex/http.ts` `/auth/login`
- Google/Microsoft/Apple/GitHub/GitLab OAuth:
  `web/app/api/auth/oauth/[provider]/callback/route.ts`
- native Apple: `backend/convex/http.ts` `/auth/apple-native`
- passkey login: `backend/convex/passkeys.ts::loginFinish`
- generic enterprise OIDC: `backend/convex/http.ts` `/auth/oidc/callback`

The OIDC callback was a real bypass found in this audit: it minted a full
session immediately after OIDC userinfo. It now creates a pending TOTP
challenge and redirects through the same web verifier.

The other session creators are not fresh first-factor logins:

- device-code and QR approval transfer authority from an existing signed-in
  owner session;
- `/devices/register` rotates an authenticated device session;
- managed-machine provisioning creates a machine-scoped token;
- passkey signup creates a new user, which cannot already have TOTP;
- `/auth/create-session` is the internal-secret-gated half of the provider
  callback that performs the TOTP check before calling it.

## Security controls

- 160-bit random TOTP seed, SHA-1/6 digits/30 seconds, ±1 step compatibility.
- Successful time steps are stored in `totpLastUsedStep`; the same TOTP cannot
  create a second session or authorize a second destructive action.
- Five attempts per pending challenge, ten attempts per account per 15
  minutes, and 30 attempts per IP per 10 minutes.
- Failed-attempt mutations return a typed result instead of throwing after a
  patch. Convex rolls a mutation back on throw; the previous patch-then-throw
  code left the attempt count at zero and made the five-attempt guard false.
- Only one pending challenge row per account. Starting a replacement challenge
  deletes the prior row, so abandoned five-minute challenges cannot accumulate
  without bound.
- Eight 128-bit recovery codes are issued once and stored only as SHA-256
  hashes. Legacy ten-hex-character codes remain accepted until consumed.
- Disabling requires both an authenticated session and a current TOTP or one
  unused recovery code. This provides an actual lost-authenticator route;
  password reset and OAuth do not bypass TOTP.
- Enrollment and disable events are written to `securityEvents` without the
  seed or recovery-code material.

### Remaining hardening opportunity

`users.totpSecret` is currently stored as a recoverable base32 value in Convex.
That is necessary somewhere because a TOTP verifier shares the seed, but
application-layer AES-GCM envelope encryption would reduce the blast radius of
a database-only export. It requires a separately managed production key and a
careful online migration; it should not be faked with a key committed to this
public repository. A compromise of both runtime environment and database would
still expose the decrypted seed. Passkeys do not have this verifier-secret
property.

## Cost

There is no Google Authenticator or Microsoft Authenticator fee to Yaver. The
apps calculate codes locally and Yaver verifies RFC 6238 locally; no SMS,
email-code vendor, Microsoft Entra MFA license, Google Cloud API, or per-user
authenticator service is involved.

Incremental infrastructure use is small:

- enrollment: a few Convex reads/mutations and roughly 1 KB of persistent data;
- a protected new login: one pending row (bounded to one per account), one
  verification mutation, and the normal session row;
- each submitted code adds rate-limit bookkeeping I/O.

This can consume ordinary Convex quota, but there is no separate 2FA line item.
At the 2026-08-21 public Convex rates, Starter includes 1 million function calls
and lists $2.20 per additional million; database storage includes 0.5 GB and
lists $0.22 per additional GB. Even 100,000 protected sign-ins per month are
small compared with those units. Always re-check <https://www.convex.dev/pricing>
before budgeting because plan allowances change.

## Standards / vendor references

- RFC 6238: <https://www.rfc-editor.org/info/rfc6238/>
- NIST SP 800-63B-4 authenticator requirements:
  <https://pages.nist.gov/800-63-4/sp800-63b/authenticators/>
- Google Authenticator offline codes:
  <https://support.google.com/accounts/answer/1066447>
- Microsoft Authenticator non-Microsoft QR accounts:
  <https://support.microsoft.com/en-us/authenticator/how-to-add-your-accounts-to-microsoft-authenticator>

## Proof

Run:

```sh
node --experimental-strip-types web/lib/totpSecurityParity.test.ts
cd backend && npx tsc -p convex/tsconfig.json --noEmit
```

The parity test has an in-memory failure injection. This command must fail the
OIDC assertion without changing the working tree:

```sh
YAVER_BREAK_TOTP_GUARD=oidc node --experimental-strip-types web/lib/totpSecurityParity.test.ts
```

