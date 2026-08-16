# Web UI Less-Is-More Audit

Date: 2026-07-25

Scope: `web/app/dashboard/page.tsx` and `web/components/dashboard/*`.

Principle: default users should see the smallest set of surfaces needed to vibe, preview, ship, and recover. If an action can be safely expressed as a Vibe prompt or a schema-driven tool, it should not get a permanent top-level tab.

## Current Shape

- Dashboard shell is very large: `web/app/dashboard/page.tsx` is 4,368 lines.
- Biggest web UI components:
  - `DevicesView.tsx`: 5,671 lines
  - `VibeCodingView.tsx`: 2,806 lines
  - `PreviewPane.tsx`: 2,302 lines
  - `WebReloadView.tsx`: 2,124 lines
  - `ToolsView.tsx`: 1,468 lines
  - `GitView.tsx`: 1,370 lines
  - `ManagedCloudPanel.tsx`: 1,115 lines
  - `GuestsStatusView.tsx`: 1,082 lines
  - `PhoneProjectsView.tsx`: 1,012 lines
- Desktop sidebar currently exposes: Devices, Build, Cloud, Mesh, Chat, Projects, Git, Feedback, Artifacts, Webview, Vibe Preview, Guests, Vault, Billing, Publish.
- Mobile nav exposes many more internal tabs through the shared `tabs` array.
- `VibeCodingView` already owns project selection, runner/model selection, preview start/reload, deploy quick actions, TestFlight/Play/EAS prompt generation, git status, provider setup, and live machine capability context.

## Remove First

1. **Publish tab**
   - Sidebar item: `{ id: "stores", label: "Publish" }`.
   - View branch: `activeTab === "stores"` renders `StoresView`.
   - Reason: Vibe already has deploy quick actions and detailed release prompts for TestFlight, Play internal, and EAS. Store tester/listing/admin tasks are long-tail ops, not a default tab.
   - Replacement: Vibe action cards plus Tools+ for rare store ops.
   - Keep component initially, remove only nav + route branch first.

2. **Build tab**
   - View branch renders `CapabilityShelf` no-op plus `StudioPanel`, `QAPanel`, `WebTestsPanel`.
   - Reason: it is a mixed bucket. CapabilityShelf is retired. QA/studio/web tests are task types Vibe can launch with a prompt.
   - Replacement: move “App-test”, “Store assets”, and “Web tests” into Vibe quick actions or Tools+.
   - Keep only if there is a real non-chat wizard later.

3. **Chat tab**
   - Reason: Vibe is the richer chat surface with preview and project context. A separate Chat tab splits the mental model.
   - Replacement: route old Chat entry to Vibe, or keep hidden as fallback until Vibe covers every runner auth edge.

4. **Vibe Preview tab**
   - Reason: Vibe already embeds `PreviewPane`; a separate preview recording surface is advanced/debug.
   - Replacement: put “watch summaries/demo clips” inside Vibe task detail.

5. **Artifacts tab**
   - Reason: Vibe task detail can surface artifacts when they exist. A top-level tab is low-signal for most users.
   - Replacement: task/project scoped artifacts panel inside Vibe or Projects.

## Hide From Default Nav

These should exist, but not as top-level default web UI:

- `Git`: Vibe already shows branch, dirty state, ahead/behind, providers, and commit/push/deploy prompts.
- `Projects`: useful, but mostly an input to Vibe. Consider folding into Vibe left rail and keeping `/projects` deep-linkable.
- `Feedback`: useful for SDK workflows, but not core vibe loop. Keep deep link.
- `Mesh`: important diagnostics, but default users need Devices first. Keep under Devices/Network settings.
- `Guests`: collaboration admin, not default coding loop. Keep under Share/People.
- `Billing`, `Cloud`: already gated by `HIDE_PAID_UI`; keep hidden unless paid UI returns.

## Keep Top-Level

1. **Vibe**
   - Primary workspace. It should become the default landing tab after login once at least one device exists.

2. **Devices**
   - Required for pairing, recovery, reachability, runner auth, machine selection, and “why can’t I connect?” states.

3. **Webview / Preview**
   - Keep if Vibe cannot fully replace the standalone preview ergonomics yet.
   - Target end-state: one “Preview” entry, not Webview + Preview + Web Reload + Vibe Preview.

4. **Vault**
   - Recovery/security surface. Do not bury until Vibe can explain and repair auth/vault state clearly.

5. **Settings/Security**
   - Account controls are not vibe tasks.

## Internal/Admin Only

These should not appear for normal users unless owner/debug mode is active:

- `Ops`
- `Tools+`
- `Tools`
- `Extras`
- `Autoruns`
- `Health`
- `Quality`
- `Data`
- `Switch`
- `Accounts`
- `Company AI`
- `Infra`
- `Connect`
- `Storage`
- `Schedules`
- `Packages`
- `Phone Backend`
- `Companion`
- `Domains`
- `Exec`
- `Screen Monitor`
- owner hardware tabs: `arm`, `appletv`, robot/circuit/printer routes

Reason: these are diagnostics, schema-generated forms, project administration, or owner lab controls. They are valuable, but they make the product read like an internal console.

## Current Decision

Default web nav should be:

1. Devices
2. Mesh
3. Chat
4. Projects

Move to Settings:

- Git wiring
- Billing
- Cloud

Remove from default nav:

- Publish
- Git
- Build
- Artifacts
- Vibe Preview
- Vault
- Feedback
- Webview
- Guests

Keep the underlying views/routes on disk while migration settles, except for removed render branches in the dashboard shell.

## MCP Backstop

Removing UI entry points is safe only if the agent/MCP path still covers the workflows elegantly. Current coverage:

- Git setup: `machine_onboarding_status`, `machine_onboarding_apply`, `machine_onboarding_remove`, `git_push_creds`, `git_oauth_start`, `git_oauth_status`.
- Git work: ops verbs `git_status`, `git_diff`, `git_log`, `git_commit`, `git_rebase`, `git_merge`, `git_land`, `git_land_state`, `git_push`; MCP also exposes `git_branches`, `git_remotes`, `git_tags`, `git_reflog`, `git_stash`, `git_members`.
- Deploy: `ops_run` + `ops_plan` + `ops_verbs` expose the deploy verb surface; direct MCP tools include `deploy_run`, `deploy_list`, `deploy_rollback`, `cf_deploy`, native build/deploy tools, and `deploy_all`.
- Targets covered in code: backend/Convex, Cloudflare web, TestFlight, Play internal, EAS, Vercel/Fly/Netlify/Railway/Firebase through ops deploy.

Validation run: `go test . -run 'TestOpsGit|TestDeployCapability|TestDeployScript|TestMCPMobileHermesReload'` from `desktop/agent` passed on 2026-07-25.

## Proposed Default Nav

Desktop sidebar:

1. Devices
2. Vibe
3. Preview
4. Vault

Secondary menu:

- Projects
- Git
- Feedback
- Artifacts
- Guests / Share
- Mesh
- Settings

Debug/owner drawer:

- Tools+
- Ops
- Autoruns
- Health
- Logs / Screen Monitor
- Infra
- Storage
- Packages
- Exec

## First Coding Pass

Small, reversible changes:

1. Remove `Publish` from the desktop sidebar.
2. Remove `stores` from the public mobile `tabs` array.
3. Remove or redirect the `activeTab === "stores"` branch.
4. Keep `StoresView.tsx` on disk for now.
5. Build.

Second pass:

1. Make `Vibe` the primary/default product tab.
2. Collapse `Chat` into `Vibe`.
3. Hide `Build` from default nav permanently unless paid UI returns with a real wizard.
4. Move QA/studio/web-test launches into Vibe quick actions.

## Guardrails

- Do not remove capability/status views until Vibe shows the same readiness reason and recovery text.
- Do not remove Devices, Vault, or connection diagnostics just because Vibe can ask the agent questions.
- Keep deep links for admin/debug tabs while pruning default navigation.
- Remove entry points before deleting components; deletion comes after telemetry/manual usage confirms no missing workflow.
