# Browser queue validator — negative control

- Result ID: `2026-08-22-browser-queue-validator-negative-control`
- Case ID: `2026-08-22-mobile-projects-preview-first-render`
- Status: `passed`
- Run at: `2026-08-22T06:48:00Z`
- Commit: `bc46336f0`
- Surface: `mobile-rn-web`
- Device: `iPhone 15 Pro`
- Profile: `not-applicable`

## Headless result

- PASS: a temporary malformed case with an unknown status was rejected with
  twelve specific schema errors; restoring the queue returned validation to
  green.

## Closed-loop result

- PIXELS: not applicable to the Markdown schema guard.
- NAMED: PASS — missing fields, headings, and the invalid status were named.
- SILENT: PASS — malformed input exited non-zero.

## Evidence

- Validator named the missing Case ID, invalid status, and missing Browser arc
  among the rejected fields.

## Failure and route to fix

- Cause: none; the deliberate negative control failed as designed.
- Route: copy the test-case template, complete its fields, and rerun validation.
- Snowball follow-up: retain schema and private-data checks in the executable
  validator rather than relying on prose conventions.

## Notes

- The deliberately invalid temporary file was removed after the failure proof.
