# Yaver Cloud Studio: tvOS, Git, and Cloud Runner Architecture

> Deep audit, architecture contract, and implementation plan, 2026-08-15.

## Implementation baseline

The repository now contains the first executable Cloud Studio slice:

- tvOS resolves a remote-only coding module and requires Cloud access, a ready
  Git Connection, a ready Cloud Workspace, and its assigned Cloud Runner;
- Convex stores server-authoritative Cloud access, workspace, Git Connection,
  managed-runner capability, and scoped workload-credential records;
- `yaver cloud-runner` registers and heartbeats with the workload credential,
  joins the relay, and rejects global work directories, global task creation,
  user-written runner secrets, MCP, and client-triggered shutdown;
- the runner exposes path-free repository descriptors and isolated Project
  Sessions with task, Git status/diff/commit/review-push, validation, cleanup,
  and browser-preview endpoints;
- phone Mobile Workspace Git reads and writes binary data without corrupting
  Git objects; and
- tvOS Projects, Tasks, tests, and Vibing use the Project Session APIs.

This is an implementation baseline, not a production provisioning launch. A
GitHub App/GitLab credential broker, the Cloud Workspace controller, native
simulator adapters, artifact storage, pull-request adapters, quotas, and
infrastructure-grade tenant isolation remain deployment work described below.

## 1. Executive decision

Yaver Cloud Studio is a remote development experience controlled from tvOS.
Apple TV is a client, not an execution host.

Cloud Studio has two hard dependencies:

1. an active Git connection with at least one authorized repository; and
2. an available Yaver Cloud Runner assigned to the user's Cloud Workspace.

The Cloud Runner clones the repository, creates an isolated project session,
runs the coding agent, installs dependencies, executes builds and tests, and
hosts previews. tvOS sends authenticated commands and renders task output,
validation results, diffs, and Vibing frames. It does not hold repository
contents, Git credentials, provider credentials, build tools, or signing keys.

The product boundary is:

```text
Connect Git -> Cloud Workspace ready -> Create Project Session
    -> Code -> Build/Test -> Vibing -> Review -> Commit/Push
    -> user takes responsibility for signing and store publication
```

Cloud Studio must not publish to App Store Connect or Google Play. It may
produce source branches, pull requests, test reports, and unsigned or
development artifacts. Distribution signing, certificates, store credentials,
release records, review submission, and production rollout stay outside the
Cloud Studio contract.

## 2. Vocabulary

These names must be used consistently in UI, APIs, schemas, logs, and docs.

| Name | Meaning |
| --- | --- |
| **Yaver Cloud Studio** | The remote development experience shown on tvOS and other Yaver clients. |
| **Git Connection** | An authorized GitHub or GitLab account/application connection. It is independent from signing in to Yaver. |
| **Cloud Workspace** | The remote development environment assigned to one Yaver account. This is the service-level environment, not a repository checkout. |
| **Cloud Runner** | The authenticated executor inside a Cloud Workspace. It runs Git, agents, commands, builds, tests, and preview adapters. |
| **Project Session** | One isolated checkout/worktree for one repository, base ref, and Yaver review branch. |
| **Task** | One coding-agent conversation or continuation inside a Project Session. |
| **Validation Run** | A real lint, typecheck, compile, or test invocation with captured status and output. |
| **Vibing Session** | A dev server plus an authenticated preview stream associated with one Project Session. |
| **Mobile Workspace** | The lightweight Git-capable workspace that can exist on a phone. It is separate from Cloud Studio. |
| **Artifact** | A build output or test report created by the runner. An artifact is not proof of store readiness. |

Do not use **sandbox** as a product or workspace name. The existing Go
`SandboxConfig` may remain as an internal command guard for self-hosted agents,
but it is neither the Cloud Studio architecture nor a sufficient managed-host
security boundary.

Do not call a Project Session another "workspace." The distinction between a
long-lived Cloud Workspace and a repository-scoped Project Session prevents
ambiguous APIs and retention rules.

## 3. Non-negotiable product rules

### 3.1 tvOS is remote-only

- No local repository checkout on Apple TV.
- No `isomorphic-git` execution on Apple TV.
- No model API keys or Git tokens in the tvOS Keychain.
- No local LLM calls, file tools, static preflight, commits, or pushes on tvOS.
- No shell, compiler, package manager, simulator, emulator, Docker daemon, or
  background worker on tvOS.
- Every editable project view is backed by a Cloud Runner Project Session.
- Every build/test success must identify the runner, command profile, ref, SHA,
  start time, finish time, and exit status.

### 3.2 Mobile keeps a real Git dependency

iOS and Android phones may keep the lightweight Mobile Workspace fallback. It
must use a real Git implementation for clone, status, patch diff, branch,
commit, fetch, and push. The current `isomorphic-git` dependency is an
appropriate pure-JavaScript starting point, but its React Native filesystem
adapter must be fixed and tested before local Git is considered functional.

Mobile Workspace is not Cloud Studio. It cannot claim to run dependencies,
tests, native builds, simulators, or previews.

### 3.3 No commerce language on Apple surfaces

The iOS and tvOS applications consume account entitlements; they do not present
the provisioning or billing flow.

Apple-surface copy must not contain:

- purchase, buy, subscribe, upgrade, pricing, checkout, or payment CTAs;
- an external payment link;
- plan comparison or price copy; or
- instructions whose purpose is to route the user to an external purchase.

Allowed neutral states include:

- `Cloud Workspace ready`
- `Cloud Runner unavailable`
- `Git connection required`
- `This account does not currently have Cloud Studio access`
- `Manage Cloud Workspace from your Yaver account`

The last message is informational account-management copy, not a link or
commerce CTA. The exact release copy still needs normal App Review review.

### 3.4 Git and Yaver identity are separate

"Continue with GitHub" currently authenticates a Yaver user with the scopes
`read:user user:email`; it does not authorize repository access. The OAuth
callback discards the provider access token after reading user information.
Cloud Studio therefore needs a separate Git Connection flow.

Recommended authorization model:

- GitHub: a GitHub App installation with repository selection and short-lived
  installation access tokens.
- GitLab: a dedicated OAuth application with the minimum repository scopes,
  refresh-token rotation, and repository allowlisting.
- Self-hosted Git: later phase, using runner-local deploy keys or a dedicated
  connection adapter.

Git credentials must never be sent to tvOS or stored in Convex. Connection
metadata may live in Convex; secrets belong in a KMS/Vault-backed credential
broker. The runner obtains short-lived clone/push credentials using its scoped
workload identity.

### 3.5 Publishing is outside Cloud Studio

Cloud Studio ends at reviewable source and truthful build/test evidence. The
managed runner must not request or retain App Store Connect API keys, Apple
distribution certificates, Google Play service-account keys, keystore
passwords, production provisioning profiles, or store release credentials.

The default managed command policy must block store submission commands. If a
future product adds release automation, it requires its own name, threat model,
credentials contract, UI, terms, and explicit user approvals; it must not be
silently added to Cloud Studio.

## 4. Current repository audit

### 4.1 What already exists and can be reused

| Area | Existing implementation | Reuse value |
| --- | --- | --- |
| Auth and pairing | Yaver sessions, tvOS device-code pairing, same-user token validation | Good basis for signing Apple TV into the same account. |
| Device discovery | Convex `devices`, heartbeats, relay registration, direct/relay client | Cloud Runner can remain a typed Yaver device. |
| Task transport | Authenticated `/tasks` API, polling/SSE-like output handling, continuations, stop/exit | Can be evolved around `projectSessionId`. |
| Runner catalog | Claude, Codex, OpenCode, Aider definitions plus model metadata | Can be filtered by managed-runner policy and capabilities. |
| Git on phone | `isomorphic-git` dependency, local workspace model, Keychain-backed tokens | Useful after filesystem and test repairs. |
| Metadata timeline | Convex `taskRuns` stores runtime/status/runner/model/ref/SHA without prompt or output | Good privacy-aware base for Cloud Studio metadata. |
| Preview capture | Authenticated loopback-only `/vibing/frame`, serialized Chrome captures, memory guard | Reusable for the first browser-frame Vibing lane. |
| tvOS UX | Focus-aware navigation, task chat, console output, project picker, Vibing frame renderer | Much of the presentation layer can be adapted. |
| Secret injection | Runner-local write-only secret API and environment injection | Useful conceptually, but the storage and provisioning model must change for managed workers. |

### 4.2 Critical gaps and contradictions

#### A. tvOS currently implements the opposite runtime

`mobile/app/(tabs)/tasks.tsx`, `vibing.tsx`, and `settings.tsx` currently permit
an Apple TV local mode. They create local workspaces, call a model directly,
show Keychain credential fields, run a static preflight, and push review
branches. `mobile/CLOUD_STUDIO_TVOS.md` documents the replacement remote design. The shared
runtime contract also grants tvOS local filesystem and Git capabilities.

This entire tvOS-local branch conflicts with the new remote-only decision.
Changing copy is insufficient; the code path and credential UI must become
unreachable in TV builds.

#### B. Coding mode is account-global, not surface-specific

`userSettings.codingMode` is synchronized through Convex and read by phone and
tvOS. A phone choosing `local-only` can therefore put Apple TV into local mode.
The setting must become phone-specific or tvOS must ignore it entirely.

Recommended migration: rename the client concept to `mobileCodingMode`, read
the legacy `codingMode` only on iOS/Android during one migration window, and do
not expose a runtime-mode switch in Cloud Studio on tvOS.

#### C. The Mobile Workspace Git adapter is not release-ready

`mobile/package.json` includes `isomorphic-git`, but
`mobile/src/lib/coding-runtime.ts` supplies a text-only filesystem adapter:

- `readFile` returns UTF-8 text even when Git expects binary bytes;
- `writeFile` decodes `Uint8Array` object data as text and writes UTF-8, which
  can corrupt Git object and index data;
- the adapter does not provide a proven complete Node-style promises surface;
- `gitDiff` reports only `path: modified`, not an actual patch;
- no automated clone/fetch/branch/commit/push round-trip test exists; and
- `mobile/package.json` has no test script.

Before promising Git on mobile, implement a binary-safe Expo FileSystem adapter
using base64 for byte reads/writes, add the required filesystem methods, and run
integration tests against a local smart-HTTP Git fixture or a disposable test
repository. Include filenames, Unicode content, binary files, deletions,
renames, conflicts, shallow clone updates, authentication failures, and a
review-branch push.

#### D. Cloud Workspace provisioning does not exist

The legacy self-hosted runner note described only a normal agent on a trusted
VM and has now been removed. The audited repository had no server-authoritative Cloud Studio entitlement, provisioning
service, Cloud Workspace lifecycle, managed runner identity, Git credential
broker, repository allowlist, quota record, or cleanup controller.

`relayTier` is user-editable settings data and is explicitly not billing
authority. It must not be repurposed as Cloud Studio access authority.

#### E. Cloud Runners cannot be distinguished safely

The `devices` table exposes only desktop platform information. It has no
`deviceKind`, managed/unmanaged trust marker, Cloud Workspace ID, capability
document, region, lifecycle state, or attested runner version. Mobile currently
has a hard-coded preferred hostname, which is not an acceptable managed-runner
routing rule.

Cloud Studio must select `deviceKind=cloud-runner` through server-issued
metadata, never a hostname convention or a user-editable flag.

#### F. Managed workers currently need a full user session token

The Go agent stores and uses the user's Yaver bearer token to register, send
heartbeats, report metrics, and connect to the relay. A managed service should
not retain a general-purpose user session.

Add a scoped workload credential that is bound to one user, Cloud Workspace,
runner device ID, and allowed backend actions. Store only its hash server-side,
support rotation/revocation, and make it unusable as a client session.

#### G. Relay registration is not authoritative

The relay accepts any non-empty agent token and contains a TODO to validate it
against Convex. A caller that knows a device ID can replace the existing tunnel.
The downstream agent authenticates client requests, but the registration gap
still permits tunnel hijacking or denial of service.

Before managed Cloud Runners are exposed, relay registration must validate a
scoped device/workload credential and its device ID. Client proxy requests must
continue to be authenticated by the runner, and the relay must not become a
task-data store.

#### H. The current runner has one mutable global work directory

`POST /work-dir` mutates `TaskManager.workDir`; all subsequently started tasks
use that value. Concurrent clients can race and make a task execute in the wrong
repository. Tasks persist no repository or workspace identity.

Cloud Studio must remove global-path selection from its API. Each task must
carry an immutable `projectSessionId`, and the runner must resolve that ID to a
validated internal directory. tvOS must never send an absolute path.

#### I. Project discovery is host-centric, not Cloud Studio Git

The source agent scans the home directory plus `/workspace`, `/workspaces`,
`/opt`, and `/srv` for `.git` directories. This is useful for self-hosted desktop
discovery but is not the Cloud Studio repository catalog. Managed repositories
must come from the authorized Git Connection and become explicit Project
Sessions.

#### J. Existing command filtering is not managed isolation

The Go `SandboxConfig` is regex-based validation for explicit custom commands.
Coding agents still receive broad tools; Claude is currently invoked with
`--dangerously-skip-permissions`, and an allowed custom command runs through
`sh -c` on the host. A managed worker needs OS/VM isolation, resource limits,
mount boundaries, workload identity, egress policy, and a restricted API.

The tvOS Cloud Studio API must not expose arbitrary custom commands,
`/work-dir`, `/agent/secrets`, `/agent/shutdown`, or runner switching unless a
separate policy explicitly authorizes them.

#### K. Managed secret storage is not implemented

The current agent stores secrets in `~/.yaver/secrets.json` with mode `0600` and
injects them into child environments. That is acceptable as a basic
self-hosted mechanism, but a managed runner requires encrypted-at-rest secrets,
short-lived credentials, audit records, rotation, and deletion. Git tokens
should normally be issued just in time rather than persisted in the checkout or
general runner environment.

#### L. Vibing is incomplete and globally scoped

The current repository has:

- browser screenshots polled as PNG every 2.5 seconds, though UI and settings
  sometimes call the lane SSE;
- a browser-only ready preview option;
- no tvOS-compatible WebRTC client;
- no in-repository `/dev/start`, `/dev/status`, `/dev/stream`, or `/dev/stop`
  implementation, even though clients call those endpoints;
- no native simulator launch/capture adapters; and
- preview status that is not associated with a Project Session.

In addition, `vibing.tsx` builds relay URLs manually and selects the first relay
instead of using the active authenticated transport selected by `QuicClient`.
Those raw requests do not consistently add the relay password. Cloud Studio
needs one transport client for tasks, Git, validation, and previews.

#### M. Build capability is currently over-declared

The mobile coding runtime marks a generic remote runtime as supporting Docker,
browser automation, native builds, and deploys without asking the actual
runner. Capability must be reported by each runner and each preview adapter.

A Linux runner can generally build/test web and Android projects but cannot run
Xcode or an iOS/tvOS simulator. Apple builds require a compatible macOS runner.
Android emulator availability also depends on virtualization support. The UI
must show only verified capabilities and must never infer them from a plan name.

#### N. Privacy and terms copy conflict with a managed Cloud Workspace

README, landing, FAQ, developer docs, mobile privacy, mobile terms, web privacy,
and web terms currently state that code never touches Yaver servers and that
Yaver has no paid tiers. A Yaver-managed Cloud Workspace stores and processes
the user's checkout, prompt, output, and build data on infrastructure operated
for Yaver.

Before public availability, those claims must distinguish:

- private/self-hosted agents and pass-through relay behavior;
- control-plane metadata in Convex;
- data processed and retained inside the user's managed Cloud Workspace; and
- the retention/deletion/support-access policy for that environment.

The relay and Convex can remain content-minimizing, but the blanket
"never touches our servers" promise cannot describe managed Cloud Studio.

#### O. Tests do not cover the proposed contract

The integration suite builds Go, web, backend, mobile typecheck, iOS, and
Android, but it does not build tvOS. The repo has no mobile Git tests, Cloud
Workspace lifecycle tests, Project Session isolation tests, Git broker tests,
or real source-tree preview-controller tests. Web E2E covers auth and landing,
not Cloud Studio.

## 5. Target surface capability matrix

| Capability | iOS/Android Mobile Workspace | tvOS Cloud Studio | Cloud Runner | Convex/control metadata |
| --- | --- | --- | --- | --- |
| Store checkout | On phone | No | Yes, per Project Session | No |
| Hold Git credential | Device secure store for Mobile Workspace | No | Short-lived/in-memory | No secret |
| List authorized repos | Yes, local token path | Via runner/control-plane metadata | Yes | Optional non-secret metadata |
| Edit files | On phone | Remote command only | Yes | No |
| Git diff/commit/push | On phone review branch | Remote command only | Yes, review branch | Ref/SHA metadata only |
| Run coding agent | Limited direct model tools | Remote command only | Yes | No |
| Shell/package manager | No | Remote command only | Yes, isolated | No |
| Build/test | No | Request and display | Yes, capability-gated | Result metadata only |
| Vibing preview | Remote only | Render remote stream | Host/capture | Session metadata only |
| Publish to stores | No Cloud Studio responsibility | No | No managed support | No |

## 6. Target architecture

```text
                              account/provisioning surface
                          (not shown as commerce on Apple apps)
                                         |
                                         v
                          +-------------------------------+
                          | Cloud Studio control plane    |
                          | entitlement + runner metadata |
                          | no source/prompt/output       |
                          +-----------+-------------------+
                                      |
                     scoped workload  |  Git connection metadata
                     identity         |  and credential references
                                      v
+-------------+   authenticated   +-------------------+   short-lived   +-------------+
| Apple TV   |------------------->| Relay            |<--------------->| Cloud Runner|
| Cloud      |  task/git/build/   | pass-through     |  QUIC tunnel    | in Cloud    |
| Studio UI  |  preview control   | no retention     |                 | Workspace   |
+-------------+                   +-------------------+                 +------+------+
                                                                             |
                                              +------------------------------+------------------+
                                              |                              |                  |
                                              v                              v                  v
                                    +-----------------+            +----------------+   +--------------+
                                    | Project Session |            | Validation Runs|   | Vibing Session|
                                    | checkout/branch |            | build/test     |   | dev server + |
                                    +--------+--------+            +----------------+   | frame stream |
                                             |                                          +--------------+
                                             v
                                    +-------------------+
                                    | Git provider      |
                                    | via credential    |
                                    | broker token      |
                                    +-------------------+
```

### 6.1 Trust boundaries

1. **Apple TV** has a normal user session and may access only resources owned by
   that account. It never receives provider or Git secrets.
2. **Convex/control metadata** authenticates users, records entitlements and
   routing metadata, and returns server-authoritative runner assignments. It
   does not store source, prompts, output, patches, or long-lived provider
   credentials.
3. **Relay** validates runner registration, routes encrypted authenticated
   requests, applies size/rate limits, and stores no task content.
4. **Cloud Runner** is the content-bearing execution boundary. Its retention,
   encryption, logging, support access, backup, and deletion policies must be
   disclosed accurately.
5. **Credential broker** stores Git authorization encrypted under KMS/Vault and
   issues short-lived repository-scoped credentials only to an attested Cloud
   Runner.
6. **Project Session isolation** prevents one repository/task from reading or
   modifying another Project Session or the host.

## 7. Control-plane data model

The names below are proposed. Secret values must not be added to these tables.

### 7.1 `cloudAccess`

Server-authoritative eligibility record:

```ts
{
  userId,
  status: "active" | "inactive" | "suspended",
  maxCloudWorkspaces: number,
  maxConcurrentTasks: number,
  maxConcurrentPreviews: number,
  allowedRunnerClasses: string[],
  validUntil?: number,
  updatedAt: number
}
```

Only a trusted server action may write this table. It is never derived from
`userSettings`, Apple UI state, or a client-supplied tier.

### 7.2 `cloudWorkspaces`

One allocated managed environment:

```ts
{
  userId,
  cloudWorkspaceId: string,
  runnerDeviceId: string,
  runnerClass: "linux" | "macos",
  region: string,
  state: "provisioning" | "ready" | "sleeping" | "starting" |
         "unavailable" | "deleting",
  capabilitiesDigest?: string,
  lastReadyAt?: number,
  createdAt: number,
  updatedAt: number
}
```

No hostname convention, plan label, or user-editable setting grants trust.

### 7.3 `gitConnections`

Non-secret connection metadata:

```ts
{
  userId,
  gitConnectionId: string,
  provider: "github" | "gitlab",
  externalAccountId: string,
  displayName: string,
  status: "ready" | "reauthorization-required" | "revoked",
  credentialReference: string, // opaque broker reference, not a token
  createdAt: number,
  updatedAt: number
}
```

Repository allowlist metadata can live here or in a separate table. If repo
names are considered sensitive, keep the list on the runner and return it over
the content channel; store only opaque repository IDs centrally.

### 7.4 Device extensions

Extend `devices` and registration responses with:

```ts
{
  deviceKind: "private-agent" | "cloud-runner",
  trust: "user-managed" | "yaver-managed",
  cloudWorkspaceId?: string,
  runnerClass?: "linux" | "macos",
  region?: string,
  agentVersion?: string,
  protocolVersion?: number,
  capabilities?: RunnerCapabilities
}
```

Managed fields are written from the runner's scoped workload credential, not
accepted from an ordinary user session without verification.

### 7.5 Task metadata extensions

Extend `taskRuns` with optional:

```ts
{
  cloudWorkspaceId?: string,
  projectSessionId?: string,
  repositoryId?: string,      // opaque provider ID preferred
  baseRef?: string,
  validationLevel?: "lint" | "typecheck" | "compile" | "test",
  exitCode?: number,
  artifactCount?: number,
  previewTarget?: "web" | "android" | "ios" | "tvos"
}
```

Do not add prompts, source, diff contents, tool output, model output, access
tokens, absolute checkout paths, or artifact bodies.

## 8. Runner-local model

The Cloud Runner is authoritative for content-bearing records.

### 8.1 `ProjectSession`

```go
type ProjectSession struct {
    ID              string
    RepositoryID    string
    GitConnectionID string
    BaseRef         string
    BaseSHA         string
    ReviewBranch    string // yaver/cloud-<session-id>
    Root            string // internal only, never accepted from clients
    State           string // creating, ready, busy, stopped, expired, failed
    CreatedAt       time.Time
    LastActiveAt    time.Time
    ExpiresAt       time.Time
}
```

Recommended filesystem layout:

```text
<workspace-root>/
  mirrors/<opaque-repository-id>.git/
  sessions/<project-session-id>/checkout/
  sessions/<project-session-id>/runs/<run-id>/
  sessions/<project-session-id>/artifacts/<artifact-id>/
```

Paths are never client input. Repository URLs come from the authorized Git
Connection, not an arbitrary task request.

### 8.2 Lifecycle

```text
requested -> cloning -> ready -> active -> stopped -> expired -> deleted
                  |         |       |
                  +-------> failed <-+
```

- Creation resolves the authorized repository ID and base ref, gets a
  short-lived clone token, records the base SHA, and creates a unique review
  branch.
- A Task, Validation Run, and Vibing Session must reference a ready Project
  Session.
- Only one mutating Git operation may run per Project Session at a time.
- Concurrent Project Sessions are isolated and may use different repositories.
- Cleanup stops processes first, revokes temporary credentials, removes the
  checkout and artifacts, then removes the local registry entry.
- Recommended initial retention: active session for seven days after last use,
  stopped processes immediately, logs/artifacts for seven days unless the user
  deletes earlier. Final values require product/privacy approval.

### 8.3 Runner capabilities

The runner reports facts, not marketing tiers:

```ts
type RunnerCapabilities = {
  git: { clone: boolean; pushReviewBranch: boolean; pullRequest: boolean };
  agents: Array<{ id: string; models: string[]; modes?: string[] }>;
  commands: {
    shell: boolean;
    packageManagers: string[];
    docker: boolean;
  };
  validation: {
    lint: boolean;
    typecheck: boolean;
    compile: boolean;
    test: boolean;
  };
  preview: {
    browserFrames: boolean;
    androidEmulator: boolean;
    iosSimulator: boolean;
    tvosSimulator: boolean;
    webrtc: boolean;
  };
  artifact: { download: boolean; maxBytes: number };
};
```

Capabilities are refreshed on runner start and whenever tools change. The
control plane may cache a signed digest, but clients should confirm the live
runner document before enabling an action.

### 8.4 Execution isolation

Recommended minimum managed design:

- one account's Cloud Workspace is isolated from other accounts by a dedicated
  VM or an equivalently strong tenant boundary;
- the Cloud Runner process uses a non-root account;
- each Project Session process receives only its checkout and run directory;
- cgroup/VM CPU, memory, process, disk, and wall-clock limits are enforced;
- host control sockets and credential-broker master credentials are not mounted;
- Git credentials are delivered to a single Git operation through a credential
  helper or file descriptor and then removed;
- outbound network policy is explicit and auditable;
- privileged execution and host Docker socket access are disabled;
- custom shell commands are represented by approved command profiles for tvOS;
  arbitrary host `sh -c` is not exposed;
- secrets are redacted before logs or output are streamed; and
- task/process cleanup is guaranteed on stop, expiry, runner restart, and
  workspace deletion.

Codex may continue to use `--sandbox workspace-write` inside the stronger
boundary. That CLI flag is defense in depth, not the tenant boundary. Claude's
`--dangerously-skip-permissions` must not be used on a managed host without the
strong external boundary and an approved tool policy.

## 9. Runner API v2

Keep existing self-hosted v1 endpoints during migration. Cloud Studio uses a
versioned API that is ID-based and Project Session-scoped.

### 9.1 Status and repository catalog

```http
GET /v2/cloud/status
GET /v2/capabilities
GET /v2/git/connections
GET /v2/git/repositories?connectionId=...&cursor=...
GET /v2/git/repositories/{repositoryId}/refs
```

Responses contain metadata only. The Git token is never returned.

### 9.2 Project Sessions

```http
POST   /v2/project-sessions
GET    /v2/project-sessions
GET    /v2/project-sessions/{id}
POST   /v2/project-sessions/{id}/stop
DELETE /v2/project-sessions/{id}
```

Create body:

```json
{
  "gitConnectionId": "gitc_...",
  "repositoryId": "repo_...",
  "baseRef": "refs/heads/main"
}
```

Do not accept `repoUrl`, `workDir`, or an absolute path from tvOS.

### 9.3 Tasks

```http
POST /v2/project-sessions/{id}/tasks
GET  /v2/project-sessions/{id}/tasks
GET  /v2/project-sessions/{id}/tasks/{taskId}
GET  /v2/project-sessions/{id}/tasks/{taskId}/events
POST /v2/project-sessions/{id}/tasks/{taskId}/continue
POST /v2/project-sessions/{id}/tasks/{taskId}/stop
```

Task create body contains prompt, runner ID, model ID, mode, and reasoning
effort. It does not contain a custom command or path. Validate all selections
against live capabilities and account policy.

Use a resumable event protocol with monotonically increasing event IDs. The
client reconnects with `Last-Event-ID` or an explicit cursor, so tvOS sleep and
network roaming do not duplicate or lose visible output.

### 9.4 Git review actions

```http
GET  /v2/project-sessions/{id}/git/status
GET  /v2/project-sessions/{id}/git/diff?cursor=...
POST /v2/project-sessions/{id}/git/commit
POST /v2/project-sessions/{id}/git/push-review-branch
POST /v2/project-sessions/{id}/git/pull-request
```

Rules:

- the API never accepts a destination branch for push;
- the runner derives `yaver/cloud-<session-id>`;
- default/protected branches cannot be updated directly;
- commit and push are separate explicit actions;
- push confirmation shows provider, repository, branch, changed-file count,
  and current base SHA;
- pull-request creation is optional and uses the same review branch; and
- force push is disabled for the first release.

### 9.5 Validation Runs

```http
POST /v2/project-sessions/{id}/validation-runs
GET  /v2/project-sessions/{id}/validation-runs
GET  /v2/project-sessions/{id}/validation-runs/{runId}
GET  /v2/project-sessions/{id}/validation-runs/{runId}/events
POST /v2/project-sessions/{id}/validation-runs/{runId}/stop
```

The client sends an approved profile such as `lint`, `typecheck`, `unit-test`,
`web-build`, `android-build`, or `ios-simulator-build`, not an arbitrary shell
string. The runner resolves a repository-aware command plan and returns each
actual command, exit code, duration, and truncated/redacted output.

A passing static inspection is never displayed as a passing test. A successful
compile is not a successful test. A generated artifact is not a published app.

### 9.6 Vibing Sessions

```http
POST /v2/project-sessions/{id}/vibing-sessions
GET  /v2/project-sessions/{id}/vibing-sessions/{vibeId}
GET  /v2/project-sessions/{id}/vibing-sessions/{vibeId}/frame
GET  /v2/project-sessions/{id}/vibing-sessions/{vibeId}/events
POST /v2/project-sessions/{id}/vibing-sessions/{vibeId}/stop
```

The start request selects a capability-advertised target. It never contains a
loopback URL or port. The runner owns the dev-server URL, health checks, capture
process, and cleanup.

## 10. Vibing architecture

### 10.1 First releasable lane

Ship browser frames first:

1. runner detects a supported web/Expo-web project;
2. runner selects and starts the approved dev command in the Project Session;
3. runner records the port internally and waits for a health check;
4. `/frame` captures only that registered loopback target;
5. several viewers share a short capture cache; and
6. tvOS polls with adaptive cadence and stops when backgrounded or unfocused.

Call this transport **Frames**, not SSE. Current implementation is PNG polling.
Do not call a WebRTC-to-Frames fallback a successful WebRTC test.

### 10.2 Later lanes

- Browser WebRTC requires a runner broadcaster, `/offer` signaling, a media
  track, and server-issued short-lived TURN credentials.
- tvOS WebRTC remains blocked until a tvOS-compatible native WebRTC build is
  integrated and release-tested.
- Android, iOS, and tvOS simulator previews each require a launch adapter and a
  real capture path. Merely detecting the SDK is not sufficient.
- A macOS Cloud Runner is required for Xcode, iOS Simulator, and tvOS Simulator.

### 10.3 Resource controls

- one capture process/cache per Vibing Session, not per viewer;
- cap image dimensions, bytes, and frame rate;
- stop captures after the last viewer lease expires;
- pause frames when tvOS is backgrounded;
- enforce runner memory headroom before launching Chrome/simulators;
- cap concurrent Vibing Sessions by server-authoritative account policy; and
- record only health/runtime metadata centrally, not frame bodies.

## 11. tvOS Cloud Studio UX

### 11.1 Top-level navigation

Recommended TV navigation:

```text
Studio | Tasks | Vibing | Activity | Settings
```

- **Studio**: prerequisites, repository picker, recent Project Sessions.
- **Tasks**: agent sessions for the selected Project Session.
- **Vibing**: preview target, live frame, health, stop/retry.
- **Activity**: Validation Runs, Git actions, artifacts, and truthful statuses.
- **Settings**: account, runner/model preferences, transport preference, and
  diagnostics. No local provider keys, Git tokens, repository creation, plan
  comparison, or commerce UI.

The existing Devices screen can remain a diagnostic screen for self-hosted
Yaver, but Cloud Studio chooses only the server-assigned Cloud Runner. A private
desktop must not masquerade as a managed runner.

### 11.2 Prerequisite state machine

```text
signed-out
  -> pair on phone
  -> checking account
       -> git-required
       -> cloud-access-unavailable
       -> runner-starting
       -> runner-unavailable
       -> ready
```

`ready` requires both a usable Git Connection and a live assigned Cloud Runner.
Do not auto-connect by hard-coded hostname. If several managed Cloud Workspaces
are eventually supported, select by stable ID and account policy.

### 11.3 Repository and Project Session flow

1. Choose Git Connection if more than one is ready.
2. Choose an authorized repository.
3. Choose a base branch/ref.
4. Create Project Session.
5. Show clone progress and base SHA.
6. Enter the session dashboard with Chat, Build/Test, Vibing, Diff, Commit, and
   Push Review Branch actions.

The UI shows repository owner/name, branch, short SHA, dirty state, runner
class, and capability badges. It never shows the runner's absolute path.

### 11.4 Remote interaction constraints

- Voice may compose prompts but must show the transcription before destructive
  or Git-write actions.
- Siri Remote focus order must put cancel/stop controls in predictable places.
- Long output uses virtualized lists or bounded buffers; the current unbounded
  `ScrollView`/array approach will degrade on long agent and build streams.
- Stop Task, Stop Validation, Stop Preview, Commit, Push, and Delete Session are
  distinct actions.
- Destructive confirmations name the Project Session and affected process/data.
- Reconnection preserves event cursors and selected IDs; it never falls back to
  a local TV runtime.

### 11.5 Apple-safe unavailable copy

Examples:

```text
Cloud Studio isn't available for this account.
Manage Cloud Workspace from your Yaver account.
```

```text
Git connection required.
Connect a repository from your Yaver account, then refresh this screen.
```

```text
Cloud Runner is starting.
This can take a few minutes. You can leave this screen and return later.
```

No button on these screens opens pricing, checkout, or an external payment URL.

## 12. Mobile Workspace repair and separation

### 12.1 Platform-specific modules

Add Metro TV source extension support (`*.ios.tv.tsx`, `*.android.tv.tsx`, and
`*.tv.tsx`) as described by the installed React Native TV fork. The repository
currently has no `mobile/metro.config.js` enabling those extensions.

Split runtime code so the TV bundle cannot import the local Git/LLM module:

```text
mobile/src/lib/coding-runtime-types.ts
mobile/src/lib/coding-runtime.mobile.ts   # iOS/Android local + remote routing
mobile/src/lib/coding-runtime.tv.ts       # remote Cloud Studio adapter only
mobile/src/lib/mobile-git/                # isomorphic-git + Expo FS adapter
mobile/src/lib/cloud-studio-client.ts     # v2 runner client
```

The exact resolver suffixes must be verified in the generated Expo TV Metro
configuration. The goal is compile-time separation, not a runtime `if
(Platform.isTV)` around a statically imported Git module.

### 12.2 Mobile Git definition of done

- binary-safe Git objects and index;
- clone and fetch from GitHub/GitLab over authenticated HTTPS;
- real textual patch diff plus binary-file indication;
- create/check out only `yaver/mobile-*` review branches for pushes;
- explicit commit and separate push confirmation;
- correct add/modify/delete/rename handling;
- no token in AsyncStorage, logs, errors, remote URL, `.git/config`, task
  metadata, or crash reports;
- repository size/file-count guards and cancellable progress;
- cleanup and secure credential revocation; and
- automated integration tests on iOS and Android release-like builds.

tvOS is explicitly excluded from this local Git definition of done. Its Git
dependency is the remote Cloud Runner service.

## 13. Security and privacy requirements

### 13.1 Authentication and authorization

- User session authorizes the tvOS client.
- Workload credential authorizes one Cloud Runner.
- Every runner API request verifies user ownership of the assigned Cloud
  Workspace and Project Session.
- Relay registration verifies device ID and workload credential binding.
- Git broker verifies runner workload identity, Git Connection, repository
  allowlist, operation (`clone`, `fetch`, or review-branch `push`), and expiry.
- Stop/delete operations are idempotent.
- Server-authoritative access and quotas cannot be changed through user
  settings.

### 13.2 Content and metadata

| Data | Location | Retention rule |
| --- | --- | --- |
| Source checkout | Cloud Runner Project Session | Delete on session expiry/deletion. |
| Prompt/output/tool events | Cloud Runner | Bounded documented retention; never Convex. |
| Build/test logs | Cloud Runner | Bounded documented retention. |
| Preview frames | In transit/cache on runner | No durable storage by default. |
| Git/provider credential | Credential broker; short-lived on runner | Revoke/expire; never tvOS/Convex. |
| Task status, runner/model, ref/SHA | Convex | Account metadata retention policy. |
| Artifacts | Cloud Runner/object store if later added | Explicit expiry and delete control. |

Support access to managed workspace content must be technically controlled,
audited, time-bounded, and accurately disclosed. "Zero knowledge" must not be
claimed for the managed environment unless the actual design can support that
statement.

### 13.3 Logging

- Never log bearer tokens, Git credentials, repository URLs containing
  credentials, prompt bodies, source file contents, patches, or full command
  environments in control-plane logs.
- Replace current task-title developer logs for managed runners with opaque task
  ID and sanitized metadata; a task title is prompt content.
- Redact common secret formats in runner streams and validation logs.
- Keep an audit trail of Git connection changes, Project Session creation and
  deletion, review-branch pushes, pull-request creation, and credential
  issuance without recording secret values or diff contents.

### 13.4 API hardening

- versioned request/response schemas and protocol negotiation;
- strict body and output size limits;
- pagination for repos, diffs, tasks, events, runs, and artifacts;
- idempotency key on Project Session creation and Git writes;
- CSRF/state/PKCE protection for the separate Git connection flow;
- no `Access-Control-Allow-Origin: *` on managed content endpoints; and
- rate limits per user, runner, Project Session, and relay route.

## 14. Phased coding plan

### Phase 0: lock terminology and remove misleading claims

Tasks:

1. Adopt the vocabulary in section 2.
2. Replace the obsolete tvOS local-coding note with `mobile/CLOUD_STUDIO_TVOS.md`, the remote
   Cloud Studio contract after implementation begins.
3. Update shared runtime types so TV has no offline execution capabilities.
4. Add an Apple-surface copy guard and remove local credential, local LLM,
   local preflight, repository creation, and local push UI from tvOS.
5. Remove `Relay Pro` upgrade wording and other commerce-oriented copy from
   Apple builds; show entitlement/availability states only.
6. Inventory and stage privacy/terms/landing changes before any managed beta.

Exit criteria:

- TV builds cannot reach local Git/LLM code paths.
- TV UI contains no local token fields or commerce CTA/copy.
- Documentation no longer presents tvOS local coding as the target design.

### Phase 1: repair Mobile Workspace Git

Tasks:

1. Extract a complete binary-safe Expo FileSystem adapter.
2. Implement real diff generation and deletion/rename staging.
3. Add repository limits, cancellation, progress, and error taxonomy.
4. Enforce `yaver/mobile-*` review branches in one shared policy function.
5. Add unit tests for path/ref policy and integration tests for the Git
   round-trip.
6. Add `test`, `typecheck`, and platform build scripts to `mobile/package.json`.
7. Add Metro TV extension configuration and prove the TV bundle excludes local
   Git/provider modules.

Exit criteria:

- authenticated clone -> edit -> diff -> commit -> push review branch passes on
  physical/release-like iOS and Android;
- a binary file survives clone and status without corruption; and
- tvOS compiles without importing Mobile Workspace Git or secret code.

### Phase 2: server-authoritative Cloud access and runner identity

Tasks:

1. Add `cloudAccess`, `cloudWorkspaces`, `gitConnections` metadata, and scoped
   workload credential records.
2. Extend device kind/trust/capability fields.
3. Add authenticated `/cloud/status` for client eligibility and assigned runner
   state; Apple copy remains neutral.
4. Replace hostname-based auto-selection with typed device selection.
5. Make relay registration validate workload identity and device binding.
6. Add rotation, revocation, suspension, deletion, and audit tests.

Exit criteria:

- an ordinary device cannot register as a managed Cloud Runner;
- a workload credential cannot act as a user session;
- a suspended/inactive account cannot create a Project Session; and
- a forged device ID cannot replace another runner tunnel.

### Phase 3: separate Git Connection and credential broker

Tasks:

1. Implement web/account GitHub App installation flow.
2. Implement GitLab OAuth connection with PKCE/state, minimum scopes, refresh
   rotation, and revocation.
3. Store secrets in KMS/Vault-backed storage; store opaque references and
   status in Convex.
4. Implement repo catalog/allowlist and short-lived clone/push credential
   issuance.
5. Add broker audit events and secret-redaction tests.
6. Expose read-only connection/repository readiness to tvOS without tokens.

Exit criteria:

- Yaver sign-in alone grants no repository access;
- tvOS never receives a provider access token;
- runner credentials are repository-, operation-, and time-scoped; and
- revoking a Git Connection prevents new fetch/push operations promptly.

### Phase 4: Project Session manager and API v2

Tasks:

1. Add runner `ProjectSessionManager` with an explicit workspace root.
2. Implement authorized clone, base SHA capture, `yaver/cloud-*` branch creation,
   registry persistence, process ownership, retention, and cleanup.
3. Add `/v2/project-sessions`, session-scoped task APIs, event cursors, Git
   status/diff/commit/push, and capability endpoints.
4. Persist `ProjectSessionID`, repository ID, base/ref/SHA, and internal workdir
   on each Task; never use mutable global `workDir` for v2.
5. Disable custom commands and privileged agent-control endpoints in managed
   policy.
6. Add per-session concurrency locks and account quotas.

Exit criteria:

- two concurrent Project Sessions cannot change each other's directory, branch,
  process, output, or credentials;
- every task has an immutable Project Session;
- only the generated review branch can be pushed; and
- expiry/delete reliably kills processes and removes checkout data.

### Phase 5: real Validation Runs

Tasks:

1. Add framework detection that produces proposed command profiles.
2. Require user selection/approval before first dependency install or broad
   build command.
3. Implement lint, typecheck, compile, unit/integration test, and artifact
   result models.
4. Enforce runner capability/OS checks.
5. Stream structured command start/output/finish events with redaction.
6. Add cancellation, timeout, resource accounting, and accurate failure states.

Exit criteria:

- UI never shows `passed` without a real zero exit code;
- compile and test are distinct;
- Linux never offers Xcode/iOS/tvOS actions;
- stopped/timed-out/OOM runs are not shown as test failures or passes; and
- publishing commands and store credentials remain outside the system.

### Phase 6: source-controlled Vibing controller

Tasks:

1. Implement Project Session-scoped start/status/events/stop endpoints in the Go
   runner; remove dependency on an out-of-repo managed-box implementation.
2. Rename the PNG lane from SSE to Frames in types, settings, and copy.
3. Route all preview calls through the shared Cloud Studio transport client.
4. Bind capture to the registered dev-server target; do not accept client URLs.
5. Add viewer leases, adaptive polling, cache sharing, memory guards, and
   process cleanup.
6. Later add real WebRTC signaling/broadcast/TURN credentials and native preview
   adapters only when end-to-end tests exist.

Exit criteria:

- source checkout alone can reproduce the managed browser-frame lane;
- one and two tvOS viewers share capture work;
- no request can capture an arbitrary host/network URL;
- preview stop/expiry kills dev server and Chrome; and
- UI labels the transport actually used.

### Phase 7: tvOS Cloud Studio UI

Tasks:

1. Add `CloudStudioContext` for account/Git/runner/Project Session state.
2. Replace tvOS generic/local entry flow with prerequisites and repository
   selection.
3. Scope Tasks, Activity, and Vibing to selected Project Session IDs.
4. Add capability-driven agent/model, validation, and preview controls.
5. Add Git status/diff/commit/push-review flow with confirmations.
6. Add resumable event cursors and app lifecycle handling.
7. Bound/virtualize long console, diff, and validation output.
8. Add TV focus, Siri Remote, keyboard, voice, offline, reconnect, and deletion
   tests.

Exit criteria:

- missing Git and missing runner are distinct neutral states;
- tvOS never falls back to local execution;
- task, build/test, Git, and Vibing all target the same Project Session;
- no Apple screen contains purchase/upgrade/pricing/checkout UI; and
- reconnect/relaunch resumes without losing or duplicating visible events.

### Phase 8: privacy, terms, operations, and controlled rollout

Tasks:

1. Update privacy, terms, README, landing, FAQ, developer docs, and in-app legal
   copy to distinguish self-hosted/P2P from managed Cloud Workspace processing.
2. Publish retention, deletion, subprocess isolation, credential, artifact, and
   support-access behavior accurately.
3. Add workspace health, quota, cleanup, security audit, incident, and deletion
   dashboards without collecting prompt/source content centrally.
4. Add account deletion orchestration that revokes Git connections, workload
   credentials, runner tunnels, Project Sessions, and artifacts.
5. Run internal alpha, then a small capability-limited browser/CLI beta before
   enabling native build labels.

Exit criteria:

- public claims match actual infrastructure;
- account and Project Session deletion are verified end to end;
- security review and tenant-isolation tests pass; and
- only proven runner/preview capabilities are enabled remotely.

## 15. File-by-file implementation map

### Mobile/tvOS

| File/area | Planned change |
| --- | --- |
| `mobile/app/(tabs)/tasks.tsx` | Remove tvOS local branch; bind task list/create/continue to `projectSessionId`; use v2 event cursor. |
| `mobile/app/(tabs)/vibing.tsx` | Remove local preflight branch; use session-scoped preview API; label Frames accurately; remove raw relay URL building. |
| `mobile/app/(tabs)/settings.tsx` | Hide/remove local provider and Git token UI on TV; remove Apple commerce-oriented transport copy; show runner diagnostics only. |
| `mobile/app/(tabs)/home.tsx` | Replace device-centric cards with Cloud Studio prerequisite/session summary. |
| `mobile/app/(tabs)/devices.tsx` | Show device kind/trust; keep self-host diagnostics separate from managed Cloud Studio selection. |
| `mobile/src/context/DeviceContext.tsx` | Remove hard-coded preferred hostname; select managed runner by typed server assignment; do not sync account-global local mode into TV. |
| `mobile/src/lib/quic.ts` | Evolve into/shared with v2 Cloud Studio transport; expose active relay path/headers internally rather than hand-building URLs. |
| `mobile/src/lib/coding-runtime.ts` | Split types, phone local Git runtime, and TV remote adapter. |
| `mobile/src/lib/secure-storage.ts` | Keep phone secret storage; TV needs only Yaver session storage, not Git/provider secret APIs. |
| `mobile/src/lib/auth.ts` | Add Cloud status, Git connection metadata, workspace/device types; rename/migrate mobile coding preference. |
| `mobile/metro.config.js` | Add TV-specific resolution and prove local Git exclusion. |
| `mobile/CLOUD_STUDIO_TVOS.md` | Cloud Studio tvOS runtime and publishing-boundary contract. |

### Shared

| File/area | Planned change |
| --- | --- |
| `shared/coding-core/runtime.ts` | Make tvOS remote-only; add Cloud Workspace, Project Session, runner capability, validation, and Vibing session types. |
| `shared/coding-core/companion.ts` | Treat TV as a rich remote client, not a credential/filesystem holder. |
| `shared/coding-core/validation.ts` | Add executor ID/ref/SHA/exit status and structured validation levels. |
| `shared/coding-core/README.md` | Document the new surface matrix and terminology. |

### Backend/control plane

| File/area | Planned change |
| --- | --- |
| `backend/convex/schema.ts` | Add Cloud access/workspace/Git metadata/workload credentials; extend devices and task runs. |
| `backend/convex/devices.ts` | Verify typed managed registration and scoped heartbeat credentials. |
| `backend/convex/http.ts` | Add server-authoritative cloud status and scoped runner routes; validate all request unions rather than forwarding raw strings. |
| `backend/convex/taskRuns.ts` | Add project/validation/preview metadata without content. |
| `backend/convex/userSettings.ts` | Migrate `codingMode` to phone-specific preference; keep entitlements out of settings. |
| OAuth web routes | Keep Yaver sign-in separate; add a dedicated Git Connection flow and credential broker integration. |

### Go agent/Cloud Runner

| File/area | Planned change |
| --- | --- |
| `desktop/agent/tasks.go` | Store immutable Project Session ID/workdir per Task; remove global workdir dependency for v2; managed runner policy. |
| `desktop/agent/httpserver.go` | Add v2 session/task/Git/validation/Vibing routes; restrict dangerous v1 admin routes on managed Cloud Runners. |
| `desktop/agent/auth.go` | Add scoped workload identity and typed device registration. |
| `desktop/agent/secrets.go` | Keep for self-host; use broker/KMS adapter and short-lived Git credential helper for managed mode. |
| `desktop/agent/sandbox.go` | Retain as self-host defense in depth; do not treat it as tenant isolation or product naming. |
| `desktop/agent/discovery.go` | Keep self-host discovery; managed Cloud Studio uses authorized repository catalog instead. |
| new `project_sessions.go` | Session lifecycle, registry, path resolution, Git locks, retention, cleanup. |
| new `git_provider.go` | Broker client, allowed repo/ref resolution, review-branch policy, status/diff/commit/push. |
| new `validation_runs.go` | Approved command profiles, structured events, cancellation, resource result. |
| new `vibing_sessions.go` | Dev-server lifecycle, target registry, frames, health, leases, cleanup. |
| legacy self-hosted runner note | Removed; managed Cloud Runner boundaries now live in this architecture and `mobile/CLOUD_STUDIO_TVOS.md`. |

### Relay

| File/area | Planned change |
| --- | --- |
| `relay/protocol.go` | Add protocol version and scoped registration proof fields. |
| `relay/server.go` | Validate device/workload identity, bind device ID, prevent tunnel replacement by unauthorized callers, add per-route limits. |
| `relay/tunnel.go` | Preserve event streaming and size limits; test long-lived v2 event connections and cancellation. |

### Web and legal/docs

| File/area | Planned change |
| --- | --- |
| `web/app/coding/page.tsx` | Use the same Cloud Workspace/Project Session API and vocabulary. |
| `web/app/vibing/page.tsx` | Use source-controlled session-scoped Vibing API and truthful transport labels. |
| `web/app/dashboard/page.tsx` | Account-level Git/Cloud status and management; Apple apps only consume the resulting state. |
| `README.md`, landing, FAQ, docs | Distinguish private P2P mode from managed Cloud Workspace data processing and remove obsolete no-paid-tier claims. |
| mobile/web privacy and terms | Describe managed processing, retention, deletion, credentials, subprocesses, artifacts, and publishing boundary. |

## 16. Test architecture and release gates

### 16.1 Unit tests

- capability calculation and UI gates;
- Apple copy guard rejects forbidden commerce terms/components in Apple routes;
- review-branch ref validation;
- Project Session ID-to-path resolution and traversal rejection;
- task/session ownership checks;
- command profile resolution by framework and runner class;
- Git credential broker scope/expiry/revocation;
- event cursor replay and deduplication;
- secret redaction; and
- retention/cleanup state transitions.

### 16.2 Integration tests

1. GitHub/GitLab fixture connection -> repo list -> clone -> branch -> commit ->
   review push.
2. Two repositories and two Project Sessions in parallel; assert isolation.
3. Two tasks in one session; assert serialization only where Git mutation
   requires it.
4. Stop/restart runner; recover metadata and mark orphaned processes correctly.
5. Revoke Git connection mid-session; existing checkout remains readable but
   fetch/push fails safely.
6. Browser project -> install -> test -> build -> Vibing Frames -> stop ->
   cleanup.
7. Relay reconnect during task, validation, and frames with cursor recovery.
8. Account suspension and deletion revoke access and remove content.
9. Malicious registration cannot replace another runner tunnel.
10. Prompt/output/source never appears in Convex records or control-plane logs.

### 16.3 Platform gates

- `npx tsc --noEmit` for mobile;
- iOS release build without codesign;
- Android release build;
- clean tvOS prebuild plus tvOS release build/simulator smoke test;
- physical Apple TV focus, remote, keyboard, voice, suspend/resume, and long
  output test;
- Go race tests for session/task/preview managers;
- Linux runner end-to-end build/test/Frames gate;
- macOS runner gate before showing iOS/tvOS simulator capabilities; and
- web build/E2E for Git connection and Project Session management.

### 16.4 Truthfulness gate

For every visible result, record and test:

```text
executor + Cloud Workspace + Project Session + repository/ref/SHA
+ capability + actual command profile + started/finished + exit outcome
```

If any field needed to prove execution is missing, show `not verified` rather
than a green result.

### 16.5 Apple-surface gate

Automated source/snapshot scans for iOS/tvOS must fail on:

- purchase/buy/subscribe/upgrade/pricing/checkout/payment copy in Cloud Studio
  screens;
- external payment links or pricing routes;
- local Git/provider credential controls in tvOS;
- a local/offline execution fallback on tvOS; or
- store publishing controls or credential fields.

## 17. Recommended first vertical slice

Build the smallest honest end-to-end slice before native builds:

1. separate Git Connection exists and exposes one authorized test repository;
2. one typed Linux Cloud Runner registers with scoped workload identity;
3. tvOS sees neutral ready/unavailable states;
4. tvOS creates one Project Session from repo + base branch;
5. Codex runs one task inside that session;
6. tvOS displays cursor-resumable output;
7. runner executes one real repository test profile;
8. runner starts one browser Vibing Frames session;
9. tvOS reviews a real diff, commits, and pushes `yaver/cloud-*`; and
10. delete removes processes, checkout, logs, and temporary credentials.

Do not include WebRTC, native simulators, multiple Cloud Workspaces, artifact
downloads, pull requests, or store release automation in this first slice.
They should follow only after the identity, Git, isolation, event, and cleanup
contracts are proven.

## 18. Definition of Cloud Studio MVP done

The MVP is done only when all statements below are true:

- tvOS requires both Git and an assigned Cloud Runner.
- tvOS has no local Git/LLM runtime and holds no Git/provider secrets.
- Apple surfaces contain no purchase/upgrade/pricing/checkout path.
- Mobile Workspace has a tested binary-safe Git implementation.
- A Cloud Runner is a typed, server-authorized device with scoped workload
  identity.
- Relay registration validates that identity and device binding.
- Every task, validation, Git action, and preview belongs to one immutable
  Project Session.
- Concurrent Project Sessions cannot cross paths, processes, output, or
  credentials.
- Git pushes can target only generated Yaver review branches.
- Builds/tests are real, capability-gated, and reported truthfully.
- The browser Frames lane is source-controlled, session-scoped, and reproducible.
- Publishing and store credentials remain outside Cloud Studio.
- Content retention/deletion works and public privacy/terms copy describes the
  managed environment accurately.
