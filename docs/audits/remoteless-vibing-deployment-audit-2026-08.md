# Remoteless Vibing, Git, and Deployment Audit

**Date:** 2026-08-19
**Scope:** Mobile boxless Vibing through chat/tasks and rendering/deploy intent
**Out of scope:** New standalone UI surfaces, native rendering implementation, and replacing the remote-box workflow

This is an implementation audit and plan. The source code remains authoritative; this document records the current gap and the intended contract so later work does not confuse the existing phone coding screen with a complete Tasks/Vibing implementation.

## Executive status

The phone already contains most of the difficult local primitives:

- DeepSeek V4 Flash configuration and an on-device agentic coding loop.
- Phone-local source storage and isomorphic-git.
- Read, search, edit, Git status/diff/history, commit, branch, merge, conflict, and revert operations.
- Provider credential storage for GitHub/GitLab and redaction of model output and tool diagnostics.
- A real RN-web mobile entry path, verified in an iPhone device context.
- A remote Vibing/task path that remains separate and continues to use a runner/box.

The product is not yet complete for the intended flow:

```text
Mobile Tasks/Vibing chat
  → select This iPhone or a remote box
  → existing checkout or clone GitHub/GitLab
  → DeepSeek audit/edit loop
  → review
  → explicit commit
  → explicit push
  → explicit deploy through Cloudflare, CI, Convex, BYO device, or Cloud Workspace
  → streamed result in the same task conversation
```

The largest gap is plumbing. The local repo agent is currently exposed by `/repo-coding`, while the normal Tasks/Vibing composer routes to a different local control-plane fallback or to the remote runner. Deployment is also split between agent `/deploy/*` routes, remote publish queues, and build screens.

## Product contract

### One task, explicit execution target

Every coding or deployment task must have an explicit execution target:

1. **Remote box** — operate on the selected machine's existing repository and runtime.
2. **This iPhone** — operate on a phone-local checkout with the boxless DeepSeek agent.
3. **Yaver Cloud Workspace** — operate in an isolated managed workspace when the phone cannot build or deploy directly.
4. **Provider CI** — dispatch an existing GitHub Actions or GitLab CI pipeline.
5. **Direct provider API** — use only for a provider operation that does not require a local build/runtime, such as a compatible Cloudflare deployment.

The system must never silently change from a selected remote repository to a local checkout, or from local execution to billable Cloud Workspace execution.

### Chat is the command surface

No new standalone deployment UI is required for this slice. Existing Tasks/Vibing chat and rendering surfaces should expose the state and the next action inline.

Examples:

```text
audit this repository for auth and dependency risks
implement the fix, but ask before every mutation
commit the reviewed changes
push this branch
deploy sfmg web
deploy sfmg backend through GitHub Actions
deploy the current project to Cloudflare
show the deployed web UI
```

The same structured operation must be callable by mobile chat, web chat, CLI, and MCP. Chat is an intent front end, not the deployment implementation.

### Audit and mutation modes

**Deep audit** is strictly read-only:

- May read, search, inspect Git state, inspect deployment configuration, and produce a deploy plan.
- May not edit, commit, push, build, test, render, deploy, or mutate provider state.

**Implement** may edit, but every mutation is explicitly approved. Commit, push, and deploy are separate approvals. A model request such as “finish and deploy” must not collapse those approvals into one implicit action.

## What exists in code now

### Mobile DeepSeek and local coding

- `mobile/app/repo-coding.tsx` is the current end-to-end phone repo coding screen.
  It stores a DeepSeek key, lists phone projects, runs the agentic loop, and exposes audit/edit modes.
- `mobile/src/lib/codingAgent/runner.ts` has the OpenAI-compatible DeepSeek transport and `deepseek-v4-flash` model configuration.
- `mobile/src/lib/codingAgent/codingAgentRun.ts` wraps the coding loop with Git checkpoints.
- `mobile/src/lib/codingAgent/sandboxBinding.ts` loads the local DeepSeek credential and binds the phone filesystem.
- `mobile/src/lib/codingAgent/gitTools.ts` exposes Git operations. Push is only included when authenticated network options exist, and force-push is disabled.
- `mobile/src/lib/codingAgent/secretRedaction.ts` redacts provider keys from progress, tool arguments, results, and errors.
- `mobile/src/lib/cloneToPhone.ts` clones a GitHub repository into a phone-local project. This is currently GitHub-specific at the entry point even though broader provider primitives exist elsewhere.
- `mobile/src/lib/phoneSandboxSource.ts` provides path-safe, atomic phone-local source storage.
- `mobile/src/lib/phoneSandboxLocal.ts` provides native phone project metadata/database storage; the `.web.ts` sibling is a metadata-only preview stub.

### Broader GitHub/GitLab primitives

- `mobile/src/lib/coding-runtime.ts` contains a separate `LocalWorkspace` model with GitHub/GitLab clone, commit, and push helpers.
- `mobile/src/lib/gitProviderAuth.ts` and `mobile/src/lib/gitProviderStore.ts` provide multi-provider auth detection and credential lookup, including GitLab and self-hosted hosts.
- `mobile/app/git-accounts.tsx`, Settings, and phone-project flows contain GitHub/GitLab account and mirror wiring.

These primitives are not yet the single repository-target implementation used by Tasks/Vibing and `/repo-coding`. Maintaining both paths will create provider and safety drift unless they converge behind a shared interface.

### Tasks/Vibing

- `mobile/app/(tabs)/vibing.tsx` has a local mode and correctly says that local execution has no shell, package manager, simulator, Docker, dev server, or live preview.
- Local Vibing currently routes to Tasks through “Open local coding chat.” It does not select a phone repository or invoke the repo-scoped DeepSeek Git loop.
- `mobile/app/(tabs)/tasks.tsx` dispatches to a selected remote runner when connected.
- When no host is connected, Tasks uses `loadYaverAgentLocalConfig` and the local control-plane agent fallback. That is not the full repository-scoped coding loop.
- Remote task output and the live OpenCode console lane already have task-level streaming contracts and must remain untouched for the remote path.

### Rendering

- `mobile/src/lib/renderCapability.ts` and `mobile/app/(tabs)/vibing.tsx` correctly block preview controls without a connected runtime.
- A phone-only coding turn may prepare source changes and a deployment plan, but it cannot claim that a native build, dev server, simulator, or rendered preview ran.
- A compatible deployed web target can return a URL and be opened as a web result; that is different from local native rendering.

### Existing deployment and publishing

- `mobile/app/(tabs)/ops.tsx` calls agent `/deploy/list`, `/deploy/preview`, `/deploy/run`, and `/deploy/rollback` routes. This is a remote-agent path.
- `mobile/app/(tabs)/publish.tsx` queues publishing through Convex and a device/build worker; it is not a phone-local build path.
- `mobile/app/(tabs)/builds.tsx` selects projects from a connected machine and starts remote publish runs.
- `mobile/app/deploy-status.tsx` reads deploy status from the active box's autorun store.
- `mobile/app/repo-coding.tsx` explicitly states that Convex deployment still requires a machine because the Convex CLI/build environment is not available on iOS.
- The repository's canonical deploy front door is `./deploy/deploy.sh <target>`, with local-first policy. Existing targets include backend/Convex, Cloudflare, iOS, Android, npm, and MCP.

The missing piece is a provider-neutral deployment intent and execution contract that can choose direct API, CI, BYO device, or Cloud Workspace without weakening the current remote path.

### Credential handoff constraint (2026-08-19)

tvOS is remote-control-first: it must not expose a manual API-key field or
assume that a Siri Remote is a safe credential-entry device. DeepSeek access on
tvOS must resolve from one of these metadata-only sources:

- an explicitly approved, short-lived iPhone handoff;
- the selected remote Yaver machine's vault; or
- the managed Yaver gateway.

The tvOS UI may show only the source and its state. The raw key must remain in
iPhone SecureStore, tvOS Keychain after a completed handoff, or the remote
vault. It must never be placed in a QR/deep-link URL, Convex row, relay state,
task prompt, task event, log, or TV-visible text. A signed-in TV with no
provider source must show a route to approve the handoff or select a machine,
not a key-entry control.

## Capability matrix

| Capability | Phone only | BYO device via Yaver/Relay Pro | Yaver Cloud Workspace | GitHub/GitLab CI |
|---|---:|---:|---:|---:|
| DeepSeek chat/audit | Yes | Yes | Yes | No |
| Read/search/edit local checkout | Yes | Yes | Yes | Usually job-specific |
| Git commit | Yes | Yes | Yes | Workflow-specific |
| Git push | Yes, with provider auth | Yes | Yes | Workflow-specific |
| Cloudflare direct deploy | Target capability to add | Yes | Yes | Yes |
| Cloudflare build requiring Node/Wrangler | No, unless API path needs no build | Yes | Yes | Yes |
| Convex deploy | Not with local CLI | Yes | Yes | Yes |
| Web static/Worker preview URL | Only after compatible deploy | Yes | Yes | Yes |
| Native build/render | No | Yes | Yes | Yes, if workflow is configured |
| TestFlight | No | Local Mac path or authorized build worker | Yes, if signing policy permits | Project/policy dependent |
| Google Play internal build | No | Yes | Yes | Yes |
| Simulator/emulator | No | Yes | Yes | Yes |

“Yes” means the execution adapter can support the operation; it does not mean the adapter is already wired into mobile Tasks/Vibing.

## Target architecture

### Repository target

Introduce one shared repository target model used by local Tasks, `/repo-coding`, remote Tasks, and deployment planning:

```ts
type CodingTarget =
  | { kind: "phone-local"; checkoutId: string; provider?: GitProvider; branch: string }
  | { kind: "remote-box"; deviceId: string; projectId: string; branch?: string }
  | { kind: "cloud-workspace"; workspaceId: string; projectId: string; branch: string }
  | { kind: "provider-ci"; provider: "github" | "gitlab"; repository: string; workflow: string; ref: string };
```

The local checkout must include provider, remote identity, current branch, base commit, dirty state, and a stable phone project ID. It must not expose absolute paths to Convex or the model.

### Deployment manifest

Use a project-owned deployment manifest, preferably the existing project configuration conventions rather than a new UI-specific format:

```yaml
project: sfmg
targets:
  web:
    provider: cloudflare-pages
    execution: direct-api
  backend:
    provider: convex
    execution: github-actions
    workflow: deploy-backend.yml
  ios:
    provider: testflight
    execution: cloud-workspace
  android:
    provider: google-play-internal
    execution: github-actions
    workflow: release-mobile.yml
```

The manifest describes intent and target selection. It must not contain secrets. Provider credentials remain in SecureStore/Keychain, Yaver Vault, provider secrets, or CI secrets.

### Provider-neutral deployment operations

One controller should expose these operations to chat, MCP, CLI, and existing task/render plumbing:

```text
deploy.discover
deploy.plan
deploy.preflight
deploy.confirm
deploy.run
deploy.status
deploy.logs
deploy.rollback
```

Each operation must carry a stable project/target identity, commit/ref, execution target, environment, and idempotency key. It must never rely on a prose command being reinterpreted independently by each surface.

### Execution adapters

1. **Direct API adapter**
   - Cloudflare Pages/Workers or equivalent only when the operation does not need unavailable local build tooling.
   - Provider response is normalized into status, URL, version, and logs.

2. **GitHub Actions adapter**
   - Dispatch an existing workflow with a commit/ref and explicit environment.
   - Poll workflow/job status through the provider API.
   - Never paste provider secrets into task prompts.

3. **GitLab CI adapter**
   - Trigger an existing pipeline with the same typed inputs and status contract.

4. **BYO-device adapter**
   - Execute on the user's selected box through the authenticated Yaver agent.
   - Relay Pro supplies capacity/reliability; it is not an authorization boundary.
   - The box's own vault and forced-command/runtime policy remain authoritative.

5. **Cloud Workspace adapter**
   - Run in a tenant-isolated workspace with scale-to-zero lifecycle.
   - Persist only the project state required for the requested job.
   - Delete/park metered compute when idle according to the existing Cloud Workspace policy.

## Staged implementation plan

### Phase 0 — freeze the boundaries

- Add pure target/capability types and a local-vs-remote decision table.
- Make `remote-box`, `phone-local`, `cloud-workspace`, and `provider-ci` explicit values in task state.
- Prove that selecting a remote target cannot invoke the local agent.
- Prove that no connected box is not interpreted as permission to use billable Cloud Workspace.
- Keep existing remote dispatch and raw OpenCode output unchanged.

### Phase 1 — converge Git checkout plumbing

- Extract a shared provider-aware clone/fetch/push service.
- Reuse `gitProviderAuth`/`gitProviderStore`; remove GitHub-only assumptions from the phone repo path.
- Support GitHub, GitLab.com, and configured self-hosted GitLab URLs.
- Add shallow clone, branch selection, fetch/pull, dirty-tree detection, and checkout identity.
- Make clone-on-demand an explicit task action, never an inference from prompt text.
- Store metadata locally; never send absolute phone paths, raw remotes containing credentials, file contents, or tokens through Convex.

### Phase 2 — route normal Tasks/Vibing to the repo agent

- When the selected target is `phone-local`, route to `runAgenticCoding` with the selected checkout sandbox.
- Preserve the regular task transcript/live progress lane; do not create a second chat surface.
- Add task-local cancellation, checkpoint/revert, and reattach behavior.
- Keep DeepSeek model/provider labels truthful: `DeepSeek V4 Flash · phone-local`.
- Keep audit mode read-only at both prompt and tool-dispatch layers; do not trust prompt text alone.

### Phase 3 — explicit Git lifecycle in chat

- Add structured intents for status, diff, commit, branch, push, pull, merge, conflict resolution, and revert.
- Require separate confirmation for edit, commit, push, and branch/merge mutation.
- Disable force-push in the tool schema and implementation.
- Refuse push when remote/auth/branch state is unknown and provide the route to configure it.
- Refuse another coding turn when an unresolved conflict or unsafe dirty-tree state requires user action.
- Stream operation progress and return the user to the same task conversation.

### Phase 4 — deploy planning and cost gates

- Implement `deploy.discover` from project manifest plus measured provider/runtime capability.
- Implement `deploy.plan` with commit, target, environment, execution location, required credentials, estimated external services, and cost-risk notes.
- Add an idempotency key and coalescing: one deploy per converged change, never one deploy per model iteration.
- Require explicit confirmation after the plan.
- Never let audit mode run deploy.
- Prefer Cloudflare for compatible generic web/API deployments, but do not migrate Convex projects implicitly.
- Keep ordinary local Vibing off Convex; only explicit Convex operations or required identity/session bookkeeping may touch Convex.

### Phase 5 — CI and provider adapters

- Dispatch existing GitHub Actions workflows first; add GitLab pipeline dispatch with the same normalized result.
- Support `deploy sfmg backend through GitHub Actions` and equivalent typed commands.
- Add direct Cloudflare adapter only after a real deploy probe proves the operation works for the target project.
- Route Convex CLI/build deployments to CI, BYO device, or Cloud Workspace rather than pretending the iPhone ran the CLI.
- Normalize provider errors into stable codes plus method/path/stream route-to-fix data.

### Phase 6 — BYO device, Relay Pro, and Cloud Workspace

- Use the same deployment plan for BYO device and Cloud Workspace.
- Authenticate the device/workspace with owner-scoped keys; the relay forwards ciphertext and authorizes nothing.
- Keep Free and Pro identical in security checks; Pro changes capacity, reliability, or runtime availability only.
- Add workspace cost/TTL/scale-to-zero signals before allowing a paid run.
- Expose “run on my device” and “run on Yaver Cloud Workspace” as target choices in the existing task confirmation flow, not separate deployment products.

### Phase 7 — rendering integration

- For a compatible web deploy, return the deployed URL as a renderable result in the existing task/Vibing surface.
- Keep the last good rendered surface visible while a deploy or reload is pending.
- Coalesce render intent while coding; render exactly once after a successful terminal state.
- For native or runtime-dependent projects, show `remote runtime required` with a direct target-selection action.
- Never claim a local build, test, simulator, or preview occurred on iPhone when it did not.

## Failure plumbing requirements

Every operation needs all four layers:

1. **Detection:** probe the actual operation: provider auth, workflow existence, branch/ref, remote reachability, deploy capability, build tool, signing capability, and quota.
2. **Signal:** stable code plus typed fields. Do not make mobile parse provider prose.
3. **Task/render presentation:** show the named cause in the existing chat/task/render surface.
4. **Route to fix:** invocable method/path/stream, such as configure GitLab, select a branch, connect a box, wake Cloud Workspace, choose CI, or resolve a conflict.

Minimum failure classes:

- `phone_checkout_missing`
- `provider_auth_missing`
- `provider_auth_expired`
- `repository_unreachable`
- `branch_or_ref_missing`
- `dirty_tree_requires_review`
- `merge_conflict_requires_resolution`
- `remote_runtime_required`
- `cloud_workspace_confirmation_required`
- `cloud_workspace_quota_exceeded`
- `ci_workflow_missing`
- `ci_run_failed`
- `provider_deploy_not_supported`
- `convex_cli_runtime_required`
- `cloudflare_bundle_required`
- `deploy_confirmation_required`
- `deploy_already_in_flight`
- `deploy_quota_or_rate_limit`

No failure may become a silent spinner or a success response when no operation occurred.

## Security and privacy invariants

- DeepSeek receives only the user prompt, scoped source context, and tool results required for the current local task.
- API keys, Git tokens, deploy tokens, signing keys, and CI secrets never enter model messages, task event payloads, commit messages, Convex rows, relay state, or tracked files.
- Phone native secrets use Keychain/Keystore/SecureStore. RN-web uses its documented dev-origin compatibility store and must not be mistaken for hardware-backed storage.
- Convex remains identity, device, session, and project metadata only. No source contents, stdout, prompts, absolute paths, raw tokens, or provider secrets.
- Push and deploy require explicit confirmation; no force-push.
- A relay compromise must not authorize access to another tenant's box or phone.
- BYO device and Cloud Workspace must be access-graph scoped to the same owner/team.
- Deployment adapters must validate project/target identity before using a credential.
- Provider error bodies and streamed logs must be redacted before reaching the task transcript.

## Cost invariants

- Local file reads, audits, edits, Git, and ordinary task transcript state stay on the phone.
- Do not write every model turn, source diff, stdout line, or audit transcript to Convex.
- Do not deploy after every commit or model iteration.
- Coalesce queued deploy requests for the same project/ref/target.
- Prefer direct Cloudflare/API deployment for compatible stateless web/API targets.
- Use Convex only where the project requires Convex; do not migrate generic projects to it.
- Use CI only when it is cheaper or technically required than local/BYO execution, consistent with the repository's local-first deploy policy.
- Yaver Cloud Workspace must be scale-to-zero and must show the paid execution target before confirmation.
- Report CI minutes, provider quota, Cloud Workspace runtime, and deploy status when measurable.
- TestFlight and other store uploads are rate-limited and must never be used as a render/check loop.

Official pricing references change over time: [Convex pricing](https://www.convex.dev/pricing) and [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/). The product must not hardcode current prices into model prompts or UI copy; it should report measured plan/quota information when available.

## Remote-box parity gates

The boxless work is not complete unless these remain true:

- A task explicitly targeting a remote box still dispatches to that box's repository and runner.
- A task explicitly targeting the phone never sends source contents or Git operations to the remote box.
- Remote OpenCode stdout/raw-lane streaming remains unchanged.
- Remote render/reload queue semantics remain unchanged.
- Remote deploy routes continue to use owner-only gates and the canonical deploy front door.
- Relay Pro does not bypass device-key authentication or access-graph checks.
- Remote projects with identical repository names but different devices cannot be conflated.
- A remote task with a missing runtime reports the remote fix route; it does not silently fall back to phone-local editing.
- A phone task with a missing runtime reports `remote runtime required`; it does not claim a build or render.

## Verification matrix

### Headless tests

- Pure target-selection tests prove local/remote/cloud/CI decisions.
- Provider URL/auth tests cover GitHub, GitLab.com, and self-hosted GitLab.
- Clone/fetch/push tests use a local real Git HTTP fixture, not a production repository.
- Agent tool tests prove audit denies every mutation and edit mode invokes approval.
- Deployment planner tests prove no operation occurs before confirmation.
- Idempotency tests prove duplicate deploy intents coalesce.
- Failure tests prove stable codes and route-to-fix data survive HTTP, SSE, task, and incident channels.
- Privacy tests reject source contents, stdout, paths, prompts, tokens, and secrets in Convex payloads.
- Relay tenant tests prove user A cannot reach user B's device.

### Closed-loop mobile tests

Use the real RN-web app at `MOBILE_WEB_URL` with a new Playwright device context from the shared surface viewport table. Never substitute a resized desktop browser.

- Fresh app → phone-local target → clone GitHub fixture.
- Fresh app → phone-local target → clone GitLab fixture.
- DeepSeek audit in a real task conversation; assert no mutation.
- DeepSeek edit → approval → diff → commit → push against a disposable fixture remote.
- Repeated turns reuse the same checkout and branch.
- Push failure shows a named cause and repair action.
- Deploy plan appears in the same task conversation; deploy requires confirmation.
- Cloudflare-compatible deploy returns URL/status without exposing credentials.
- CI dispatch returns workflow/pipeline status and streams progress.
- Convex-required operation says which runtime/CI route is needed rather than claiming local deployment.
- No remote box selected: preview/render controls show the remote-runtime route, not a spinner.
- Remote box selected: existing remote task/render flow still works and the phone-local path is not invoked.
- API keys and provider tokens never appear in visible text, raw task output, console errors, or screenshots.

### External provider probes

Use only disposable, explicitly owned test projects and credentials. Never use Talos, Medici, SFMG, or production targets for an unconfirmed probe.

- GitHub workflow dispatch and failure status.
- GitLab pipeline dispatch and failure status.
- Cloudflare direct deploy plan/run/status/rollback where supported.
- Convex CI/managed deploy plan/run/status.
- BYO device deploy through direct and Relay Pro transport.
- Cloud Workspace wake, run, stream, teardown, and scale-to-zero.

## Acceptance criteria

The slice is complete when a new mobile user can:

1. Configure DeepSeek and GitHub/GitLab credentials without exposing them.
2. Choose `This iPhone` in the existing Tasks/Vibing flow.
3. Clone or select a local repository and branch.
4. Run repeated DeepSeek audit/edit turns against that checkout.
5. Review and explicitly approve edits.
6. Commit and push explicitly.
7. Say `deploy <project> <target>` in the same conversation.
8. Receive a plan, confirm it, and observe streamed provider/CI/BYO/Cloud status.
9. Open a compatible web deployment result, or receive an honest `remote runtime required` route.
10. Use the same project through a remote box without any changed remote behavior.
11. See no unnecessary Convex traffic from ordinary local Vibing and no secret leakage anywhere.

## Recommended implementation order

1. Shared target model and remote/local negative-control tests.
2. Provider-neutral local checkout service, GitHub/GitLab clone parity.
3. Tasks/Vibing routing to the existing repo-scoped DeepSeek agent.
4. Explicit Git lifecycle and recovery in the task conversation.
5. Deployment planner, confirmation, idempotency, cost gates, and failure signals.
6. GitHub Actions/GitLab CI dispatch adapters.
7. Cloudflare direct API adapter for compatible targets.
8. Convex CI/managed-runtime adapter.
9. BYO-device and Relay Pro execution parity.
10. Cloud Workspace execution, scale-to-zero, and monetized capacity signals.
11. Rendering/deployed-web result integration and full closed-loop matrix.

Do not start with a new deployment screen. The highest-leverage slice is the shared target/deploy controller consumed by the existing Tasks/Vibing chat, because it simultaneously preserves the remote-box path and makes the boxless path real.
