# Mobile Projects preview first-render truth and compact UI — missing Playwright browser

- Result ID: `2026-08-22-mobile-projects-preview-first-render-missing-playwright-browser`
- Case ID: `2026-08-22-mobile-projects-preview-first-render`
- Status: `failed`
- Run at: `2026-08-22T06:44:11Z`
- Commit: `bc46336f0`
- Surface: `mobile-rn-web`
- Device: `iPhone 15 Pro`
- Profile: `browser-automation-2026-08-22`

## Headless result

- PASS: the queue validator accepted the dated case and preflight result.
- PASS: the configured local RN-web target answered HTTP 200.

## Closed-loop result

- PIXELS: not reached because the browser process did not launch.
- NAMED: FAIL — the launcher delegated to Playwright's missing managed-browser
  path even though a system Chromium was already available.
- SILENT: PASS — the harness failed immediately with a named cause rather than
  hanging or downloading a browser implicitly.

## Evidence

- Launcher exit code 1: managed Playwright Chromium executable was absent.

## Failure and route to fix

- Cause: the queue launcher only honored an explicit browser override and did
  not discover an already-installed system browser.
- Route: discover managed Chromium, then standard system Chromium/Chrome paths,
  while preserving `YAVER_CHROMIUM_PATH` as the explicit override.
- Snowball follow-up: keep browser discovery in the shared launcher so every
  future queued arc avoids the same false harness failure and unnecessary
  download.

## Notes

- No browser package was downloaded and no credential was logged.
