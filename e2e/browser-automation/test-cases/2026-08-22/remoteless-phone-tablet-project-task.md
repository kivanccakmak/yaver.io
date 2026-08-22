# Remoteless selection, project browsing, and task composition

- Case ID: `2026-08-22-remoteless-phone-tablet-project-task`
- Status: `queued`
- Added: `2026-08-22`
- Surface: `mobile-rn-web`
- Target: `No remote box execution mode, phone-local projects, and DeepSeek task entry`
- Device: `iPhone 15 Pro and iPad (gen 7)`
- Exclusive resources: `browser profile and task composer`

## Headless prerequisite

- Run the Remoteless placement/lifecycle/project-discovery unit suite and the opt-in production DeepSeek Hello World edit probe; both must pass before opening Chromium.

## Preconditions

- `MOBILE_WEB_URL` and `YAVER_TEST_TOKEN` are set; provider credentials are never written into the case or artifacts.

## Browser arc

1. Open Devices in a full phone or tablet device context and select the named `Use no remote box` action.
2. Open Projects and confirm the phone-local workspace, local checkout, and GitHub/GitLab discovery section render.
3. Open the local checkout and confirm Tasks exposes the DeepSeek composer and audit control.

## Assertions

- PIXELS: the selected Remoteless card, local project row, provider section, and task composer are visible in both device classes.
- NAMED: `SELECTED`, `Phone-local workspace`, `GitHub & GitLab`, and `Deep audit` appear.
- SILENT: signed-out UI, missing local checkout, console errors, or a desktop-shaped context fail the run.

## Negative control

- Remove the seeded phone-local metadata row and verify the local-checkout assertion fails, then restore it.

## Evidence requested

- Phone and tablet Playwright videos plus final screenshots, with no tokens or provider credentials painted.

## Notes

- The real DeepSeek request is headless because RN-web cannot honestly stand in for a native phone filesystem or bypass browser CORS.
