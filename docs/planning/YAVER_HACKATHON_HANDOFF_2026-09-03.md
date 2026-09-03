# Yaver hackathon readiness handoff — 2026-09-03

This is a checkpoint for the next work session. Code and executable tests remain
authoritative; re-read the named files before relying on this document.

## Intended product and demo

The strongest hackathon application is **Adaptive Field Service**: a small
Expo work-order app that an authorized user can adapt after delivery through
Yaver and Codex. The baseline records one equipment visit and offers bounded,
job-aware AI help. During the demo, a new hot-equipment rule changes the real
data, validation, workflow, and UI—not only labels or theme colors.

The prepared demo and five-hour build order are in
`docs/planning/ISTANBUL_SLUSHD_HACKATHON_2026.md`.

## Completed in this checkpoint

### Deterministic Yaver injection for existing Expo apps

- Added `yaver integrate --dir <app> --framework expo --verify
  none|quick|web`.
- Added the equivalent `yaver_sdk_integrate` MCP tool.
- The integration installs the Yaver feedback SDK and Expo-compatible peers,
  mounts one generated `yaver/YaverFeedbackRoot.tsx`, wires the Expo config
  plugin, wraps a named app root, and verifies Expo config plus TypeScript.
- `verify=web` performs a real Expo web export and requires the generated
  `index.html`.
- The operation is idempotent and refuses ambiguous root exports before
  mutation.
- Older Expo/feedback setup commands use the same integration engine rather
  than maintaining separate source-rewrite implementations.

Primary code: `desktop/agent/integrate_cmd.go` and
`desktop/agent/integrate_cmd_test.go`.

### Yaver-aware generated starter

- The generated Expo mobile application now declares the feedback SDK and
  required peers, mounts the feedback/Vibing root, and includes the plugin.
- Corrected the generated Convex HTTP router filename and its internal module
  reference.
- Generated JSON and source wiring are covered by project-creation tests.

Primary code: `desktop/agent/project_wizard.go` and
`desktop/agent/mcp_project_create_test.go`.

### Fresh-agent discoverability

- HTTP and stdio MCP initialization now share the same instructions, so a
  clean Codex/Claude/OpenCode session receives Yaver integration guidance even
  without conversation history.
- The plugin/skill, `llms.txt`, README, integration guide, and hosted MCP
  discovery response describe the deterministic integration path.
- Added a repository-side OpenAI plugin submission packet. Portal submission,
  approval, and marketplace publication still require an owner and are not
  performed by repository code.

Primary code: `desktop/agent/mcp_instructions.go`,
`plugins/yaver/skills/yaver/SKILL.md`, and
`docs/planning/OPENAI_PLUGIN_SUBMISSION.md`.

### Runner-independent mobile sandbox requests

- The mobile edit loop can request Codex, Claude Code, or OpenCode instead of
  assuming OpenCode.
- If the request omits a runner, the selected machine's saved primary runner
  is used, with the existing OpenCode behavior retained as a compatibility
  fallback.
- Runner credentials remain on the runner machine; only the temporary source
  workspace and resulting diff cross the sandbox boundary.

Primary code: `desktop/agent/sandbox_remote.go` and
`mobile/src/lib/llmRemote.ts`.

### Optional Convex + OpenRouter integration

- Added `yaver_openrouter_integrate` for Expo applications that explicitly use
  Convex.
- It detects `backend/convex` or `convex` and Expo roots at the repository root,
  `apps/mobile`, or `mobile`; ambiguous layouts must be named explicitly.
- It supports either Yaver starter sessions or standard Convex identity and
  refuses to create an unauthenticated paid-model proxy.
- The OpenRouter key stays in Convex server environment variables.
- One authenticated HTTP request is kept open as an SSE stream. There is no
  polling loop and no database write per token.
- Request accounting uses one bounded row per authenticated user and at most
  one mutation per accepted request. Provider credit limits are still required
  because an application limiter is not a spend cap.

Primary code: `desktop/agent/openrouter_integrate.go` and
`desktop/agent/openrouter_integrate_test.go`.

## Verification completed

- Focused Go tests for SDK integration, generated starter wiring, MCP
  instructions, sandbox runner selection, bounded Xcode probing, and the
  OpenRouter integration passed during development.
- Mobile runner/session tests passed for the Codex/Claude/OpenCode selection
  changes.
- `scripts/test-sdk-integrate-cleanroom.sh` passed against a stock Expo
  TypeScript app with an isolated temporary home/cache. It built the local
  Yaver CLI, integrated Yaver, typechecked, exported a real web bundle, reran
  idempotently, then discovered and called the integration through isolated
  stdio MCP.
- The clean-room run exposed a machine prerequisite: Node 22.12 is below the
  engine version declared by the current Expo/React Native packages. npm and
  the web export happened to succeed, but the event laptop should use a version
  accepted by the current Expo template instead of relying on that warning.

Re-run the exact commands recorded in the commit handoff before a release;
package versions and Expo requirements can drift.

## Not completed yet

### 1. Make Yaver Serverless the default AI runtime

The OpenRouter tool currently generates a **Convex adapter**. It is not yet the
desired default Yaver Serverless path.

Next implementation:

1. Add a Yaver-agent route such as `POST /ai/<project-slug>/chat`.
2. Authenticate it with the existing per-project Yaver Serverless token and
   reject read-only tokens for paid AI until a dedicated AI scope exists.
3. Store the user's OpenRouter key once in an encrypted, write-only Yaver vault
   namespace; never place it in generated Expo source or return it from a GET.
4. Stream the provider response directly as SSE with request-size, token,
   timeout, cancellation, and in-memory rate bounds.
5. Add `yaver_openrouter_configure` and make
   `yaver_openrouter_integrate` default to `backend=yaver-serverless`.
6. Retain the completed Convex generator only as
   `backend=convex` for applications that explicitly chose Convex.
7. Prove auth rejection, cross-project isolation, read-only rejection, secret
   non-disclosure, incremental SSE, cancellation, and rate limiting with an
   `httptest` upstream—not the live OpenRouter service.

Relevant existing runtime: `desktop/agent/phone_backend.go`,
`desktop/agent/phone_data_http.go`, `desktop/agent/phone_tokens.go`, and
`mobile/src/lib/projectStore.ts`.

### 2. Implement real app-user authentication for Yaver Serverless

Current OAuth support is configuration inventory, not a working application
login system:

- `desktop/agent/phone_oauth.go` stores Apple/Google/Microsoft provider
  credentials and reports configuration state.
- There are no matching authorization, callback, token, or application-session
  endpoints consuming that configuration.
- The current phone-project auth personas are seeded development roles, not
  Google/Apple sign-in.
- Email/password app-user authentication is not implemented for Serverless
  Lite.

Do not claim that a generated Yaver Serverless app already has operational
Google, Apple, or email/password auth. First separate `configured` from
`runtimeReady` in every API/UI surface and add a failing capability test. Then
implement provider callbacks, account linking, sessions, logout/revocation,
CSRF/state/PKCE protections, secure credential retention, and cross-surface
consumers. Provider secrets must not travel in a portable project export.

This is not required for the hackathon demo: use seeded operator/manager roles
and disclose that they are demo roles.

### 3. Harden managed Serverless isolation before general production

The current shared remote serverless placement uses container/shared-kernel
isolation and is suitable only for first-party or trusted beta workloads. It
must not be represented as safe untrusted third-party production co-tenancy.
Complete the microVM-grade isolation work, resource/spend quotas, tenant escape
tests, lifecycle cleanup, and incident observability before that claim.

Relevant code: `desktop/agent/serverless_isolation.go` and
`backend/convex/serverlessPool.ts`.

### 4. Release and public discovery

The repository implementation is not automatically available to a fresh npm
consumer. Before public evaluation:

1. Choose an accepted Node version and run the clean-room test again.
2. Run the full relevant Go/mobile/web suites and a real phone closed loop.
3. With explicit owner approval, release the maintained CLI/SDK versions.
4. From a fresh home and fresh package cache, prove that `@latest` contains
   `yaver integrate`, stdio MCP instructions, and both integration tools.
5. Collect clean-session positive/negative evaluations.
6. Submit the skills/plugin listing through the OpenAI owner portal only after
   the published artifact and support/privacy/terms URLs are ready.

No npm publication, mobile deployment, tag, marketplace submission, or app
deployment is part of this checkpoint.

## Recommended next-session order

1. Rebase or merge this checkpoint onto the then-current `main` and re-run its
   focused tests.
2. Implement the Yaver Serverless OpenRouter route, encrypted configuration,
   MCP configuration tool, and adversarial HTTP tests.
3. Change the integration tool/docs so Yaver Serverless is the default and
   Convex is explicit.
4. Add honest Serverless authentication readiness signals before implementing
   provider flows.
5. Prove the full real-phone feedback → runner task → safe render loop using
   the event laptop, phone, and network.
6. Only then consider release and marketplace submission.

## Hackathon scope guard

For a five-hour build, preserve one complete before/change/after loop. Cut maps,
analytics, inventory breadth, barcode scanning, notification delivery, and
production OAuth before cutting the actual Yaver-driven business-rule change.
The demo wins or loses on whether the audience sees the real application become
more capable safely, not on the number of conventional field-service features.
