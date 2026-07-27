# Mac mini runner/render split recovery audit — 2026-07-27

## Goal

Make the Yaver account use:

- AI runner: `runner-box` (`<runner-device-id>`)
- Renderer: `render-mini.local` (`<render-device-id>`)

and make the failure repairable through Yaver surfaces, not by a one-off machine tweak.

## Current verdict

The split is saved in Convex, and Ubuntu is usable as the runner. The Mac mini is not usable as renderer because its Yaver agent is not connected to the relay and is not listening on `:18080`.

This is not primarily CORS and not a free-relay dual-device limit.

## Live evidence

Convex `/settings` contains the account-wide row:

```json
{
  "runnerDeviceId": "<runner-device-id>",
  "renderDeviceId": "<render-device-id>",
  "workspace": "runner-clone",
  "autoPush": "always"
}
```

Device rows:

- Mac mini: `isOnline:false`, local IPs include `<lan-ip>`, `<render-tailscale-ip>`.
- Ubuntu: `isOnline:true`, local IP `<runner-tailscale-ip>`.

Relay probes with the account relay password:

```text
Ubuntu /d/<runner-device-id>/info -> HTTP 200
Mac    /d/<render-device-id>/info  -> HTTP 502 {"error":"device not connected to relay","ok":false}
```

Tailscale/ICMP:

```text
ping <render-tailscale-ip> -> replies, high latency through Tailscale/DERP
```

Ping only proves ICMP. It does not prove SSH session capability, Yaver agent health, or relay registration.

Direct agent reachability from MacBook:

```text
http://<render-tailscale-ip>:18080 -> connection refused
http://127.0.0.1:18181/info through SSH -L -> connection reset by peer
```

SSH from MacBook:

```text
ssh -o BatchMode=yes <user>@<render-tailscale-ip> true
-> exec request failed on channel 0

ssh -tt <user>@<render-tailscale-ip>
-> shell request failed on channel 0

sftp <user>@<render-tailscale-ip>
-> subsystem request failed on channel 0
```

The Mac accepts this MacBook's SSH key far enough to open a connection, then refuses session requests. That points to sshd/account/forced-command policy, not CORS.

SSH from Ubuntu watchdog:

Initial peer recovery failed with host-key verification. I added the Mac host key to Ubuntu's `known_hosts` via Yaver ops. After that:

```text
Ubuntu -> Mac peer recovery:
Permission denied, please try again.
Received disconnect ... Too many authentication failures
```

With explicit Ubuntu identity:

```text
ssh -o BatchMode=yes -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 <user>@<render-tailscale-ip> true
-> Permission denied (publickey,password,keyboard-interactive)
```

Ubuntu's public key fingerprint is not this MacBook's accepted key. Do not copy this MacBook's private key to Ubuntu. The product requirement is Yaver-managed backup key provisioning while the target agent is healthy.

## Product changes in this branch

Backend:

- `machine_roles_doctor` ops/MCP verb validates the saved runner/render split as an operation.
- `machine_repair` ops/MCP verb attempts deterministic repair through the existing peer watchdog SSH path.
- `machine_roles` ops/MCP verb reads/sets/clears the primary AI runner and primary renderer from Codex/Claude Code/chat/task flows.
- SSH resolution now probes TCP/22 before choosing stale LAN/Tailscale IPs.
- Watchdog SSH now uses:
  - `StrictHostKeyChecking=accept-new`
  - `IdentitiesOnly=yes`

Web:

- RuntimeLab calls `machine_roles_doctor` before Load Targets and Web Preview.
- RuntimeLab exposes “Recover renderer”, which calls `machine_repair`.
- `/d/<device>/...` same-origin proxy handles `OPTIONS` preflight locally.

E2E:

- `e2e/selenium/machine-roles-split.selenium.py`
  - relaxed mode passes and verifies dashboard displays both role devices.
  - strict mode fails correctly on Mac relay `502`.

## Tests run

```text
go test . -run 'TestMCPToolsAndCalls|TestMachineRolesOpsRegistered|TestMachineRepairOpsRegistered|TestMachineRoleUnreachableCarriesRepairRoute|TestSSHArgsWithSurvivabilityAcceptsNewHostKeys|TestHeartbeatFromDeviceUsesConvexRegistryFields|TestDoctorIPLayerClassification|TestTargetFromDeviceClassifiesRemoteBoxKinds|TestParsePingLatencyMs|TestFirstDialable|TestTCPPortDialable|TestIsCGNATTailscaleIP|TestSummarizeUnreachable|TestLivenessProbePutsTheWorkingLegFirst'

npx tsc --noEmit --pretty false
npx tsx lib/runtimeTargetProbeFailure.test.ts
npx tsx lib/preview-device-proxy.test.ts

E2E_EXPECT_RENDER_READY=0 E2E_HEADLESS=1 python3 e2e/selenium/machine-roles-split.selenium.py
E2E_EXPECT_RENDER_READY=1 E2E_HEADLESS=1 python3 e2e/selenium/machine-roles-split.selenium.py
```

Expected strict Selenium failure until Mac mini agent is back:

```text
render device is not reachable through relay: HTTP 502
```

## What Claude Code should try next

1. Use the new Yaver tool path, not ad hoc settings writes:

```json
{
  "action": "set",
  "runner": "<runner-alias>",
  "render": "<render-alias>",
  "workspace": "runner-clone",
  "autoPush": "always"
}
```

via MCP `machine_roles` or ops `machine_roles`.

2. Run `machine_roles_doctor`.

Expected until Mac recovers:

```text
ready=false, code=render_unreachable
```

3. Run `machine_repair` for the Mac:

```json
{
  "action": "restart_agent",
  "deviceId": "<render-device-id>"
}
```

If it returns `ssh_auth_failed`, the watchdog reached the Mac but the Mac does not trust the watchdog's key. Without physical access or a running Yaver agent on the Mac, do not try to bypass by copying private keys.

4. Investigate a product fix for provisioning backup SSH access while healthy:

- Ensure every owned device installs each other selected watchdog's public key as a `# yaver-managed` forced-command key.
- Prefer the Yaver SSH forced-command/control channel over arbitrary shell.
- Add a doctor field that distinguishes:
  - `ssh_host_key`
  - `ssh_auth_failed`
  - `ssh_session_refused`
  - `agent_not_listening`
  - `relay_not_connected`

5. For this particular Mac mini, the only remaining remote paths are:

- A previously installed Yaver SSH forced-command/control channel.
- A reachable remote management channel already trusted by the Mac.
- A user-provided password/authorized management route that can enable launchd/Yaver.

No physical access is currently available.

## Safety boundaries

- Do not hot-swap an unsigned `yaver` binary onto macOS.
- Do not copy private SSH keys from this MacBook to Ubuntu or the Mac mini.
- Do not weaken relay CORS or use `Access-Control-Allow-Origin: *` on authed agent routes.
- Do not put relay passwords or bearer tokens in URLs except for already-existing iframe/SSE compatibility paths.
- Do not mutate non-Yaver provider resources.

## Key interpretation

Could this be macOS keychain timeout? Possibly for later signing/runner/auth operations after the agent is started. It does not explain the SSH session failure. `exec request failed on channel 0` and `shell request failed on channel 0` happen at sshd session setup before Yaver or the login keychain can run.

The immediate live blocker is: Mac mini has no Yaver relay tunnel and no usable remote execution channel from the available watchdog.
