# Remote resource slicing — all-surface audit (2026-07-27)

Deep audit of every UI surface for the runner/render machine split
(`docs/architecture/RUNNER_RENDER_SPLIT.md`): AI tasks on the user's default
**runner** machine, builds/previews on the default **render** machine, both
Convex-synced via `userSettings.machineRolesByProject` (favorite row = no
`projectName`). The user's full default profile is FIVE Convex-backed choices:

| Default | Convex row | Editable from |
|---|---|---|
| Project (first to render) | `defaultRuntimeProjectByDevice` | web Vibing + mobile settings |
| AI runner machine | `machineRolesByProject.runnerDeviceId` | web Settings/Vibing header (+ mobile context API) |
| Runner CLI + model | `primaryRunnerByDevice` / `primaryModelByDevice` (keyed by the RUNNER box) | web + mobile + tv pickers |
| Render machine | `machineRolesByProject.renderDeviceId` | web Settings/Vibing header |
| Render methodology (hermes/webrtc/browser) | `defaultRuntimeTargetByDevice` (per machine+project) | web Vibing star (mobile: not yet read) |

## State after this audit's fixes (landed same day)

- **Web** — full routing (`agent-client` taskBaseUrl/devBaseUrl), Vibing badge
  + Route editor, sidebar dual-role pill with per-box live dots, runner-box
  keyed runner list/auth-gate/fallbacks, split tasks carry
  gitRemote/gitBranch/autoPush.
- **Go agent** — `task_ensure_clone.go`: ensure-clone before spawn (streamed,
  guest-refused, flag-injection-safe remotes) + autoPush converge
  (always/ask/never; `push_pending` task event) on completed/review.
  Tests: `task_ensure_clone_test.go`.
- **Mobile (RN: phone + tablet + CarPlay + glass)** — `machineRolesByProject`
  parsed in DeviceContext, `connectionManager.runnerClient()/renderClient()`
  accessors, task send/list/stream/fork/continue routed to the runner box
  (wizard pick still wins; named refusal when unreachable), runner/model
  defaults keyed by the runner box (`remoteCodingSelection.dispatchDeviceId`),
  Hermes reload hop → render box, both role boxes pool-warmed, car surface
  defaults to the runner box, compose modal names both boxes.
- **tvOS** — additive `machineRolesByProject` decode, published roles +
  device-name cache, `runnerBox()/renderBox()` (relay-only, host cleared —
  a stale LAN host must never win), SessionView/TasksView/runtime turns →
  runner box, WebPreview/Droid streams + reload → render box, "Roles" badge
  on both dashboards, named refusals.

## Remaining gaps (ordered)

1. **Mobile render lane full repoint** — dev-server/preview call sites in
   `apps.tsx`, `DevPreview.tsx`, `project.tsx`, `hotreload.tsx`, `builds.tsx`,
   `_layout.tsx`, `FeedbackOverlay.tsx`, `remote-runtime.tsx` still ride the
   focused client; `renderClient()` exists — repoint them (audit gap 5).
   `apps.tsx:500` `selectedTarget` is the deploy CONSUMER — leave it.
2. **Mobile cloud/deferred lane** — dispatch-intent `targetDeviceId` should
   seed from `runnerDeviceId` (`taskPlacement.ts:474`,
   `pendingCloudDispatch.ts:162`, `tasks.tsx:2252`).
3. **Mobile settings card** — no MachineRolesCard equivalent; context API
   (`setMachineRolesFavorite`) is ready; mount beside runtime-project defaults
   in `settings.tsx`. `defaultRuntimeTargetByDevice` is absent from mobile.
4. **Glass workspace raw fetches** — `glass-workspace.tsx:509,536,671` use raw
   `quicClient.baseUrl`; `glass-terminal.tsx` keys on `primaryDeviceId`.
5. **watchOS** — no `/settings` fetch, no relay leg in `BoxTarget`
   (`watch/YaverWatch/Backend.swift:353`), `SessionClient.swift:94` hardcodes
   `http://host:port`. Needs: settings+devices fetch, relay fields, a port of
   tvOS `requestEndpoints`, then route `resolveTransport()`.
6. **Wear OS** — same, plus two pre-existing defects: `StandaloneStore.kt:127`
   uses the managed machineId (not the registry deviceId the relay keys on),
   and `relayBaseUrl/relayPassword` are never written, so the relay branch
   never fires.
7. **tvOS capture** — `AgentClient.swift:537` `captureFrameURL()` is
   hardcoded LAN and ignores any render route.
8. **Web chat tab (non-Vibing)** — `page.tsx` handleSend doesn't carry
   gitRemote (no project row at hand); runner box fails NAMED when the
   project is missing (ensure-clone can't fire without a remote).
9. **RuntimeDashboardView status fan-out** — info/status/voice cards still
   read the selected box (fine — they describe the box you're looking at).

## Trust boundaries (unchanged by all of the above)

Relay `/d/<deviceId>/` authorizes per request against the caller's per-user
credential with backend ownership scope (`relay/server.go` handleProxy →
`validateRelayAccessE`) — free relay and Relay Pro identically. Guests can
neither set machine roles (owner-only mutation gate) nor trigger ensure-clone
or autoPush (stripped in the createTask handler AND re-checked in the task
manager). Ensure-clone accepts only real git transports — no flag injection,
no local paths.
