# Yaver Datacenter Architecture and Delivery Plan

Status: implementation plan; code remains the source of truth  
Last audited: 2026-09-06  
Initial scope: one Yaver owner using their own machines

## Active dogfood execution profile

The owner authorized the first continuous implementation run on 2026-09-06
with these constraints. They narrow execution but do not remove architecture or
backlog coverage:

- Run the implementation through the Yaver Go agent on the owned Ubuntu 4 GB
  node. The daemon owns the run and drives an interactive tmux seat so closing
  the initiating client does not stop it; recreate a vanished runner tmux seat
  and keep kicking until the backlog converges or a genuine external/human
  blocker is recorded.
- Use Codex `gpt-5.6-sol` with medium reasoning as the primary implementation
  runner. The coordinator may dispatch bounded independent work to other ready
  runners when useful, but Codex remains the primary doer and must integrate and
  verify their outputs.
- The canonical integration target is `main`. Pull/rebase before each landed
  slice, use path-scoped commits, preserve concurrent work, and push every
  gate-verified slice. Yaver-managed temporary worktrees are allowed as an
  isolation mechanism; no temporary branch becomes a second product line.
- Work through the task IDs in dependency order. Before each task, audit the
  current code and tests again. Update checkbox state only in a new commit after
  the code and its consumers are verified.
- Use browser automation for web and genuine RN-web device-context validation.
  Use Redroid and available Android emulator/device lanes for Android
  phone/tablet, Wear OS, Android TV, Android Auto/car, and XR cases wherever the
  Ubuntu node can operationally prove them. A missing accelerator, image, or
  physical device is a structured capability gap, not a green test.
- Apple/iOS/macOS/tvOS/watchOS/visionOS code and shared protocol/UI wiring remain
  in scope, but do not run Xcode, iOS simulator, archive, codesign, TestFlight,
  or other Apple-only builds on this Ubuntu phase. Record the exact handoff test
  that a later eligible Mac must run.
- Do not deploy Yaver, publish npm, push release tags, submit to App Store/Play,
  create paid cloud resources, or mutate sibling-project/customer resources.
  Normal source commits and pushes to `main` are authorized for this run.
- Keep the 4 GB resource limit visible: bound parallelism, run targeted tests
  before broader gates, avoid concurrent heavy Gradle/Go/Node jobs, and preserve
  enough memory/disk for the Yaver daemon and tmux runner.
- This run is itself a Datacenter dogfood case. Any manual discovery, recovery,
  runner restart, source-isolation, browser, Redroid, or placement step that the
  product cannot express becomes a backlog item and then a product capability.

## 1. Product contract

Yaver Datacenter is a private capability fabric for one Yaver user's machines.
It lets Tasks, Vibing, Dogfood, Browser, Hermes, WebRTC, builds, tests, CI,
deploys, storage, simulators, physical devices, and later inference use the
best available owned machine without making the user manage a static topology.

The user connects to **Yaver**, not to a required machine. A machine is a
multipurpose node whose role changes per workload phase. One node may run a
coding agent, another may render the exact revision it produced, a third may
run browser automation, and a fourth may provide an SSD-backed cache and
artifact store. The same nodes may receive different roles on the next job.

Datacenter is not:

- a second device inventory;
- a generic homelab or Kubernetes dashboard;
- an always-visible topology screen;
- a reason to put prompts, source, paths, logs, or secrets in Convex;
- permission to mix owners or weaken relay/device-key isolation;
- permission to make deploy, publish, or destructive operations retry blindly;
- a permanent assignment of “build machine”, “renderer”, or “inference box”.

The durable product seam is the capability, workload, lease, source, artifact,
and placement protocol. A future Yaver-operated multi-tenant fleet can
implement that protocol only after a separate isolation, quota, metering, and
tenant-admission design. That future is explicitly out of v1 scope.

## 2. Non-negotiable invariants

1. Existing direct-device APIs and explicit `deviceId` calls keep working.
2. Any reachable same-owner Go agent can accept a workload as an ingress
   gateway. A coordinator is not required for the client request path.
3. Capability claims produce candidates; an operational probe and atomic lease
   produce admission.
4. A hard device, pool, target, owner, or security restriction is never widened
   because no candidate matched.
5. The renderer/build/test consumer verifies the exact source revision or patch
   hash before starting.
6. Strict single-writer operations carry a monotonic fencing term. A stale
   coordinator cannot deploy, land source, publish, reserve a device, or mutate
   shared storage.
7. Prompts, stdout, source, absolute paths, endpoints, credentials, and raw
   artifacts stay P2P/local/user-owned. Convex receives compact prompt-free
   state only.
8. The relay remains pass-through and same-owner/access-graph scoped. It holds
   no device keys and authorizes no workload.
9. Every refusal has a stable code, user-visible cause, and invocable route to
   its fix when a deterministic fix exists.
10. Advisory discovery, scoring, and telemetry are wall-clock bounded and
    cannot block an existing working path.
11. Datacenter UI is progressive disclosure. Default surfaces show the answer,
    not the inventory.
12. Automatic retry is allowed only for operations whose idempotency contract
    explicitly permits it.

## 3. Current code foundations

Code must be re-audited before each task. As of the date above:

- `desktop/agent/console_machines.go` owns `MachineInfo`, coarse machine
  capabilities, same-owner discovery, and remote `/agent/capabilities`
  enrichment.
- `desktop/agent/capabilities_snapshot.go` performs a richer local snapshot for
  runner, Hermes, connectivity, TestFlight, and Play Store readiness.
- `desktop/agent/bus.go` provides same-owner distributed pub/sub and retained
  presence across direct/LAN/relay transports.
- `desktop/agent/leader.go` elects a soft deterministic leader from each
  peer's local view and explicitly does not prevent split brain.
- `desktop/agent/agent_mode.go`, `agent_mesh.go`, and `graph_slice.go` provide
  dependency graphs, limited placement, parallel execution, local worktrees,
  and remote slice metadata.
- `desktop/agent/autorun_leases*.go` provides typed local source/build/seat/land
  leases and a git-ref/CAS fleet tier.
- `desktop/agent/buildbus.go` serializes builds across processes on one host.
  It is not a cross-machine lease service.
- `desktop/agent/shared_storage.go` supports configured local, SMB, WebDAV,
  Storage Box, and S3 browsing/read/search paths.
- `desktop/agent/object_storage.go` supports S3-compatible list/upload/delete.
- `desktop/agent/ops.go` already gives MCP, CLI, HTTP, and remote machines one
  typed verb dispatcher with owner/scoped-session gates.
- `web/lib/connectionFanout.ts` and its mobile twin already warm several
  per-device connections while keeping focused-device failures isolated.
- Convex device heartbeats already carry hardware, pressure, storage, runner,
  and coarse deploy capability state with active/idle coalescing.

These are adapters into Datacenter. They must not be cloned into competing
implementations.

## 4. Architecture

```text
web / mobile / desktop / TV / watch / car / spatial / CLI / MCP
                           |
                    FabricConnection
                  any reachable gateway
                           |
             deterministic planner + policy
                           |
          candidate -> operation probe -> node lease
                           |
      source transfer -> worker attempt -> typed artifacts
                           |
        P2P live state + compact Convex coordination state
```

There are three product layers:

### 4.1 Devices

Devices retain identity, ownership, reachability, wake/recovery, agent version,
and direct selection. A Datacenter node is an existing device; there is no
second machine ID.

### 4.2 Personal Datacenter

The optional advanced layer owns node capability digests, resource pools,
policies, readiness, jobs, attempts, reservations, storage services, artifact
lineage, placement explanations, and proposals.

### 4.3 Workload orchestration

A workload is a DAG of phases with explicit source inputs, outputs, hard and
preferred capabilities, resource units, retry policy, idempotency class, and
approval class. Known Yaver workflows use deterministic templates. An AI runner
may propose a DAG for an unstructured request, but the Go planner validates the
typed graph and owns admission.

## 5. Domain model

### `DatacenterPolicy`

- schema/protocol version;
- enabled projects and workload kinds;
- default automatic-placement mode;
- device/pool allow and deny selectors;
- affinity preferences;
- energy, thermal, time, cost, and network policies;
- interactive versus background policy;
- proposal and remediation policy;
- release approval policy;
- retention and replication policy.

### `NodeCapabilityDigest`

- `schemaVersion`, `protocolVersion`, `generatedAt`, `expiresAt`, `digest`;
- `deviceId`, OS/arch, agent compatibility class;
- capability classes and readiness codes;
- allocatable coarse resource classes;
- pressure, draining, and active-work class;
- storage service summaries;
- no credentials, paths, prompts, endpoints, or raw diagnostic evidence.

### `CapabilityProbe`

- workload/capability key;
- `ready | blocked | unknown | probing`;
- stable reason code;
- measured time and expiry;
- local-only evidence;
- safe roaming summary;
- route-to-fix `{label, method, path, stream}`;
- resource units the probe proves can be admitted.

### `ResourcePool`

A selector and preference, not duplicated membership. Examples: Apple
builders, Android builders, coding runners, browser/render lab, storage nodes,
and inference nodes. Membership is recalculated from current capability data.

### `WorkloadSpec`

- `workloadId`, idempotency key, project identity, kind and target;
- phase DAG;
- source input and required output types;
- hard/preferred capabilities and resource vector;
- pool/device affinity or exclusion;
- retry/idempotency and failure policy;
- approval class;
- privacy and retention class.

### `Job` and `JobAttempt`

`Job` represents user intent and the phase DAG. `JobAttempt` binds one phase to
one node, exact input, admission lease, timestamps, state, structured output,
failure code, and artifacts. Retries create attempts; they do not erase
history.

### `NodeLease`

- resource key and units;
- holder job/attempt;
- lease ID, monotonic term, expiry and renewal time;
- node-local versus account-global authority;
- exclusive named resources such as a device, simulator, signer, browser
  profile, port, source landing branch, publish target, or storage writer.

### `ArtifactRef`

- content hash, type, size and producer attempt;
- source revision/patch identity;
- storage capability/location reference without credentials;
- intended consumers, retention and replica state.

### `PlacementDecision`

- accepted and rejected candidates;
- hard rejection codes;
- rank factors;
- selected node and lease outcome;
- one-sentence explanation suitable for every UI surface.

## 6. Logical connection contract

Clients construct a `FabricConnection` from existing per-device connections.

- `connected`: at least one owned agent answers an authenticated operational
  probe.
- `degraded`: Yaver is reachable, but the current requested workload lacks a
  capability, route, authority, or redundancy.
- `offline`: no owned agent is reachable.

The selected device is not a prerequisite screen. Workload submission defaults
to `machine: "auto"`; `deviceId` remains an expert override. Clients display
the chosen nodes under Details and expose `Change` without blocking the common
path.

Gateway submission uses an idempotency key. If a gateway disappears before
admission, the client submits the same key to another agent. Once admitted, the
worker owns execution and streaming. A replacement gateway attaches directly
to the worker or artifact stream.

## 7. Coordinator and failover algorithm

### 7.1 Soft coordinator eligibility

An agent is eligible when it is:

- owned by the same user/access graph;
- protocol-compatible;
- reachable over at least one bidirectional fabric path;
- healthy and not draining;
- below critical resource pressure;
- configured to participate in coordination.

Every agent calculates the same deterministic ordering from same-owner bus
presence:

1. explicit advanced coordinator preference;
2. current healthy coordinator stickiness;
3. always-on and AC-powered posture;
4. direct/relay connectivity quality;
5. control-plane health and headroom;
6. recent stability and uptime;
7. stable `deviceId` tie-break.

Keep the current coordinator while eligible. A better candidate must remain
materially better for a stability window before taking over. Liveness failure
bypasses the window. Use short P2P keepalives during active work and a slower
idle cadence. Convex idle heartbeats are discovery/fallback, not the election
clock.

### 7.2 Fencing

Soft leadership grants no exclusive authority. Strict operations acquire an
atomic lease that returns `{leaseId, term, holder, expiresAt}`. Every mutation
includes the term; nodes reject stale terms. Release is holder-and-term scoped.

Account-global leases use Convex CAS only while work is active. Physical
resources use node-local leases. No idle coordinator renewal writes.

### 7.3 Failure matrix

| Failure | Required behavior |
|---|---|
| Gateway dies before dispatch | Client retries same idempotency key elsewhere |
| Coordinator dies after admission | Worker continues; new coordinator adopts attempt |
| Worker dies | Lease expires; retry only if phase is restart-safe |
| Partition | Read-only planning may continue; strict mutation requires valid fence |
| Source transfer breaks | Resume by content hash; never execute partial input |
| Render gateway changes | Render node keeps session; client reattaches |
| Deploy response is lost | Query remote store state before any retry |
| Convex unavailable | Running local attempts continue; unsafe new global allocation waits |

### 7.4 Scheduled work

Each schedule has a stable ID. Every occurrence has a deterministic occurrence
idempotency key and ownership lease. Only its fenced holder may dispatch it.
Private schedule payloads remain local/user-owned; prompt-free next-fire,
claim, and outcome metadata may roam.

## 8. Capability discovery

Discovery is layered; no layer may pretend to prove the next one.

1. **Claim:** OS, architecture, hardware, configured profile, tool presence.
2. **Operational probe:** bounded invocation of the capability users need.
3. **Availability:** live pressure, queue, exclusive-resource state.
4. **Admission:** successful typed lease for this workload.

Every capability has:

- a versioned key;
- claim and probe timestamps/TTL;
- readiness state and stable code;
- coarse resource supply;
- route to fix;
- safe summary for clients/Convex;
- local-only detailed evidence.

### Capability taxonomy

- Transport: HTTP/SSE, relay, QUIC/native, LAN, WebRTC signaling/data.
- Runner: Codex, Claude Code, OpenCode and others; executable, auth, accepted
  models, seat and concurrency.
- Source: checkout, revision, clean/dirty, patch apply, fetch/push, large files.
- Browser: Chromium, headed/headless, profiles, mobile descriptor, capture.
- Hermes/native: Node, Hermes compiler, bundle, push, install, launch.
- Apple: Xcode and exact SDK/runtime for iOS, iPadOS, tvOS, watchOS, visionOS,
  macOS, simulators/devices, signer and upload readiness.
- Android: JDK, Gradle, SDK/NDK, APK/AAB signing, emulator acceleration,
  Android, Auto, TV, Wear, XR, Play upload readiness.
- Desktop/package: Go/Rust/Node/Electron, target triples, native test/sign,
  Windows `.exe`, Linux/macOS bundles, npm pack/publish.
- Render/Dogfood: exact app revision, server, viewport/device context, input,
  capture, feedback path.
- Storage: file, cache, artifact, source-snapshot services; read/write/checksum,
  quota, latency, throughput, snapshot and replica state.
- Inference: engine/model/quantization, accelerator/UMA/VRAM, context/KV,
  batch/concurrency, queue, tokens/sec and time-to-first-token.
- Physical lab: simulators, emulators, phones, tablets, watches, TVs, headsets,
  cars and capture devices as reservable resources.

Expensive probes are cached locally by capability-specific TTL. Probe fan-out
is bounded and parallel. A timeout becomes `unknown/timeout`, not a frozen
workload submission.

## 9. Placement and admission algorithm

```text
intent
  -> deterministic/validated phase DAG
  -> immutable source identity
  -> hard capability/policy filter
  -> rank cached candidates
  -> bounded operation probe on leading candidate
  -> atomic resource lease
  -> transfer and verify input
  -> execute and stream
  -> hash and register artifacts
  -> release or policy-safe retry
```

Hard filters include owner, access graph, device/pool policy, reachability,
OS/arch, exact SDK/runtime, operational runner, source capability, RAM, disk,
simulator/device, browser/capture, signer/upload, storage access, and approval.

Ranking may use affinity, current headroom, queue time, warm source/cache/model,
data locality, measured duration/reliability, latency, energy preference, and
failure-domain diversity. A rank never overrides a hard filter.

Example resource vector:

- CPU shares;
- RAM floor and allocatable bytes;
- GPU/UMA/VRAM bytes;
- scratch bytes and I/O class;
- runner seat;
- Xcode/SDK or Android toolchain;
- simulator/emulator or attached-device lease;
- browser profile, port and encoder slot;
- signing keychain;
- source landing branch;
- deploy/publish target;
- storage writer and reserved bytes.

## 10. Source slicing and artifact lineage

Never share a mutable worktree across concurrent machines.

- Clean source: repository identity plus commit; destination fetches and
  verifies.
- Dirty source: base commit plus bounded patch manifest containing paths,
  modes, deletions, content hashes, and overall hash.
- Large/generated source: content-addressed artifacts transferred P2P or via
  user-owned storage.
- Parallel coding: path/semantic ownership lease; each slice returns a commit
  or diff.
- Landing: merge/rebase under one fenced landing lease.
- Render: consumes a source snapshot, returns the loaded revision, then starts
  or refreshes.
- Evidence: logs, screenshots, video, `.xcresult`, APK/AAB/IPA/package and
  checksums bind to attempt and revision.

`node_modules`, DerivedData, Gradle working directories, emulator data and
writable git trees remain node-local scratch. Caches use tool-native or
content-addressed protocols.

## 11. Shared file server, SSD, and object storage

Shared storage is a first-class schedulable capability, not a generic path.
One physical SSD or S3-compatible bucket exposes isolated logical namespaces:

```text
files/                         human file-server semantics
cache/<tool>/<platform>/       disposable content-addressed/tool-native cache
artifacts/<project>/<job>/     immutable build/test/render evidence
sources/<project>/<revision>/  immutable source snapshots and bundles
```

### 11.1 Backends

- Local filesystem/attached SSD: exported by an owned Yaver agent, root scoped
  to a configured directory.
- SMB: existing remote share support; add bounded write/probe semantics.
- WebDAV/Hetzner Storage Box: existing remote support; add bounded
  write/probe semantics.
- S3-compatible: Hetzner Object Storage, AWS S3, Cloudflare R2, MinIO, B2 or
  equivalent through explicit profile configuration.

Backend credentials remain in the node's secure local configuration/vault.
Capability digests expose only a profile ID, backend class, readiness, logical
services and coarse capacity—not endpoints, bucket names, paths or usernames.

### 11.2 Readiness

Inventory checks are insufficient. Storage readiness includes:

- configured root/bucket exists;
- bounded list/read probe;
- optional explicit write/delete round-trip for writable profiles;
- free, total and reserved bytes where measurable;
- quota/usage bucket for object storage when available;
- checksum/ETag behavior;
- latency and recent throughput class;
- read-only policy;
- snapshot age and replica state;
- stable failure code and route to fix.

The default status call is non-destructive and bounded. The explicit deep
probe may write a random small object beneath `.yaver-probe/`, read/verify it,
and delete exactly that object. It never tests at an unresolved or broad path.

### 11.3 Write semantics

- File writes use a size limit, safe root join, temporary sibling, fsync and
  atomic rename where supported.
- Immutable artifact/source keys are create-if-absent by content hash.
- Cache writes may replace only their exact computed key.
- S3 multipart upload is resumable and ends with checksum verification.
- Deletes require the exact profile, namespace and object key. Artifact/source
  deletion follows retention policy and never recursive guessed paths.
- Multiple writers need an explicit namespace/object lease; a filesystem mount
  is not a distributed lock.

### 11.4 Scheduling locality

Placement prefers nodes with local source/cache/artifacts only after hard
capability filters. An SSD node may serve storage plus light compute while I/O
headroom permits. Heavy local work must not starve active storage clients.

## 12. Workload templates

### Vibing/Dogfood

`code -> checkpoint -> transfer -> renderer verifies revision -> Hermes/native
or dev server -> target launch -> WebRTC/pixel evidence -> feedback`

Interactive coding and render sessions are sticky. Migration occurs only after
source and session handoff is proven. Auto-render remains opt-in and never
reloads while the coding state is queued/running.

### Browser automation

Reserve a browser node, correct device context, authenticated profile when
allowed, ports and capture encoder. Bind screenshots/video/logs to the exact
revision and return them to the task surface.

### Apple matrix

Independent iOS/iPadOS, watch companion, tvOS, visionOS and macOS phases use
exact Xcode/SDK/runtime/device/signer probes. Build/test/archive/export/upload
are distinct phases. Upload has a global target fence and human/account policy.

### Android matrix

Phone/tablet plus Auto, Wear, TV and XR are independent jobs with exact Gradle,
SDK/NDK, emulator/device and signing requirements. On the current 8 GB
validation Mac, policy permits only one Gradle build at a time with existing
worker/heap caps.

### Web/backend/npm/CLI/desktop

Shard tests and builds where safe. Produce Go target binaries including Windows
`.exe`; run native signing/testing only on eligible OS nodes. Package/checksum
in parallel. npm publish/tag is one fenced, approved mutation.

### CI

GitHub/GitLab job or Yaver-native pipeline becomes a workload. Match upstream
labels/tags, then perform Yaver operational admission. Prefer one-job ephemeral
runner isolation. Stream logs upstream and retain a compact Yaver attempt
summary plus user-owned artifacts.

### Deploy

Resolve the canonical target, allocate version once, verify source, probe exact
builder/signer/uploader capability, acquire node and global target leases,
build/hash/preflight, obtain approval, upload once, and reconcile remote state
before any retry.

### Inference

Treat inference as model-memory and queue reservations, not a `localLlm`
boolean. A future high-memory Mac Studio can serve models and still accept
Apple/coding work when safe headroom remains.

## 13. Convex cost and privacy

- Reuse adaptive active/idle heartbeat cadence.
- Compute static capability digests locally and sync only on hash change plus a
  long refresh.
- Piggyback coarse allocatable state only when it changes.
- Keep high-frequency metrics in node-local ring buffers and query P2P for live
  tie-breaking.
- Persist one prompt-free job/attempt row per state transition, not progress
  ticks.
- Create/renew Convex fences only for active account-global resources.
- Keep prompts, stdout, patches, files, absolute paths, endpoints, credentials,
  simulator/device private names, and raw artifacts out of Convex.
- Retain bounded recent attempt summaries and compact duration/reliability
  aggregates for proposals.

Every new Convex payload must be added to privacy tests with explicit forbidden
fields and path-leak coverage.

## 14. API, ops, MCP, CLI, and event contracts

Prefer one typed implementation exposed through several adapters.

### Read-only first

- `GET /datacenter/status`
- `POST /datacenter/probe`
- `POST /datacenter/plan`
- ops/MCP `datacenter_status`
- ops/MCP `datacenter_probe`
- ops/MCP `datacenter_plan`
- CLI `yaver datacenter status|probe|plan`

### Execution

- `POST /datacenter/jobs`
- `GET /datacenter/jobs/{id}`
- `POST /datacenter/jobs/{id}/cancel`
- `POST /datacenter/jobs/{id}/retry`
- `GET /datacenter/jobs/{id}/events` using SSE
- ops/MCP equivalents through the existing `ops` grand-tool

### Storage

- `GET /datacenter/storage`
- `POST /datacenter/storage/probe`
- `POST /shared-storage/write`
- `POST /shared-storage/mkdir`
- exact-object delete with confirmation/retention checks
- artifact put/get/head and source snapshot put/get

Existing `/shared-storage/*`, `/agent/capabilities`, `/capabilities/snapshot`,
graph, task, build, deploy, and direct-device routes remain supported.

### Events

Typed event families:

- coordinator presence/change;
- capability digest/change;
- probe state;
- job/attempt state;
- lease acquired/renewed/rejected/expired/released;
- source transfer progress/verified;
- artifact available;
- proposal created/dismissed/applied;
- structured failure and route-to-fix.

SSE/P2P events carry live detail. Convex stores only compact state transitions.

## 15. UI information architecture and wiring

Datacenter is entered from `Devices -> More/… -> Datacenter (Advanced)`. It is
not a new default navigation destination.

### 15.1 Shared presentation contract

Every client consumes the same typed view model:

- fabric connectivity state;
- current job summary;
- one placement explanation;
- one blocking reason and route-to-fix;
- approval request;
- optional node/storage/job details.

Clients never implement scheduling or parse error prose. Stable enums/codes and
server-provided short labels prevent drift.

### 15.2 Default device presentation

Show device name and honest connectivity. Show at most one useful current line,
such as `Building Android · 8m` or `2 jobs`. Do not show a grid of runner,
renderer, storage, SDK, simulator, and inference chips. Alternatives appear
only when the preferred/current node needs attention.

### 15.3 Advanced overview

Summary rows:

- Ready capacity;
- Running/queued;
- Needs attention;
- Storage status;
- one primary action.

Drill-down destinations:

- Jobs;
- Nodes and dynamic pools;
- Storage;
- Policies;
- Proposals.

Placement explanation example:

`Rendering on Mac B — required visionOS runtime is ready; source verified.`

Full score vectors, probe evidence, leases and raw metrics remain under Details.

### 15.4 Web

Primary wiring targets:

- `web/components/dashboard/DevicesView.tsx`: add the Advanced entry and quiet
  current-work summary; remove/reduce static role-chip accretion as dynamic
  placement ships.
- `web/components/dashboard/MachineRolesCard.tsx`: migrate fixed assignments to
  affinity/fallback preferences.
- `web/lib/agent-client.ts`: typed Datacenter status/plan/job/storage methods.
- New advanced components under `web/components/dashboard/datacenter/` for
  overview, jobs, nodes/pools, storage, policies, and proposals.
- `web/app/dashboard/page.tsx`: route/section wiring only after the advanced
  entry is enabled.

Web supports full policy editing, node/probe/lease detail and storage setup.

### 15.5 React Native phone and tablet

Primary wiring targets:

- `mobile/src/context/DeviceContext.tsx`: compose existing device clients into
  fabric connectivity without altering native transport ladders.
- `mobile/src/lib/quic.ts`: typed Datacenter HTTP/SSE methods.
- `mobile/app/(tabs)/more.tsx`: Advanced Datacenter entry near Devices/Storage.
- `mobile/app/shared-storage.tsx` and `mobile/app/storage.tsx`: storage
  readiness, route-to-fix and namespace views.
- New `mobile/app/datacenter.tsx`: overview, current jobs, approvals,
  cancel/retry and simple preferences.
- Existing Tasks/Vibing/Dogfood views: show one placement explanation and
  `Change`; keep last good render visible.

Phone/tablet does not expose a dense topology editor by default.

### 15.6 macOS/Electron desktop

Use the same web advanced components where Electron already hosts dashboard
content. Add local-first operational detail, policy editing and storage-profile
setup. Local IPC stays first; Datacenter composition must not replace it.

### 15.7 tvOS and Android TV

Wiring targets include `tvos/YaverTV/` and `androidtv/.../ui/`. Show fabric
connected/degraded state, active job, selected render/test node only when
useful, approval if safe, cancel/retry, and an actionable failure. No topology,
resource charts, storage browser administration, or static role chips.

### 15.8 watchOS and Wear OS

Wiring targets include `watch/YaverWatch/` and `wear/app/src/main/`. Show one
job/status, one approval or recovery action, and concise placement. Complex
policy/storage configuration hands off to phone without hiding the actual
failure cause.

### 15.9 CarPlay/Android Auto

Use the shared RN voice/task state where applicable. Narrate current phase,
machine only when it changes or blocks, and one safe action. No topology,
machine picker, logs, storage browser, or deploy mutation without explicit
approval policy.

### 15.10 visionOS/glass/AR-VR

Use the shared RN paths for glass surfaces and explicit SwiftUI wiring under
`visionos/YaverVision/` for native visionOS. Preserve the active render in
space; show quiet placement/progress and route-to-fix. Detailed node/storage
management remains on desktop/mobile.

### 15.11 CLI and MCP

CLI and MCP are the complete declarative/explainability surfaces. They expose
all safe detail, explicit overrides, plan/apply, probe evidence, job attempts,
leases, artifacts, storage status and policies. Direct `machine`/`deviceId`
remains available for experts.

### 15.12 Cross-surface parity gate

Each user-visible state must have a parity row covering web, RN phone/tablet,
Electron/macOS, tvOS, Android TV, watchOS, Wear OS, car, spatial, CLI and MCP.
Native surfaces consume stable server codes and duplicate only presentation,
never placement logic. A producer without a consumer is not complete.

## 16. Auto-proposals

Proposals are evidence-backed, reversible policy suggestions. They do not
silently move secrets, install SDKs, wake many devices, rewrite source, change
roles, or submit releases.

Each proposal contains:

- evidence window;
- observed constraint;
- proposed policy/config diff;
- expected benefit;
- cost/power/network impact;
- safety and rollback;
- Apply and Dismiss.

Examples:

- move Android CI to a Linux node while an Apple signer is constrained;
- add an SSD node as Gradle/cache source after repeated cache misses;
- keep the current renderer sticky because it already verified revision R;
- block heavy builds on an 8 GB Mac while a simulator is active;
- pre-warm an Xcode runtime before the nightly matrix;
- limit an inference node to one model job while Apple build headroom is low.

Proposal generation uses bounded local aggregates. Only a compact proposal
summary roams when it must appear on other surfaces.

## 17. Compatibility and rollout

Datacenter is additive until each adapter has parity evidence.

1. Add versioned server schemas and read-only discovery.
2. Keep current execution untouched and run the new planner in shadow mode.
3. Compare proposed placement/rejections with current behavior.
4. Enable automatic dispatch per account/project, then per workload kind.
5. Keep an explicit-device override and global dispatch kill switch.
6. Negotiate protocol versions. Legacy agents remain usable through adapters
   but are never assumed to enforce leases/fences.
7. Make every job transition idempotent and attempt-scoped.
8. Roll back by disabling Datacenter dispatch; running workers and existing
   direct routes continue.
9. Keep schema changes additive until the rollback window closes.
10. Verify headless operations first, then closed-loop pixels on real surfaces.

## 18. Delivery backlog

Status values: `[ ]` planned, `[~]` active, `[x]` complete. Update this list in
a new commit as code lands; never treat checked boxes as more authoritative
than code and tests.

### D0 — Contracts and safety

- [ ] **DC-001** Define versioned Datacenter status, capability, probe,
  resource, lease, job/attempt, source and artifact Go types.
- [ ] **DC-002** Define stable Datacenter reason codes and route-to-fix shape.
- [ ] **DC-003** Add protocol/capability negotiation for legacy agents.
- [ ] **DC-004** Add privacy fixtures proving no path/token/prompt/output leaks
  into Convex-bound Datacenter payloads.
- [ ] **DC-005** Add feature flags: read-only UI, shadow planner, dispatch per
  workload kind, and global kill switch.
- [ ] **DC-006** Add idempotency-key storage and duplicate-submission tests.
- [ ] **DC-007** Remove bearer tokens from Fleet terminal URLs before Fleet is
  accepted as a Datacenter substrate.

### D1 — Capability discovery

- [~] **DC-100** Reuse and version `/capabilities/snapshot` as the local
  operational capability source.
- [ ] **DC-101** Add `GET /datacenter/status` with local node identity,
  compatibility, readiness classes and storage summaries.
- [ ] **DC-102** Add ops/MCP `datacenter_status` and `datacenter_probe`.
- [ ] **DC-103** Add bounded parallel remote capability fan-out with per-node
  deadlines and partial-result semantics.
- [ ] **DC-104** Separate claim, probe, availability and admission states.
- [ ] **DC-105** Add exact runner executable/auth/model probe and seat supply.
- [ ] **DC-106** Add exact Apple SDK/runtime/simulator/device/signer probes.
- [ ] **DC-107** Add exact Android JDK/Gradle/SDK/NDK/emulator/device/sign probes.
- [ ] **DC-108** Add browser/profile/device-context/capture probes.
- [ ] **DC-109** Add Hermes/build/push/install/launch probes.
- [ ] **DC-110** Add source revision/patch/fetch/push capability probes.
- [ ] **DC-111** Add resource availability digest: CPU, RAM, UMA/VRAM, scratch,
  pressure, slots and draining.
- [ ] **DC-112** Hash/cache digests locally and sync only changed summaries.
- [ ] **DC-113** Add failure-route consumers on every applicable surface.

### D2 — Shared file server and storage plane

- [~] **DC-200** Add versioned, bounded readiness for configured local, SMB,
  WebDAV/Storage Box and S3 profiles.
- [ ] **DC-201** Add explicit deep list/read/write/read-back/delete probe under
  a safe `.yaver-probe/` key.
- [ ] **DC-202** Add safe bounded local file write and mkdir routes.
- [ ] **DC-203** Add SMB and WebDAV bounded write/mkdir support.
- [ ] **DC-204** Adapt existing S3 upload/head/delete to configured profiles;
  never accept credentials in URLs.
- [ ] **DC-205** Add `files/cache/artifacts/sources` logical namespaces and
  per-namespace policy.
- [ ] **DC-206** Add content-addressed artifact/source put, head, range-get and
  checksum verification.
- [ ] **DC-207** Add resumable/multipart large-object transfer.
- [ ] **DC-208** Add quotas/reservations and storage-writer leases.
- [ ] **DC-209** Add local capacity/latency/throughput health and remote quota
  state where available.
- [ ] **DC-210** Add snapshot and replica records plus verified restore probe.
- [ ] **DC-211** Add scheduler data-locality hints and I/O pressure admission.
- [ ] **DC-212** Add web/mobile storage readiness and route-to-fix UI.
- [ ] **DC-213** Add exact-key retention/delete workflow with confirmation.

### D3 — Fabric connection and coordinator

- [ ] **DC-300** Introduce client `FabricConnection` over existing per-device
  clients without modifying native transport behavior.
- [ ] **DC-301** Add same-owner capability/presence bus envelopes.
- [ ] **DC-302** Implement eligibility and deterministic sticky coordinator
  ranking.
- [ ] **DC-303** Add active/idle P2P keepalive and failover tests.
- [ ] **DC-304** Add coordinator term observation and retained state.
- [ ] **DC-305** Add Convex CAS lease for active account-global resources.
- [ ] **DC-306** Add node-local resource lease manager with monotonic fencing.
- [ ] **DC-307** Reject stale terms at workers and test partition healing.
- [ ] **DC-308** Add schedule occurrence ID and fenced ownership.
- [ ] **DC-309** Add gateway retry/adoption and worker-direct stream attach.

### D4 — Workloads, planner and admission

- [ ] **DC-400** Define phase DAG validation and deterministic templates.
- [ ] **DC-401** Make hard constraint filtering fail closed; remove fallback to
  all machines after an empty explicit filter.
- [ ] **DC-402** Implement rank/explain with stable rejection codes.
- [ ] **DC-403** Add workload-specific leading-candidate probes.
- [ ] **DC-404** Implement atomic resource-vector admission.
- [ ] **DC-405** Add job and attempt ledger with bounded persistence.
- [ ] **DC-406** Add restart-safe retry classification.
- [ ] **DC-407** Add cancel, drain and graceful worker shutdown semantics.
- [ ] **DC-408** Run shadow placement and compare against current routing.
- [ ] **DC-409** Add historical duration/reliability aggregates and proposals.

### D5 — Source slicing and artifacts

- [ ] **DC-500** Add clean commit fetch/verify handoff.
- [ ] **DC-501** Add dirty patch manifest, bounded transfer and hash verify.
- [ ] **DC-502** Add content-addressed large/generated source artifacts.
- [ ] **DC-503** Add source-area ownership leases for parallel coding.
- [ ] **DC-504** Add fenced landing/merge/rebase workflow.
- [ ] **DC-505** Add renderer loaded-revision acknowledgement.
- [ ] **DC-506** Bind outputs/evidence to attempt and source revision.
- [ ] **DC-507** Add resumable transfer across gateway changes.

### D6 — Yaver-native workload adapters

- [ ] **DC-600** Tasks/coding agent adapter.
- [ ] **DC-601** Vibing/Dogfood code-to-render DAG.
- [ ] **DC-602** Browser automation/profile/capture adapter.
- [ ] **DC-603** Hermes bundle/push/install/launch adapter.
- [ ] **DC-604** WebRTC render/capture adapter.
- [ ] **DC-605** Simulator/emulator/physical-device reservation adapter.
- [ ] **DC-606** Apple build/test/archive/export adapter.
- [ ] **DC-607** Android mobile/Auto/Wear/TV/XR adapter.
- [ ] **DC-608** Web/backend/npm/CLI/desktop build matrix adapter.
- [ ] **DC-609** Cross-surface evidence return into the originating task.

### D7 — CI

- [ ] **DC-700** Convert Yaver-native pipeline jobs into phase workloads.
- [ ] **DC-701** Add distributed dependency-layer and matrix execution.
- [ ] **DC-702** Integrate native remote caches and immutable artifacts.
- [ ] **DC-703** Wrap GitHub ephemeral runner admission in node leases.
- [ ] **DC-704** Wrap GitLab runner/tag admission in node leases.
- [ ] **DC-705** Add protected-branch/tag and repository policy mapping.
- [ ] **DC-706** Externalize ephemeral runner logs before cleanup.
- [ ] **DC-707** Reconcile upstream cancellation, timeout and retry state.

### D8 — Deploy and publish

- [ ] **DC-800** Map canonical deploy targets to exact capability requirements.
- [ ] **DC-801** Add fenced version/build-number allocation.
- [ ] **DC-802** Add node and project+target global release leases.
- [ ] **DC-803** Add resumable hashed artifact state.
- [ ] **DC-804** Add pre-upload operational verification.
- [ ] **DC-805** Add release approval at the mutation boundary.
- [ ] **DC-806** Add remote store state reconciliation before retry.
- [ ] **DC-807** Adapt TestFlight, Play, npm, backend and Cloudflare paths one at
  a time behind workload flags.
- [ ] **DC-808** Add no-duplicate-submit and stale-fence negative tests.

### D9 — Inference

- [ ] **DC-900** Define engine/model/quantization capability and probe schema.
- [ ] **DC-901** Measure UMA/VRAM/model residency and allocatable memory.
- [ ] **DC-902** Add context/KV, batch, concurrency and queue resources.
- [ ] **DC-903** Record measured TTFT/tokens-per-second classes locally.
- [ ] **DC-904** Add model warm-locality placement and pre-warm proposals.
- [ ] **DC-905** Add multipurpose headroom policy for Apple build/render work.

### D10 — UI and cross-surface wiring

- [ ] **DC-1000** Define one shared Datacenter presentation schema/enums.
- [ ] **DC-1001** Web advanced entry and overview.
- [ ] **DC-1002** Web jobs, nodes/pools, storage, policies and proposals.
- [ ] **DC-1003** RN phone/tablet advanced entry and overview.
- [ ] **DC-1004** RN Tasks/Vibing/Dogfood placement and recovery actions.
- [ ] **DC-1005** Electron/macOS advanced management wiring.
- [ ] **DC-1006** tvOS concise status/action wiring.
- [ ] **DC-1007** Android TV concise status/action wiring.
- [ ] **DC-1008** watchOS concise status/action wiring.
- [ ] **DC-1009** Wear OS concise status/action wiring.
- [ ] **DC-1010** CarPlay/Android Auto voice-safe wiring.
- [ ] **DC-1011** visionOS/glass/AR-VR quiet render/status wiring.
- [ ] **DC-1012** CLI complete status/probe/plan/job/storage/policy commands.
- [ ] **DC-1013** MCP/ops complete declarative surface.
- [ ] **DC-1014** Cross-surface parity table and negative consumer tests.
- [ ] **DC-1015** Remove static role-chip duplication after dynamic view reaches
  parity; retain preferences under Advanced.

### D11 — Verification and dogfood

- [ ] **DC-1100** Unit tests for capability state, scoring, leases and fencing.
- [ ] **DC-1101** Two-agent localhost gateway/coordinator failover integration.
- [ ] **DC-1102** Three-agent partition and stale-term rejection integration.
- [ ] **DC-1103** Local SSD and S3-compatible storage contract suite.
- [ ] **DC-1104** Source-transfer interruption/resume and hash mismatch tests.
- [ ] **DC-1105** Schedule and deploy duplicate prevention tests.
- [ ] **DC-1106** Headless Yaver code-on-A/render-on-B proof.
- [ ] **DC-1107** Browser and mobile closed-loop pixel evidence.
- [ ] **DC-1108** Yaver, SFMG and Talos workload dogfood without storing private
  project data in test artifacts or docs.
- [ ] **DC-1109** Legacy-agent/direct-device rollback test.
- [ ] **DC-1110** Convex write-volume budget and privacy regression test.

## 19. Milestones

### M1 — Honest inventory

From any owned agent, `datacenter_status` returns partial, versioned capability
and storage readiness for all reachable nodes. One failed node cannot hide
healthy nodes. No automatic placement yet.

### M2 — Safe distributed build

A coding/test/build workload transfers exact source, acquires resources, runs on
another node, returns hashed artifacts, survives coordinator loss, and never
widens an allow-list.

### M3 — Yaver closed loop

Code on node A, verify/render on node B, launch browser/Hermes/WebRTC target,
collect pixel evidence, and return feedback to the originating task.

### M4 — Shared storage

Local SSD and S3-compatible profiles pass operational readiness, serve
namespaced caches/artifacts/source snapshots, enforce quotas/leases, and expose
recovery without leaking credentials.

### M5 — CI and deploy

GitHub/GitLab jobs use fleet admission and ephemeral isolation. Build/test may
retry safely. Deploy/publish is fenced, approved, reconciled and never
duplicated.

### M6 — Multipurpose inference

A high-memory node advertises real serving capacity, schedules model work, and
accepts other workloads only when memory/thermal policy permits.

## 20. First dogfood acceptance scenario

1. Start the request from any connected Yaver surface.
2. The gateway accepts one idempotent workload without a machine picker.
3. A cheap node with an operational coding runner receives the coding phase.
4. It emits a content-hashed source checkpoint.
5. A Mac with the required runtime acquires the render/device lease.
6. The Mac verifies the exact revision before building or refreshing.
7. Browser/Hermes/WebRTC returns logs and pixel evidence.
8. Kill the soft coordinator while the worker is running.
9. Another gateway reattaches without duplicating the task or render.
10. The UI showed only current progress, one placement explanation, and an
    actionable failure if something was blocked.

That is the minimum proof of Yaver Datacenter. A topology screen without this
closed loop is not the feature.
