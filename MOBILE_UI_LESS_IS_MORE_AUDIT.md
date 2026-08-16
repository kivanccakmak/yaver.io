# Mobile UI Less-Is-More Audit

Date: 2026-07-25

Scope: `mobile/app`, especially `mobile/app/(tabs)/_layout.tsx`, `mobile/app/(tabs)/tasks.tsx`, `mobile/app/(tabs)/apps.tsx`, `mobile/app/(tabs)/more.tsx`, and preview/runtime routes.

Principle: mobile Yaver is not an admin console. The product loop is:

1. **Tasks / Vibing**
2. **Reload / Render**
3. **Preview runtime**
   - Hermes bundle reload
   - WebRTC remote runtime
   - Browser/WebView preview

Everything else should be either Settings, diagnostics behind an advanced drawer, or a deep-link route.

## Current Shape

- Visible tab bar is already relatively small:
  - `Tasks`
  - `Projects` via `apps`
  - `More`
- `hotreload` is already hidden and documented as absorbed by Projects/Tasks.
- The real bloat is behind `More`: `mobile/app/(tabs)/more.tsx` is 4,003 lines and links to many old/admin surfaces.
- Biggest mobile UI files:
  - `mobile/app/(tabs)/tasks.tsx`: 7,056 lines
  - `mobile/app/(tabs)/settings.tsx`: 5,948 lines
  - `mobile/app/(tabs)/more.tsx`: 4,003 lines
  - `mobile/app/(tabs)/apps.tsx`: 3,009 lines
  - `mobile/src/components/DeviceDetailsModal.tsx`: 2,313 lines
  - `mobile/app/phone-projects.tsx`: 2,141 lines
  - `mobile/app/(tabs)/devices.tsx`: 1,847 lines
  - `mobile/app/(tabs)/hotreload.tsx`: 1,736 lines

## Keep As Product Surfaces

1. **Tasks**
   - Primary home.
   - Already includes chat/vibing, task history, live output, image attachment, voice entry, one-tap Hermes reload, and `DevPreview`.
   - This should be the first screen for most users.

2. **Projects**
   - Keep only if it stays focused on selecting a project and starting preview/reload.
   - Avoid letting it become a second dashboard.

3. **Render / Preview**
   - Should be embedded in Tasks and Projects, not a tab forest.
   - Core render modes:
     - Hermes reload into the phone
     - WebRTC remote runtime
     - browser/WebView preview

4. **Settings**
   - Account, auth, provider keys, Git wiring, voice settings, startup preference, billing/cloud if exposed on mobile.

## Remove From Default Mobile Entry Points

These routes can remain on disk, but should disappear from normal `More` navigation:

- `builds`
- `publish`
- `shots`
- `studio`
- `qualitygates`
- `runs`
- `monitor`
- `healthmon`
- `files`
- `data`
- `console`
- `terminal`
- `infra`
- `ops`
- `gitproviders`
- `vault`
- `apikeys`
- `accounts`
- `storage`
- `shared-storage`
- `schedules`
- `packages`
- `package-accept`
- `dogfood`
- `tutorials`
- `designmode`
- `solostack`
- `mail`
- `phone-projects`
- `repo-coding`
- `preview-manifest`
- `project-tests`
- `qa`
- `stores`
- `store-testers`
- `deploy-tokens`

Reason: they are either one-off setup/admin, diagnostics, publishing, long-tail ops, or old direct-action screens. The user can ask the task/vibing loop to run these workflows.

## Move To Settings

- Git provider setup / machine Git wiring
- API keys
- Vault/recovery controls
- Billing/cloud controls if mobile exposes them
- Voice config
- MCP server wiring
- Optional tools selector
- Account linking

## MCP Backstop

Removing mobile UI buttons is safe only if Tasks/Vibing can call the same actions through MCP/ops:

- Git setup: `machine_onboarding_status`, `machine_onboarding_apply`, `machine_onboarding_remove`, `git_push_creds`, `git_oauth_start`, `git_oauth_status`.
- Git work: ops verbs `git_status`, `git_diff`, `git_log`, `git_commit`, `git_rebase`, `git_merge`, `git_land`, `git_land_state`, `git_push`.
- Reload/render: Tasks already has one-tap Hermes reload and embedded `DevPreview`; hidden routes keep WebRTC/browser/runtime deep links alive.
- Deploy: `ops_run`, `ops_plan`, `ops_verbs`, `deploy_run`, `cf_deploy`, native build/deploy tools, and `deploy_all` cover backend, Cloudflare web, TestFlight, Play internal, and related release paths.

Validation run: `go test . -run 'TestOpsGit|TestDeployCapability|TestDeployScript|TestMCPMobileHermesReload'` from `desktop/agent` passed on 2026-07-25.

## Move To Advanced

Create one “Advanced” or “Diagnostics” section inside Settings or More. Keep it collapsed by default.

Advanced should contain:

- Devices
- Mesh
- Connection diagnostics
- Remote desktop
- Shell / terminal
- Logs / screen monitor
- Health monitor
- Infra / ops
- Data / storage
- CI/runs
- Dogfood tools
- Owner-only hardware cells

## Merge Into Tasks

These workflows should be launched from task/vibe context instead of standalone screens:

- Build
- Publish
- Screenshots
- Store Studio
- QA / quality gates
- Deploy status
- Git pull/push/commit/rebase
- Run app
- Project tests

Tasks should show small contextual buttons only when relevant:

- Reload
- Open preview
- Run tests
- Ship
- Take screenshot
- Continue/fix failed run

## Proposed Mobile Navigation

Bottom tabs:

1. Tasks
2. Projects
3. Settings

Optional if needed:

4. Devices

No `More` tab in the end-state. If `More` remains during migration, it should contain only:

- Devices
- Mesh
- Settings
- Advanced

## First Coding Pass

1. Keep `Tasks` and `Projects` in the tab bar.
2. Replace `More` grid with a lean menu:
   - Devices
   - Mesh
   - Settings
   - Advanced
3. Move Git/API/Vault/Billing/Cloud wiring into Settings.
4. Hide publish/build/studio/quality/artifact-like routes from normal navigation.
5. Keep files/routes for deep links until the task flow owns every recovery and diagnostic path.

## Guardrails

- Do not remove the hidden routes yet; Expo deep links and agent callbacks may still target them.
- Do not bury connection recovery until Tasks can clearly say why reload/render cannot run.
- Do not remove Hermes/WebRTC/browser preview code; that is core product.
- Do not make “ask the agent” the only way to recover auth, connect a box, or inspect a failed reload.
- Every wait must still narrate itself: command, target device, elapsed time, last output, and next fix.
