# Handoff — remaining development + test work (session 2026-08-03)

Everything below is **open**. Landed work is in the four commits listed at the
bottom; this file is only what is NOT done.

Two audits written this session are the evidence base for most of it:
* `docs/audits/reason-code-wiring-audit-2026-08-03.md` — 2 of 31 reason codes wired
* `docs/audits/failure-plumbing-measured-2026-08-03.md` — layer D exists once in 1764 error replies

---

## P0 — in the user's way right now

### 1. Preview session is a singleton with no takeover route
**Measured:** after one surface opens a project, every other surface gets
`Preview unavailable · preview session for project "sfmg" already active; stop
it first` — with a **`Try again`** button that can never succeed while the lock
is held. Observed on tvOS AND visionOS in the same run. It also blocks the
all-surfaces loop (worked around in the runner, not in the product).

**Why it is a four-layer failure, precisely:**
- `desktop/agent/vibe_preview.go:349` — throws a bare `fmt.Errorf` string
- `desktop/agent/vibe_preview_http.go:50` — re-derives its own category with
  `strings.Contains(msg, "already active")`; the agent prose-matches itself
- the 409 body is `jsonError(w, 409, msg)` — **no `code`, no `remedy`**
- `POST /vibing/preview/stop` **already exists**, and every client already
  wraps it: `mobile/src/lib/vibePreview.ts:153`,
  `web/lib/agent-client.ts:5281`, `tvos/YaverTV/AgentClient.swift:354`

**Fix:** typed error with `code: "PREVIEW_SESSION_ACTIVE"` + `remedy:
"stop-preview"` + the owning project/surface; emit those fields and delete the
`strings.Contains` switch; surfaces render **"Stop it and take over"** wired to
the existing `stopPreview()`, and **suppress "Try again"**.

> **General rule this session kept re-deriving: never offer an action that
> cannot succeed.** A dead retry button converts a one-tap fix into an infinite
> loop and teaches the user the product is broken rather than busy.

### 2. Emit `capability.toolchain_missing`
**Six** client files already render it. **Zero** emitters, agent or backend.
This reframes the documented Flutter incident (CLAUDE.md's worked example): it
was never a UI gap — six surfaces were waiting for a message nothing sends.
One emitter closes it. Cheapest user-visible win in the repo.

---

## P1 — unblocks all automated surface testing

### 3. Code-based sign-in on the phone  *(blocks #5, #6)*
`backend/convex/deviceCode.ts` ships the whole flow and **six** live HTTP
routes: `/auth/device-code/{authorize,broker,poll,claim,events,pending}`.
`mobile/app/login.tsx` has **no code-entry path** — OAuth/passkey/email only.

Consequences: no way to hand a session to a new phone or simulator without an
interactive browser round-trip; every automated iOS/Android arc dies at
sign-in; and a real user moving to a new phone hits the same wall with a
working mechanism sitting unused behind it.

Contracts: `POST /auth/device-code/broker` (authenticated, mints a
pre-authorized code) → `GET /auth/device-code/poll?device_code=<secret>` →
`saveToken()`/`saveUser()` at `mobile/src/lib/auth.ts:61,91`.
Note `poll`/`claim` key off the **secret** `deviceCode`, not the short user
code — so the phone must create and hold it, not just accept a typed code.

Once built, the loop closes with no human in it: the simulator shows the short
code, the Vision oracle OCRs it, the agent's session authorizes it.

### 4. Make `remedy` a typed route, not a string
Only **1** of 4 current uses is invocable (`stream-over-webrtc`); the other
three are English prose in a field whose name promises a route. Prose in
`remedy` is worse than none — it looks structured, so layer D gets ticked off
in review while the surface still has nothing to render as a button.

---

## P2 — closed-loop tests still owed

### 5. iOS simulator arc → a real verdict
`e2e/ios-sim-preview-narration.mjs` drives the compiled app and reads text off
the simulator screen. Blocked only by sign-out (task 3). App is built and
installed on `iPhone 17 Pro` (`24B591E9-B94A-40CC-8C08-8CCD8EFB1EA2`).

### 6. Android emulator arc → a real verdict
`e2e/android-emu-vibe-loop.mjs`. Same blocker. Launch-frame triage is in, so it
now skips in ~20s instead of burning a 10-minute budget on a sign-in screen.

### 7. RN-web arc cannot open the fullscreen preview
`e2e/tests/sfmg-preview-narration.spec.ts` signs in against the box fine, but
"Open in Yaver" does not leave the Tasks tab. Unresolved whether
`<Modal presentationStyle="fullScreen">` + `react-native-webview` can present
under RN-web at all. **Determine which** — do not guess; if it cannot, mark the
arc native-only in the file.

### 8. `releasePreview()` ends in a 4-second sleep
`e2e/all-surfaces-sfmg-loop.mjs` — there is no verb answering "is the preview
released yet?". A question you can only answer by waiting is a missing
endpoint. Add an ops verb; the sleep is a placeholder.

### 9. Finish the all-surfaces run
Never completed end-to-end. Confirmed so far: `yaver/hermes-refusal` → PIXELS
(`code=YAVER_SELF_DEVELOPMENT_RECURSION · remedy=stream-over-webrtc`), and sfmg
genuinely loads (oracle read "Choose Your Language · Türkçe · English").
Budget must be ≥7 min/surface — 150s is not enough for a runner turn + rebuild.

### 10. Verify the four shipped UI fixes on a real screen
Build **501** carries them; they are unit-proven (30 checks) and **have never
been seen rendering**. Check, in order: sfmg preview shows
`Starting Metro Bundler · 1:24 elapsed · last output 3s ago` instead of black;
tapping `mobile` gives "Preview Yaver a Different Way" + a **Stream over
WebRTC** button; the mic overlays the running app instead of replacing it.

---

## P3 — from the audits, in dependency order

11. **Consume or delete the 7 emitted-but-unread codes.** A code sent into
    silence is indistinguishable from prose.
12. **Decide the 14 dead codes.** Five are `browser_window.chrome_*` — a real,
    frequently-hit family (snap-confined Chrome). Wire, don't delete.
13. **Then** remove the 6 client prose matchers in `mobile/`. **Not before** —
    deleting a regex whose replacement code is never emitted trades a wrong
    diagnosis for none.
14. **Audit the 814 `ok:true` replies** for operations that did not happen.
    Highest-risk pass in the repo: a false green is invisible by construction.
    CLAUDE.md already names two (`feedback_fix` with no task manager,
    `launch-feedback` with no DataChannel).

---

## P4 — carried from earlier, still open

15. **STT for developing third-party apps** inside Yaver (tvOS has none).
16. **Feedback SDK + dogfood-mode coverage** in the loops.
17. **Feedback SDK letting third-party apps develop themselves** via dogfood
    mode + browser lane (WebRTC or browser streaming).
18. **Relay / Relay Pro lane untested** from TV and AR/VR — every arc uses the
    tailnet address only.
19. **Runner edit strength varies run-to-run** — 1 red container vs 3.

---

## Environment traps worth not rediscovering

* **Seeding a token does not sign the app in.** `clearKeychainIfFreshInstall`
  treats a fresh browser profile as a fresh install and wipes it — the
  `yaver_installed` flag must go in with the token. This cost a debugging pass
  that wrongly concluded Convex had rejected the token.
* **`rg` mangles its own output in this environment** (`/dev/build-native`
  renders as `/dev/n`). It produced two confident, wrong audit claims before
  `grep` caught them. **Verify with `grep`.**
* **The mobile disk preflight is a stub on this Mac** —
  `~/.local/bin/mobile-cache-cleanup.sh` is three lines that exit 0 ("the real
  shared script lives on the Mac mini"). It passed at 10 GB free against a
  documented 20 GB minimum. Clear `~/Library/Developer/Xcode/DerivedData` by
  hand (~7.6 GB).
* **`expo run:ios` picks the `YaverWatch` scheme** unless you pass
  `--scheme Yaver`, then fails with "no available devices matched" because the
  watch scheme only offers watchOS destinations.
* **e2e arcs must run under `tsx`**, not bare `node` — they import
  `web/lib/*.ts` deliberately, so the shipping classifier is the one that
  judges. Bare `node` dies with `ERR_UNKNOWN_FILE_EXTENSION`.
* **The default e2e `global-setup` provisions a Convex dummy user that cannot
  be created** ("Email/password sign-in is not enabled for this email"), which
  killed every device arc before its first line. Use
  `e2e/playwright.device.config.ts`.

---

## Standing discipline (earned twice this session)

**Both arcs lied before they worked**, and the fixes are the real output:
* the web arc failed with "the surface said NOTHING — this is the build-500
  defect" while sitting on the Tasks tab, having never opened a preview;
* the native arc called a signed-out app "silent".

Both now require **positive proof of the state they are judging** and skip with
a named cause otherwise. **A false red is exactly as corrosive as a false
green.** Any new arc inherits that rule.

---

## Landed this session

| commit | |
|---|---|
| `bdaf1803a` | mobile: the 4 UI defects from build-500 screenshots |
| `4439cfda2` | tvOS: a client-side refusal is not a sleeping box |
| `6e30d7555` | security: a real machine address in 12 tracked files + measured guard |
| `32c44766a` | e2e: load and vibe a real project on every surface, sequentially |

**Build 501** uploaded to TestFlight carrying the four UI fixes.

**Not done, needs a decision:** the infra addresses scrubbed in `6e30d7555`
are still in already-pushed history. Not rewritten — public objects, and
rewriting shared history is its own hazard.
