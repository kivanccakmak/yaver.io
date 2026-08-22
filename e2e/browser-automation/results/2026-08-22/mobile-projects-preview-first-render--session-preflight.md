# Mobile Projects preview first-render truth and compact UI — session preflight

- Result ID: `2026-08-22-mobile-projects-preview-first-render-session-preflight`
- Case ID: `2026-08-22-mobile-projects-preview-first-render`
- Status: `blocked`
- Run at: `2026-08-22T06:30:00Z`
- Commit: `bc46336f0`
- Surface: `mobile-rn-web`
- Device: `iPhone 15 Pro`
- Profile: `browser-automation-2026-08-22`

## Headless result

- PASS: the measured local RN-web root answered HTTP 200 with HTML identifying
  the Yaver React Native/Expo app.

## Closed-loop result

- PIXELS: blocked pending the coordinated headed session.
- NAMED: the queued case names every expected terminal state and failure route.
- SILENT: not evaluated yet.

## Evidence

- Inline headless measurement only; no authenticated response body was stored.

## Failure and route to fix

- Cause: another browser arc must not be started until the shared queue and
  exclusive-session guard exist.
- Route: validate the queue, then start the single isolated session with
  `npm run browser-queue:open` from `e2e/`.
- Snowball follow-up: this dated case/result queue and launcher lock make the
  coordination rule executable rather than conversational.

## Notes

- This is a preflight record, not a closed-loop pass.
