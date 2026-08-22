# Browser-lane first paint on phone and tablet

- Case ID: `2026-08-22-sfmg-phone-tablet-first-paint`
- Status: `queued`
- Added: `2026-08-22`
- Surface: `mobile-rn-web`
- Target: `Expo browser-lane wait narration and guest first paint`
- Device: `iPhone 15 Pro and iPad (gen 7)`
- Exclusive resources: `remote dev-server preview session`

## Headless prerequisite

- The selected agent must serve the scoped entry bundle as JavaScript and the client-paint probe must remain distinct from the box-side doctor verdict.

## Preconditions

- `MOBILE_WEB_URL`, `YAVER_TEST_TOKEN`, `VIBE_BOX_HOST`, and `VIBE_PROJECT_NAME` are set without recording their values.

## Browser arc

1. Open the real RN-web app in a complete phone descriptor, then repeat serially in the tablet descriptor.
2. Open the named browser preview action.
3. Observe wait narration and inspect the guest frame until `#root` owns a real child.

## Assertions

- PIXELS: real guest content paints in the preview frame on both device classes.
- NAMED: elapsed time and last-output narration appear while blank, then disappear after paint.
- SILENT: HTML/401 entry bundles, doctor-only rendered signals, empty `#root`, or a resized desktop context fail the run.

## Negative control

- Deny the scoped entry-bundle request and verify the HTTP asset guard fails immediately, then restore it.

## Evidence requested

- Phone and tablet Playwright videos, screenshots, and the redacted entry-bundle status.

## Notes

- This case is separate from the pre-existing phone-only incident case so no other thread's queue file is edited.
