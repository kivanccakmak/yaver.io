# Browser coordinator singleton — negative control

- Result ID: `2026-08-22-browser-coordinator-singleton-negative-control`
- Case ID: `2026-08-22-mobile-projects-preview-first-render`
- Status: `passed`
- Run at: `2026-08-22T06:46:00Z`
- Commit: `bc46336f0`
- Surface: `mobile-rn-web`
- Device: `iPhone 15 Pro`
- Profile: `browser-automation-2026-08-22`

## Headless result

- PASS: one coordinator process held the owner-only session lock.

## Closed-loop result

- PIXELS: the first headed session remained open throughout the check.
- NAMED: a second launch failed immediately with `another browser coordinator
  is active`.
- SILENT: PASS — no second Chromium context reached the shared preview.

## Evidence

- First session asserted a `393x659` iPhone 15 Pro viewport with touch enabled.
- Second launcher exited non-zero before opening the configured target.

## Failure and route to fix

- Cause: none; the negative control produced the intended failure.
- Route: stop the active coordinator with Ctrl-C before opening another.
- Snowball follow-up: retain the singleton assertion in the launcher and keep
  preview-driving suites at one worker.

## Notes

- No URL, credential, machine address, or absolute profile path was recorded.
