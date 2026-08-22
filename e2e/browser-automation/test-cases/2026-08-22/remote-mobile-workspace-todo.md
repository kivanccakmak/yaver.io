# Remote Mobile Workspace todo development

- Case ID: `2026-08-22-remote-mobile-workspace-todo`
- Status: `queued`
- Added: `2026-08-22`
- Surface: `mobile-rn-web`
- Target: `Mobile Workspace onboarding and todo-app creation on the selected remote runner`
- Device: `iPhone 15 Pro`
- Exclusive resources: `remote workspace creation and runner provider probe`

## Headless prerequisite

- `yaver primary status` must report the selected runner reachable with OpenCode ready and Git provider discovery available.

## Preconditions

- `MOBILE_WEB_URL`, `YAVER_TEST_TOKEN`, `REQUIRE_WORKSPACE_READY=1`, and `CREATE_TODO_WORKSPACE=1` are set.

## Browser arc

1. Open Mobile Workspace and start a new mobile app.
2. Confirm the primary remote device, OpenCode, and DeepSeek model are ready.
3. Confirm Yaver Git and both provider integrations are named without creating an external mirror.
4. Describe a small accessible persisted todo app and create the workspace in Yaver Managed Git.

## Assertions

- PIXELS: each wizard stage, runner/model readiness, Git integration state, and created project detail render.
- NAMED: `Primary device · Recommended`, `OpenCode`, the DeepSeek model, `Yaver Git · Ready`, and the created workspace are visible.
- SILENT: readiness spinner, stale-agent false green, provider ambiguity, browser error, or missing created-project route fails the run.

## Negative control

- Run with `REQUIRE_WORKSPACE_READY=1` against a deliberately unavailable readiness route and verify the arc fails before project creation; restore the live route.

## Evidence requested

- Full Playwright video and screenshots before create and after the created-project route opens.

## Notes

- The test does not create a GitHub or GitLab repository; discovery is verified separately and the workspace remains in Yaver Managed Git.
