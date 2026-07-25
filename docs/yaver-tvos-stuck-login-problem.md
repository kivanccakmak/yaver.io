# tvOS stuck-login — QR sign-in never completes

Status: **fixed twice.** 2026-07-15 fixed the login screen; the bug shipped again
because the OTHER sign-in landing screen still dropped the code. 2026-07-25 made
it structural. Read "Second incident" before touching any sign-in path.

> **The 2026-07-15 entry below claimed "fixed" while the exact reported symptom
> was still reproducible on build 469.** That is the more useful lesson here: a
> stash whose drain lives in ONE screen is not fixed, it is pending.

## Symptom (user repro)

> TV + phone both signed out. Opened the TV → it showed a QR. Scanned it with my
> phone camera → it opened the Yaver app → I signed in with Apple → the phone
> signed in, but the **Apple TV stayed stuck** on "Waiting for approval".

The phone ends up authenticated; the TV never does. The device code is never
approved.

## The real architecture (corrected)

The TV QR encodes `https://yaver.io/auth/device?code=XXXX-YYYY`
(`tvos/YaverTV/Backend.swift`). On iOS this is a universal link
(`web/public/.well-known/apple-app-site-association` maps `/auth/device*` to the
app).

The **canonical approver is `app/approve-device.tsx`** — scanner + biometric gate
+ machine info + type-the-code. It is reached via **`PairLinkHandler`**
(mounted in `app/_layout.tsx`), which catches `/auth/device?code=` and routes to
`/approve-device`. (My first pass wrongly added a second approver at
`app/auth/device.tsx`; that's now a thin redirect to the canonical screen, kept
only so a COLD-START universal link has a route to render instead of falling
back to the Tasks tab.)

## Root cause

`approve-device.tsx` assumed the phone was **already signed in** — it called
`approveDeviceCode(code, token ?? "")`. When the user scanned while signed out,
the token was empty, so:

- the auth flow sent them to `/login`, and
- the `?code=` was **discarded** during sign-in (nothing stashed it), so the
  approval never happened and the TV polled `pending` forever.

## The fix (implemented)

1. **Stash the code across sign-in.** `app/approve-device.tsx`: when there's a
   valid code but no `user`, write it to `PENDING_DEVICE_CODE_KEY`
   (`src/lib/auth.ts`) and `router.replace("/login")` instead of failing.
2. **Resume after login.** `app/login.tsx` now routes every successful sign-in
   through `finishLogin()`, which reads the stashed code and returns to
   `/approve-device?code=…` (else goes home). One tap (biometric) finishes it and
   the TV signs in within ~5s.
3. **Cold-start route.** `app/auth/device.tsx` is a thin `<Redirect>` to
   `/approve-device`, so the universal link never dead-ends on Tasks.
4. **In-app scanner entry** (case 3 below). Settings → **Sign in a device** opens
   `approve-device`, which already had "Scan QR instead" (`DeviceCodeScanner`) +
   type-the-code. An already-signed-in user can now scan a TV code from inside
   the app without leaving it.

## Three cases, all now covered

1. Signed-out phone, scan QR → sign in → **approval auto-resumes**. (Was stuck.)
2. Signed-in phone, scan QR with the camera → approver opens → one tap. (Worked;
   unchanged.)
3. Signed-in phone, scan from **inside** the app → Settings → Sign in a device →
   scan. (New entry point; scanner already existed.)

## Files

| Concern | File |
|---|---|
| Canonical approver (scanner, biometric, signed-out fix) | `mobile/app/approve-device.tsx` |
| Deep-link router → approver | `mobile/src/lib/pairLinkHandler.tsx` (mounted in `app/_layout.tsx`) |
| Cold-start redirect | `mobile/app/auth/device.tsx` |
| Resume-after-login | `mobile/app/login.tsx` `finishLogin()` |
| Shared stash key | `mobile/src/lib/auth.ts` `PENDING_DEVICE_CODE_KEY` |
| In-app scanner entry | `mobile/app/(tabs)/settings.tsx` → "Sign in a device" |
| QR scanner component (pre-existing) | `mobile/src/components/DeviceCodeScanner.tsx` |
| Approve/info/poll endpoints | `backend/convex/http.ts` `/auth/device-code/*` |

## The TV side is not the bug

`tvOS SignInView` polls every 5s and signs in the moment the code is approved
(verified by approving codes by hand — the TV picked them up in ~5s each time).
No tvOS change was needed; the fix is entirely in the mobile app.

## Ships in

The next **mobile** TestFlight build. Until then, a stuck code can be approved
out-of-band by any signed-in surface hitting `POST /auth/device-code/authorize`
with `{userCode}`.

---

# Second incident — 2026-07-25 (same symptom, different screen)

Reported verbatim: *"scanned the code from the camera, it routed me to the Yaver
mobile app, I logged in with Apple OAuth, but this screen stuck at tvOS"* — on
mobile build 469, i.e. **with the 2026-07-15 fix installed**.

## Evidence, not inference

Convex prod, `deviceCodes` table, while the TV still showed the code:

```
userCode "DUBZ-2698"  environment "tv"  platform "tvos"  status "pending"
```

`pending` means the phone never called `authorize` at all. Nothing was wrong
with the TV, the relay, or the backend.

## Root cause

The drain lived **only** in `app/login.tsx::finishLogin`. But a browser OAuth
sign-in on iOS does not finish in the login screen — it finishes in
**`app/oauth-callback.tsx`**, whose own header calls it *"the canonical
handler"*. That screen did:

```ts
await login(token);
router.replace("/");     // ← the stashed device code dies here
```

So the 2026-07-15 fix covered native Apple / passkey / email sign-in and missed
the exact path the user took. `app/two-factor-challenge.tsx` had the same hole.

## The structural fix (so there is no third incident)

| Change | File |
|---|---|
| Stash rules + 15-min TTL, RN-free and unit-tested | `mobile/src/lib/pendingDeviceCode.ts` |
| ONE store/read/clear/resume implementation | `mobile/src/lib/pendingDeviceApproval.tsx` |
| Backstop host: resumes on ANY auth transition, whatever screen signed in | `PendingDeviceApprovalHost`, mounted in `app/_layout.tsx` |
| Drain called from all three landings | `login.tsx`, `oauth-callback.tsx`, `two-factor-challenge.tsx` |
| Stash cleared only AFTER the approval lands (or the user dismisses) | `app/approve-device.tsx` |
| Hydration guard — a signed-in phone opening the approver cold no longer gets ejected to /login | `app/approve-device.tsx` (`authLoading`) |
| Dead code → honest message + manual entry instead of a failing button | `app/approve-device.tsx` (`unknownCode`) |
| **Static guard test**: any screen with `await login(...)` must drain, or the build fails | `mobile/src/lib/pendingDeviceCodeLoginPaths.test.ts` |

Guard verified by breaking it: removing the `resumePendingDeviceApproval()` call
from `oauth-callback.tsx` makes the test fail with
*"calls await login() but never resumePendingDeviceApproval() — a scanned TV code
would be dropped here"*.

Run both tests with:

```bash
cd mobile
npx tsx src/lib/pendingDeviceCode.test.ts
npx tsx src/lib/pendingDeviceCodeLoginPaths.test.ts
```

## The TV screen was ALSO a defect (fixed here)

`tvos/YaverTV/Views/SignInView.swift` rendered a bare spinner + "Waiting for
approval…" for the full 15-minute code TTL. It could not distinguish "you haven't
approved yet" from "this TV cannot reach Convex", because
`DeviceCodeAuth.poll` mapped every transport failure to `.pending`
(`Backend.swift`). Now: `unreachableReason` is carried and shown verbatim, plus
`M:SS elapsed · code expires in M:SS`.
