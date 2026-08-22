# <Case title> — <run label>

- Result ID: `<yyyy-mm-dd>-<case-slug>-<run-slug>`
- Case ID: `<case id>`
- Status: `<passed|failed|blocked>`
- Run at: `<ISO-8601 UTC timestamp>`
- Commit: `<git commit>`
- Surface: `<mobile-rn-web|web-dashboard>`
- Device: `<Playwright device descriptor>`
- Profile: `<isolated profile label, never an absolute path>`

## Headless result

- `<command/probe and redacted result>`

## Closed-loop result

- PIXELS: `<pass/fail and evidence>`
- NAMED: `<pass/fail and evidence>`
- SILENT: `<pass/fail and evidence>`

## Evidence

- `<repo-relative untracked artifact label or inline redacted measurement>`

## Failure and route to fix

- Cause: `<named cause or none>`
- Route: `<invocable next action or none>`
- Snowball follow-up: `<product/test hardening or none>`

## Notes

- `<non-sensitive observations>`
