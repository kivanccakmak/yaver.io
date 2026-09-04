# Mobile Dogfood and TestFlight handoff — 2026-09-04

This is a point-in-time handoff. Code and executable tests remain the source of
truth if this document later drifts.

## Repository state

- Working branch: `main`
- Final commit: `38326e90bef2b9f649080bc79b01aa0dedfe329d`
- `HEAD`, local `main`, and `origin/main` matched at handoff (`0` ahead, `0`
  behind).
- The worktree was clean.
- No force push, reset, or destructive history rewrite was used.
- All pre-existing tracked and untracked work was checkpointed before rebasing.

Commits landed in this pass:

- `3c280df93` — `feat: expand app integration and phone install flows`
- `ea7a7b907` — `fix(dogfood): harden install and cross-surface validation`
- `38326e90b` — `chore(ios): record TestFlight build 202608181378`

## Product fixes landed

### Dogfood browser lane and white top/bottom bands

`mobile/app/attach.tsx` now gives safe-area ownership to the rendered browser
app exactly once:

- The native host no longer wraps the attached WebView in a second
  `SafeAreaView`.
- The WebView fills a theme-painted root view edge to edge.
- `automaticallyAdjustContentInsets={false}` and
  `contentInsetAdjustmentBehavior="never"` prevent iOS from inserting another
  viewport inset.
- `scalesPageToFit={false}`, disabled bounce/overscroll, and a translucent
  status bar preserve full-screen geometry.
- The installed app theme is injected into the browser copy so the status/home
  indicator regions and app pixels use the same appearance.
- Loading, reload, HTTP failure, guest-exception, escape, and route-to-fix states
  remain owned by the native host instead of being silently swallowed by the
  guest.

The executable regression contract is in
`mobile/src/lib/dogfoodSurfaceContract.test.mjs`. It explicitly fails if a
native `SafeAreaView` returns or the inset/theme properties disappear.

### Phone install and validation fixes

- Phone web publishing resolves its primary entity only from tables that
  actually exist and persists the resolved value.
- Enrollment codes now request six random hexadecimal characters; the previous
  three-character request could never pass its own minimum-length check.
- Mobile phone-project branding handles a missing template app safely.
- Web dashboard/spatial historical task responses are narrowed correctly.
- Web agent-status fixtures now match the current `ready`/`verified` contract.
- Web TypeScript accepts the repository's intentional `.ts` test imports.
- The shared Go test server uses bounded health probes and reports early start
  failures, avoiding a false failure under full-suite contention.

## Validation completed

- All mobile dogfood contract files passed (33 subtests in the pass); the
  focused surface contract was rerun at handoff and passed `17/17`.
- Mobile TypeScript completed with `npx tsc --noEmit`.
- Mobile LLM remote tests passed `7/7`.
- Web TypeScript completed cleanly.
- The web production build completed and generated 98 static pages.
- CLI tests passed `15/15`.
- A fresh Expo integration cleanroom passed install, SDK integration,
  typecheck, web export, idempotent rerun, and isolated MCP execution.
- Focused Go phone-install, enrollment, integration, OpenRouter, xctrace, and
  WebReload tests passed after the fixes.
- The full Go run reached one contention-sensitive test-server deadline; the
  harness was hardened and the affected WebReload group then passed.
- The iOS archive and export succeeded. The main app, Live Activity, share
  extension, and watch app bundle identifiers and versions were verified by the
  canonical deploy script.
- App Store Connect validation and upload both succeeded with no errors.

## TestFlight delivery

- Marketing version: `1.18.180`
- Build: `202608181378`
- Delivery UUID: `f0c38e9d-a741-4f55-9327-f10009f85368`
- Canonical command: `./deploy/deploy.sh ios`

The archive was produced from the same source tree already pointed to by pushed
`main`; only the local checkout label still named the preservation branch during
the archive. The build-number-only change was then committed, fast-forwarded to
`main`, and pushed. The primary workspace was switched to visible `main` before
handoff. Future builds should always start with the primary workspace visibly
on `main`, clean, fetched, and non-divergent.

## Deferred validation

No further builds or deployments should be inferred from this handoff. The
following work was explicitly deferred:

1. Install the uploaded TestFlight build on a real iPhone and inspect pixels in
   dark and light themes: status/Dynamic Island region, home-indicator region,
   first load, successful render, fast/full reload, HTTP failure, guest
   exception, and return-to-production.
2. Run RN-web in a Playwright context created from the full iPhone device
   descriptor and confirm the generated guest document includes the required
   `viewport-fit=cover` behavior. `MOBILE_WEB_URL` was not configured during
   this pass, so a truthful live RN-web pixel verdict was not available.
3. Finish the Android navigation-bar/edge-to-edge audit. The tracked Android
   theme explicitly colors the status bar but still needs a device-level check
   for the navigation/home region on supported Android versions.
4. Rerun the Android phone/tablet release APK validation and verify its upload
   certificate with `apksigner`. Do not submit it to Google Play from this lane.
5. Add or strengthen an Android disk-space preflight. The attempted
   `:app:assembleRelease` reached app C++ compilation and then failed with
   `No space left on device`; this was a machine-capacity failure, not a source,
   resource, or signing failure.
6. Confirm App Store Connect has finished processing build `202608181378`, then
   install it through TestFlight for the iPhone pixel arc above.

## Local cleanup and capacity

- Only reproducible generated artifacts were removed: Go/build caches, unused
  ignored JavaScript dependencies, completed Xcode archive/export/derived data,
  and failed Android build intermediates.
- No source, Git history, credentials, signing material, browser profile,
  Android SDK/NDK, or user data was removed.
- The Android SDK components Gradle legitimately installed remain available.
- The data volume had roughly 4 GiB free at handoff. Reclaim safe generated
  storage before another Xcode or Android native build.
