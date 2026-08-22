# Mobile Projects preview first-render truth and compact UI

- Case ID: `2026-08-22-mobile-projects-preview-first-render`
- Status: `queued`
- Added: `2026-08-22`
- Surface: `mobile-rn-web`
- Target: `Projects filters, preview launcher, logs, and first paint`
- Device: `iPhone 15 Pro`
- Exclusive resources: `one browser-preview/dev-server session`

## Headless prerequisite

- The RN-web root answers HTTP 200 and identifies itself as the Yaver Expo app.
- The focused mobile preview and project-filter tests pass before the browser
  arc begins.

## Preconditions

- `MOBILE_WEB_URL` points to the measured RN-web target.
- A dedicated authenticated browser-test profile is available; no credential
  value is written to this file or browser logs.
- A reachable test runner exposes at least one generic RN/Expo project.

## Browser arc

1. Open Projects through the real mobile navigation.
2. Select the Mobile, Web, and Other filter chips using
   `projects-filter-mobile`, `projects-filter-web`, and
   `projects-filter-other`.
3. Start Browser Reload on a generic RN/Expo project, then use
   `projects-open-in-yaver` to enter preview.
4. Observe the cold first compile until the phone paints real project content
   or reports a named failure.
5. Open Preview logs, close it, and repeat once after a failed-resource event.
6. Return to Projects and inspect the running-preview card.
7. Open the reload chooser again and inspect the Hermes Reload description.

## Assertions

- PIXELS: every selected project-filter outline is fully visible and not
  clipped at the horizontal scroll edge.
- PIXELS: `Open in Yaver` is a compact primary action and does not consume the
  full card width beside Stop.
- PIXELS: preview output appears in exactly one bordered log box. No duplicate
  loose log tail appears between the elapsed line and that box. Opening the
  Preview logs sheet hides the inline box and logs floating action; closing it
  restores one centered, aligned box.
- NAMED: Hermes Reload is available for supported RN/Expo projects and politely
  explains that compiling the full native bundle takes longer; it never says
  Hermes support is coming soon.
- NAMED: Metro/server readiness is not reported as rendered. Success requires
  the phone-side paint probe to observe real content.
- NAMED: an initial entry-script failure before Metro finishes is retried once
  after readiness. If paint still fails, the surface says the app did not paint
  and offers the in-place Fix in Yaver route.
- SILENT: a permanent spinner, a green rendered state over an empty mount, raw
  authenticated URLs, duplicated logs, or a failure with no action fails the
  run.

## Negative control

- Force the phone paint probe to return `empty_mount`; verify the arc fails
  even when the server-side doctor reports rendered, then restore the probe.
- Disable the one-shot post-readiness retry; reproduce the cold first-load
  failure, then restore it and observe real content paint.

## Evidence requested

- One screenshot for each selected filter chip.
- Before/open/closed screenshots for the single-log-box invariant.
- A trace from cold Browser Reload through phone-side paint.
- A screenshot of compact Projects actions and the Hermes timing copy.

## Notes

- Use generic project labels in artifacts. Redact tokens and machine-specific
  paths before recording evidence.
