# Windows BYO, Relay Pro, Azure Windows, and Office — deep audit

**Date:** 2026-08-16  
**Source slice:** `8cb585c85`  
**Mode:** Architecture and product audit only. No implementation, deployment, provisioning, account mutation, or credential use was performed.  
**Primary case:** A GanttSnap beta tester develops a PowerPoint add-in with Claude Code, OpenCode, Codex, or similar runners; uses a phone, tablet, or web UI to drive and view the work; and needs a real Windows PowerPoint session for final validation.

## 1. Executive verdict

The requested product is feasible, but it is not one feature and the current checkout is not ready to promise it as a seamless Relay Pro experience.

The correct product split is:

1. **Windows BYO interactive seat** — the friend's existing Windows PC runs PowerPoint, the Yaver Windows agent, screen capture, and input in the friend's normal logged-in session.
2. **Optional WSL2 coding seat** — a second Yaver agent inside WSL2 runs Linux-native repositories, Claude/OpenCode/Codex, build tools, and dev servers. It is a separate execution environment with an explicit relationship to the Windows seat.
3. **Relay Pro connectivity plane** — signaling and authenticated agent traffic use Yaver's relay; WebRTC uses direct ICE when possible and TURN when necessary; authenticated JPEG remains a truthful fallback.
4. **Azure interactive desktop product** — initially attach an already-provisioned Azure Virtual Desktop personal desktop, Windows 365 Cloud PC, or eligible Windows VM. Do not pretend the existing Azure Linux provider can create it.

The highest-priority blockers are:

| Severity | Finding | Consequence |
|---|---|---|
| P0 | Managed Relay Pro provisioning does not install or prove TURN | A paid relay can return no relay ICE candidate, so cellular/CG-NAT viewing can fail |
| P0 | Mobile chooses JPEG polling whenever its API connection uses a relay URL | Relay Pro actively bypasses the H.264 WebRTC path on the main phone runtime screen |
| P0 | `web/app/vibing` calls a nonexistent `/rtc/offer` route and invents static TURN credentials | The page labels a path “WebRTC/TURN low-latency” that current agent routing cannot satisfy |
| P0 | Windows is not compiling at the audited source slice | The product cannot claim a releasable Windows lane from this checkout |
| P0 | The Azure provider creates Linux VMs only and is not production-placement eligible | It cannot provision a Windows/Office desktop |
| P0 | PowerPoint requires an interactive user desktop and profile | Running Office under a service, Session 0, or an unattended task is unsupported and can hang |
| P1 | Native Windows and WSL are not one transparent runner environment | Tools, paths, credentials, ports, and process lifecycle can silently land on the wrong side |
| P1 | Windows onboarding checks inventory, not the entire desktop-stream operation | `ffmpeg` on PATH does not prove `gdigrab` plus H.264 plus first frame works |
| P1 | Windows installer has no release-integrity or architecture proof | The bootstrap downloads `amd64` and executes it without a published hash or Authenticode verification |
| P1 | Desktop capture is primary-display-only | PowerPoint presenter mode and multi-monitor workflows are incomplete |

The best beta sequence is therefore:

> Attach the friend's existing Windows PC first, keep PowerPoint in his interactive user session, add a WSL2 Yaver seat only if his coding toolchain genuinely needs Linux, and require a real TURN-assisted H.264 first-frame and input-echo test before describing Relay Pro as low-latency remote Windows. If a rented desktop is later needed, attach an AVD personal desktop or Windows 365 Cloud PC before building Yaver-managed Azure Windows provisioning.

## 2. What “Relay Pro for Windows” must mean

“Relay Pro” should describe a measured service level, not a machine location or a protocol name.

For this use case, the minimum honest contract is:

- The Windows agent remains outbound-only; the user does not open an inbound RDP or agent port to the internet.
- The viewer and agent authenticate as the same Yaver owner or an explicitly granted collaborator.
- Signaling can traverse the authenticated Yaver HTTP/QUIC relay.
- Media attempts WebRTC with short-lived ICE credentials.
- Direct host/server-reflexive ICE is used when it works.
- A TURN relay candidate is available for symmetric NAT, corporate firewalls, and mobile CG-NAT.
- TURN-over-UDP, TURN-over-TCP, and TURN-over-TLS are supported and actually probed.
- If WebRTC cannot connect, the UI names the failed ICE state and may use authenticated JPEG polling without calling it WebRTC.
- Control is separate from viewing, explicitly authorized, single-writer, visible to the person at the Windows PC, revocable, and audited.
- A locked, logged-off, consent-blocked, or non-interactive session is a named state, never an endless spinner.

Relay Pro does **not** need to force every media byte through the Yaver relay. WebRTC should remain peer-to-peer when direct ICE succeeds. TURN is the media relay of last resort. The ordinary Yaver HTTP/QUIC relay is the signaling and fallback transport.

The product copy also needs precision. The current paid product is pooled by default. A good description is:

> A private authenticated endpoint and tenant-isolated logical relay on a managed shared pass-through pool, with paid limits and TURN-assisted reachability when required.

It should not be called a dedicated/private server unless the user receives a dedicated relay host. Free versus Pro is never the tenant-security boundary; keys, owner checks, grants, and agent authorization are.

## 3. Current Windows runtime: strong foundations and missing proof

### 3.1 What exists

The `desktop-screen` runtime is the right foundation:

- `desktop/agent/remote_runtime_desktop.go:3-33` deliberately moves real desktop work away from the older MJPEG route and into RTP H.264/WebRTC.
- It combines the remote-desktop consent policy with the runtime's single-writer control lease.
- Windows capture uses `ffmpeg -f gdigrab -i desktop` (`remote_runtime_desktop.go:430-476`).
- The encoder is `libx264` with an ultrafast, zero-latency profile and adaptive FPS, width, and bitrate (`remote_runtime_desktop.go:281-332`).
- Mouse and keyboard input use the existing Windows `SendInput` implementation through `ghost`.
- Application launch exists and uses the Windows shell launcher (`remote_runtime_desktop.go:374-427`).
- The older `/rd` surface still provides an authenticated MJPEG stream, a frame endpoint, input, policy, notifications, and audit. Frames do not pass through Convex (`desktop/agent/remotedesktop_http.go:1-16`).
- Windows autostart uses an `ONLOGON`, limited-privilege scheduled task (`desktop/agent/process_windows.go`). That is directionally correct because capture and PowerPoint belong in the interactive user session, not Session 0.

This is a materially better design than exposing RDP directly or putting Windows credentials in Yaver.

### 3.2 What is not yet proven

The capability probe currently verifies that Ghost can initialize, `ffmpeg` is present, capture arguments can be formed, and viewing is allowed (`remote_runtime_desktop.go:337-369`). It does not prove:

- `gdigrab` can capture the actual interactive desktop;
- the frame is not black, stale, minimized, or from the wrong session;
- `libx264` exists in the installed FFmpeg build;
- a decodable H.264 keyframe reaches a real phone;
- a TURN allocation and relay candidate work from an external network;
- an input event changes the intended PowerPoint test presentation;
- disconnecting an RDP/Windows App session preserves the captureable desktop;
- locking or logging off is classified correctly;
- PowerPoint or an Office activation dialog is blocking the desktop;
- screen scaling and touch-to-desktop coordinate mapping remain accurate at non-100% DPI.

For a Windows readiness result, Yaver should attempt the operation and return structured fields such as:

```json
{
  "code": "windows.desktop_stream_ready",
  "interactiveSession": true,
  "sessionUnlocked": true,
  "captureBackend": "gdigrab",
  "encoder": "libx264",
  "firstFrame": true,
  "firstFrameMs": 842,
  "iceReachability": "relay-ok",
  "controlAllowed": true,
  "inputEcho": true,
  "displayCount": 1
}
```

A failed result must carry a route to its fix, for example `windows.interactive_session_required`, `windows.desktop_locked`, `capture.gdigrab_failed`, `capture.encoder_missing`, `webrtc.turn_allocation_failed`, or `desktop.control_disabled`.

### 3.3 Current Windows operational gaps

- The target supports only the primary display. PowerPoint presentation mode often uses a second display, so multi-monitor enumeration and selection are a real product requirement.
- The Windows installer downloads only `yaver-windows-amd64.exe`, does not detect ARM64, and does not verify a release checksum or Authenticode signature before execution (`web/public/install.ps1`).
- General tool installation is documented and implemented primarily for macOS/Linux. Windows needs signed, pinned recipes using `winget`, official installers, or verified portable archives.
- Durable child service units are explicitly unsupported on Windows (`managed_units_windows.go`).
- Detached autodev execution is explicitly unsupported and remains tied to the controlling console (`runner_detach_windows.go`).
- Some Windows inventory uses `wmic`, which has been deprecated/removed on newer Windows installations; the operational probe should use supported PowerShell/CIM APIs and test the real capability.
- FFmpeg stderr is discarded in the H.264 capture path. That avoids noisy logs, but it also hides the exact capture/encoder failure needed for a structured remedy. A bounded redacted tail should be retained.

## 4. Native Windows and WSL2 must be explicit seats

### 4.1 Why a single magical environment is unsafe

If the Yaver agent runs natively on Windows, it resolves Claude, OpenCode, Codex, Node, Git, repository paths, and credentials from the Windows process environment. A tool installed only inside WSL is not automatically available to that agent.

The current Windows-to-WSL bridge is narrow: `desktop/agent/tmux.go` can create a Windows `.cmd` shim that invokes `wsl.exe ... tmux`. There is no equivalent general runner adapter that makes every task execute inside a selected WSL distribution with stable path, environment, PTY, signal, port, and credential semantics.

If the Yaver agent runs inside WSL2, Linux runners work naturally, and the repository can live on WSL's ext4 filesystem. But that Linux process does not become the correct owner of Windows PowerPoint capture and `SendInput`. PowerPoint belongs to the native interactive seat.

### 4.2 Recommended one-PC topology

Use two logical devices on one physical Windows PC:

```text
Friend's Yaver account
  |
  +-- Windows seat: "GanttSnap Office host"
  |     - native signed Yaver agent
  |     - PowerPoint + WebView2 + Office profile
  |     - desktop-screen H.264 capture
  |     - consented input and app launch
  |     - optional native browser/dev tools
  |
  +-- WSL2 seat: "GanttSnap coding runner"
        - Linux Yaver agent with a distinct device ID
        - repository, Node/package manager, Git
        - Claude Code / OpenCode / Codex
        - dev server, tests, cloud CLIs
        - outbound registration to the same account
```

The relationship is explicit metadata, for example `physicalHostGroup`, `role=office-host`, and `role=coding-runner`. It must not weaken device authentication or merge their authorization keys.

The handoff contract should include:

- canonical repository identity and commit/worktree state;
- explicit Windows and WSL paths, never guessed string replacement;
- dev-server origin and ownership;
- a localhost/WSL networking probe from the actual PowerPoint WebView2 context;
- manifest/add-in sideload status;
- task state and render intent;
- the disposable PowerPoint test document identifier, without its content entering relay logs;
- which seat owns build, serve, Office launch, view, and control.

For source placement, keeping a performance-sensitive Node repository in the WSL ext4 filesystem is usually preferable to working under `/mnt/c`. If native Windows processes need the files, use a deliberate `\\wsl$\<distro>\...` path or a tested sync/export step. Do not claim a shared CWD.

### 4.3 WSL persistence is not Windows availability

`desktop/agent/process_wsl.go` installs shell hooks and attempts an `ONLOGON` Windows scheduled task or Startup wrapper. The code itself correctly warns that WSL cannot prevent Windows sleep.

The product must distinguish:

- Windows powered off;
- Windows asleep;
- no Windows user logged in;
- Windows logged in but locked;
- WSL distribution stopped;
- WSL agent stopped;
- Windows agent healthy but WSL agent absent;
- both seats healthy.

A single green “PC online” badge would repeat the inventory-versus-operation failure pattern.

## 5. Relay Pro and TURN audit

### 5.1 The credential design is good

The intended TURN security design is sound:

- The agent exposes owner-authenticated `/stream/webrtc/ice` and can fetch managed ICE credentials from its configured relay (`desktop/agent/turn_credentials.go`).
- The relay's `/ice` endpoint requires the per-account relay credential, validates entitlement, and returns bounded standard `RTCIceServer` data (`relay/turn_credentials_http.go:39-117`).
- The long-lived TURN secret remains on the relay host.
- Credentials are short-lived.
- A secret-keyed stable account bucket prevents one account from bypassing coturn quotas by minting unlimited independent usernames (`turn_credentials_http.go:77-92`).
- The agent accepts only HTTPS broker URLs, except explicit loopback HTTP, and validates response bounds and URL schemes (`desktop/agent/turn_credentials.go:232-314`).

The ICE doctor is also the right kind of proof. `desktop/agent/doctor_webrtc_ice.go` gathers real candidates and classifies `none`, `lan-only`, `srflx-only`, or `relay-ok`. It intentionally marks server-reflexive-only as not OK for the mobile/CG-NAT promise.

### 5.2 Managed provisioning does not deliver that design

The current managed Relay Pro cloud-init path starts only the Yaver relay container and exposes QUIC and HTTP. It does not install or configure coturn, create the TURN secret/certificate, expose `3478/udp`, `3478/tcp`, `5349/tcp`, or the allocation range, or prove an external allocation (`backend/convex/provisionRelay.ts`).

The tracked service units also run the in-process TURN listener with `--turn-port=0`. A hardened coturn example exists with UDP/TCP/TLS, a bounded allocation range, quotas, and certificates, but the main deployment script does not stage, install, configure, start, or health-check coturn (`relay/deploy/up.sh`, `turnserver.conf.example`). The Docker image contains only the relay binary and does not expose TURN ports (`relay/Dockerfile`).

Therefore the repository contains a good broker and a good target configuration, but the tracked managed deployment does not prove a functioning TURN service. An operator may have configured production out of band, but that is not product truth and must be verified live.

### 5.3 Mobile currently defeats the intended WebRTC path

`mobile/app/remote-runtime.tsx:127-145` sets `usingRelay` from `quicClient.activeRelayBaseUrl` and selects `relay-jpeg-poll`. Later, the WebRTC attempt is skipped when relay mode is active.

That selection confuses two independent facts:

- how API/signaling requests reach the agent; and
- how ICE should carry the media.

A Relay Pro customer is exactly the user most likely to need TURN-assisted WebRTC, yet the primary mobile screen sends that user to JPEG polling. Transport choice should instead be:

1. fetch authenticated ICE servers;
2. attempt WebRTC;
3. classify gathered candidates and connection state;
4. use direct media if connected;
5. use TURN media if direct ICE cannot connect;
6. start authenticated JPEG fallback after a bounded deadline while WebRTC may continue negotiating;
7. label the active transport truthfully.

### 5.4 The web vibing page is stale

`web/app/vibing/page.tsx` currently:

- posts to `${conn.base}/rtc/offer`;
- constructs TURN auth with literal `yaver-pro` username and credential values;
- labels the result “WebRTC (Relay Pro)” and “WebRTC/TURN low-latency.”

The agent registers `/stream/webrtc/offer` and `/stream/webrtc/ice`, not `/rtc/offer` (`desktop/agent/httpserver.go:599-602`). The literal credentials do not follow the short-lived broker contract. This duplicate surface must either consume the same tested client module as `RemoteRuntimeViewer` or be retired. Copying a third WebRTC implementation will create more drift.

### 5.5 Required Relay Pro deployment transaction

A managed relay should not transition to `ready` until one external verifier proves:

1. QUIC registration and authenticated HTTP proxy work.
2. `/ice` rejects missing/invalid credentials.
3. `/ice` returns short-lived, bounded credentials for the correct account.
4. TURN UDP allocation works.
5. TURN TCP allocation works.
6. TURN TLS allocation works and the certificate matches the advertised host.
7. A relay ICE candidate is gathered from outside the relay network.
8. A small bidirectional test flow passes through that allocation.
9. Per-account allocation/concurrency limits are enforced.
10. Firewall and allocation-port-range state match the generated configuration.

If one fails, the relay row should carry a structured reason and an operator repair action. “VM is running” or “`/health` returns 200” is not sufficient.

### 5.6 Bandwidth and capacity

The relay's default accounting is 500 MB/day for free devices and 20,000 MB/day for paid devices, with a load-based relaxation multiplier (`relay/bandwidth.go`). That policy may be reasonable for ordinary API and fallback preview traffic, but continuous Windows H.264 over TURN changes the capacity model:

- a 2 Mbps stream is about 0.9 GB/hour in one direction;
- a 4 Mbps stream is about 1.8 GB/hour;
- eight hours at 4 Mbps is roughly 14.4 GB before protocol overhead;
- TURN consumes relay ingress and egress and host sockets, not just HTTP proxy bytes.

Paid limits and pooled-host capacity must meter TURN allocations as well as HTTP/QUIC traffic. The UI should show current session bitrate, estimated remaining hours, and whether media is direct or consuming relay capacity. Quotas must be account-scoped, never inferred from a client-provided paid flag.

### 5.7 Relay URL credential cleanup

The relay still accepts `?__rp=<password>` as an iframe fallback in `relay/server.go`, even though it now has a preferred device-signature and scoped HttpOnly cookie path. A per-user relay password in a URL can reach browser history, access logs, screenshots, and referrers.

Windows screen and Office views should use:

- an owner bearer token at the agent boundary;
- a short-lived signed relay grant or device signature at the relay boundary;
- a device-scoped, short-lived, Secure, HttpOnly, SameSite cookie for browser subresources;
- no long-lived secret or bearer token in a URL.

The relay remains pass-through and must never become the authority that grants device access.

## 6. Windows Office and GanttSnap execution boundary

### 6.1 PowerPoint must run as the user's interactive app

Microsoft explicitly does not support unattended, non-interactive automation of Office from services, NT services, DCOM, ASP, or an equivalent non-interactive workstation context. Office assumes an interactive desktop and user profile and may display modal dialogs that hang an unattended process. See [Microsoft's server-side Office automation guidance](https://support.microsoft.com/en-us/visio/considerations-for-server-side-automation-of-office).

Therefore:

- Yaver must not run PowerPoint as `SYSTEM`, a Windows service, or Session 0.
- The friend signs into Windows and Office with his own account and MFA.
- Yaver never stores, replays, or asks an agent to type his Microsoft password.
- The agent launches PowerPoint inside the existing interactive session.
- Automation uses a disposable presentation and explicit user consent.
- A modal Office/activation/update dialog is detected as a visible blocker, not silently bypassed.
- Logging off ends the Office host. Lock/disconnect behavior must be measured on the exact machine and access method.

### 6.2 Office identity is not Azure infrastructure identity

There are at least three separate identities:

1. **Yaver identity** — owns devices, relay access, task grants, and audit records.
2. **Azure management identity** — a service principal or customer-authorized Azure connection with narrowly scoped RBAC creates/deletes infrastructure.
3. **Friend's Microsoft 365/Windows identity** — signs into the desktop and activates/uses PowerPoint.

They must never be collapsed into one stored username/password. In particular, Yaver should not ask for the friend's tenant password and use it for Azure Resource Manager calls. The current Azure provider correctly uses OAuth client credentials for management-plane access (`cloudProviders/credentials.ts`), although those credentials are operator-side today rather than a customer connection.

### 6.3 PowerPoint add-in proof

GanttSnap source is not in this repository, so its manifest and Office.js requirements were not verified. For an ordinary PowerPoint web add-in, the Windows acceptance operation is:

- PowerPoint is visibly running in the correct user profile;
- the GanttSnap manifest is installed/sideloaded through a supported path;
- the task pane loads through WebView2;
- `Office.onReady` succeeds;
- required PowerPoint API sets are checked at runtime;
- a disposable presentation is read and changed;
- the change is visible in captured pixels;
- a reload after a coding task occurs once and only after the task reaches a renderable terminal state;
- the last good PowerPoint surface remains visible during refresh.

Windows Office add-ins use Edge WebView2 on supported Windows Office versions, and WebView2 is installed with supported Office builds. See [Microsoft's Office Add-in browser-control matrix](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/browsers-used-by-office-web-add-ins). Requirement-set support varies by host and version and must be probed, not inferred from “PowerPoint installed”; see [Office versions and requirement sets](https://learn.microsoft.com/office/dev/add-ins/develop/office-versions-and-requirement-sets).

## 7. Azure integration audit

### 7.1 What the current provider actually does

`backend/convex/cloudProviders/azure.ts` is an incomplete Linux compute adapter:

- It declares `productionEligible: false` and says network bootstrap, budget telemetry, cleanup, and live probes remain (`azure.ts:80-98`).
- It selects Linux runner SKUs and has no wired retail pricing (`azure.ts:110-126`).
- VM creation uses `linuxConfiguration`, an SSH public key, and cloud-init custom data.
- Attached and restored OS disks hardcode `osType: "Linux"`.
- The default image is Canonical Ubuntu 22.04.
- It has no Windows password/certificate/bootstrap path, Entra join, Intune enrollment, AVD host pool, application group, workspace, session-host registration, FSLogix, Windows 365 provisioning policy, Microsoft 365 Apps installation, or interactive-login lifecycle.
- Normal paid placement refuses it; only an explicit operator testing override can select a non-production-eligible provider (`cloudProviders/selection.ts`).

This provider cannot create the requested Windows PC. Adding an `os=windows` conditional would still omit most of the product.

### 7.2 Recommended Azure product options

| Option | Ownership and lifecycle | Office fit | Yaver work | Recommendation |
|---|---|---|---|---|
| Existing/BYO Azure Windows VM | User/admin already owns VM and Windows entitlement | Possible if eligible, licensed, and interactive | Install and attach Windows agent; prove session | Good first attach-only path |
| Azure Virtual Desktop personal desktop | One user maps to one session host; Azure/customer manages AVD resources | Strong enterprise fit; persistent personal desktop | Separate AVD connector plus agent bootstrap | Best future managed Azure shape |
| Windows 365 Cloud PC | Microsoft manages Cloud PC lifecycle; tenant manages assignment/Intune | Strong personal desktop fit | Graph/Intune integration and agent app deployment | Best attach/provisioning alternative if tenant has licenses |
| Raw Yaver-created Windows 11 Azure VM | Yaver would manage VM/network/disk/identity/Windows eligibility | Technically possible, but entitlement and session lifecycle are easy to get wrong | Entire new Windows desktop provider | Defer until attach paths are proven |
| Shared Windows Server VM | Multiple sessions and RDS/Office licensing complexity | Poor fit for a friend's personal add-in dev box | High | Do not start here |

### 7.3 Why AVD personal is a good fit

An AVD personal host pool provides a one-to-one user-to-desktop mapping and preserves the user's files and settings on the VM OS disk. Microsoft explicitly positions personal desktops for resource-intensive workloads. See [personal desktop assignment](https://learn.microsoft.com/en-us/azure/virtual-desktop/configure-host-pool-personal-desktop-assignment-type).

Current AVD prerequisites permit supported 64-bit Windows 11 Enterprise single- or multi-session images and require user/session-host identity alignment. Eligible Microsoft 365 or Windows licenses can provide internal commercial access rights; exact tenant entitlement must be checked before provisioning. See [AVD prerequisites and supported licenses](https://learn.microsoft.com/en-us/azure/virtual-desktop/prerequisites) and [Windows license application for session hosts](https://learn.microsoft.com/en-us/azure/virtual-desktop/apply-windows-license).

For GanttSnap, prefer a **personal**, persistent desktop even if multi-session images exist. It produces a simpler Office profile, activation, repository, WebView2 cache, and debugging story.

### 7.4 Windows 365 is viable but not “just Azure VM”

Windows 365 Enterprise requires tenant, Intune, Entra, Windows, and Windows 365 licensing/administration. Microsoft-hosted networking can avoid a customer Azure subscription for an Entra-joined Cloud PC, while customer-network configurations add Azure roles and network prerequisites. See [Windows 365 requirements](https://learn.microsoft.com/en-ca/windows-365/enterprise/requirements).

Cloud PCs are assigned to licensed users and are managed through Intune/Windows 365 administration. They can be reached through Windows App or a web client, subject to client limits; mobile access should use Windows App rather than assuming the web client works everywhere. See [Cloud PC access methods](https://learn.microsoft.com/en-us/windows-365/end-user-access-cloud-pc).

Yaver's initial Windows 365 integration should therefore be “install/attach Yaver to this assigned Cloud PC,” not “Yaver treats it as an ARM VM.”

### 7.5 Microsoft 365 Apps activation

For a dedicated personal Windows PC or personal desktop used only by the friend, use the license and activation model his tenant permits. Do not enable shared-computer activation merely because the machine is remote.

Shared Computer Activation is relevant when multiple users log into one computer or for suitable shared/non-persistent VDI. It requires an eligible plan, and each user needs a Microsoft 365 Apps license and their own sign-in. See [Shared Computer Activation](https://learn.microsoft.com/en-us/microsoft-365-apps/licensing-activation/overview-shared-computer-activation).

The product should expose the result, not guess the entitlement:

- Windows activation state;
- Office installed version/channel/architecture;
- PowerPoint executable and launch result;
- Office signed-in/activation state without exposing account tokens;
- WebView2 runtime operation;
- required Office.js API-set result;
- whether Shared Computer Activation is enabled and whether that matches the selected desktop type.

### 7.6 Separate Azure Windows adapter

Create a future provider boundary such as `azure-windows-desktop`, separate from `azure-linux-workspace`.

Its resource graph would include:

```text
customer Azure connection / delegated RBAC
  -> resource group
  -> network + egress policy
  -> AVD host pool (personal)
  -> application group + AVD workspace
  -> Windows session host
  -> Entra join / assignment
  -> Office + WebView2 + signed Yaver agent
  -> interactive user session readiness
```

Lifecycle states must be desktop-specific:

- `infrastructure_ready`
- `device_joined`
- `user_assigned`
- `agent_installed`
- `awaiting_first_login`
- `interactive_session_ready`
- `office_ready`
- `desktop_stream_ready`
- `locked`
- `logged_off`
- `deallocated`
- `repair_required`

“VM running” must never map directly to “PowerPoint ready.”

## 8. Target end-to-end architecture

```text
Phone / tablet / web
  |
  | Yaver account token + device/grant keys
  v
Yaver control plane
  |-- device ownership, grants, task state, entitlement
  |-- no screen frames, repo contents, Office password, or runner token
  |
  +--> Relay Pro endpoint (pooled by default)
         |-- authenticated HTTP/QUIC signaling and fallback
         |-- short-lived TURN credential broker
         |-- coturn UDP/TCP/TLS media relay when direct ICE fails
         |-- account-scoped quota and abuse controls
         |
         +--> Windows seat (outbound registration)
         |      |-- interactive desktop + PowerPoint
         |      |-- H.264 desktop-screen + input lease
         |      |-- Office-host closed loop
         |      |
         |      +-- local authenticated handoff --> WSL2 seat
         |              |-- repo and runners
         |              |-- dev server and cloud CLIs
         |
         +--> optional Linux Cloud Workspace
                |-- alternate always-on coding runner
                |-- no native desktop PowerPoint
```

The data plane should prefer:

```text
direct WebRTC > TURN-assisted WebRTC > authenticated JPEG fallback
```

The control plane remains:

```text
LAN HTTP/SSE/WebSocket when available > authenticated relay HTTP/QUIC
```

Do not select the media transport merely because the control plane uses the relay.

## 9. Product plan

### Phase 0 — make claims honest

- Rename Relay Pro copy so pooled and dedicated offerings are distinct.
- Stop labeling JPEG polling as WebRTC.
- Remove or repair the stale `/rtc/offer` web path and static TURN credentials.
- Expose ICE classification and active transport consistently on web and mobile.
- Mark Azure as Linux-only and operator-test-only in every user-visible diagnostic.
- Publish that Office needs an interactive signed-in Windows user session.

### Phase 1 — Windows BYO beta spine

- Produce a signed, checksummed Windows installer with amd64/arm64 selection.
- Add a Windows onboarding doctor that proves the exact runtime operations.
- Register the native Windows seat under the friend's own Yaver account.
- Detect WSL distributions and offer, but do not force, a second WSL Yaver seat.
- Pair the seats through explicit metadata and a local authenticated bridge.
- Install/verify the selected runner in the seat where tasks will execute.
- Prove native PowerPoint launch, GanttSnap load, Office API action, captured pixels, and input echo.
- Prove disconnect, lock, logoff, sleep, reboot, and WSL-stop state handling.

### Phase 2 — Relay Pro media completion

- Integrate coturn into managed provisioning or choose the in-process listener only with an explicit reduced-capability profile.
- Configure firewall, allocation range, certificate, secret, and quotas transactionally.
- Add an external TURN allocation probe and make it a readiness gate.
- Change mobile to attempt WebRTC over relay signaling.
- Share one signaling/ICE client contract across web, RN-web, native mobile, and TV where platform APIs permit.
- Meter and display TURN media usage separately from ordinary proxy traffic.
- Add reconnect, credential rotation, last-good-frame, and degradation behavior.

### Phase 3 — attach existing Microsoft desktops

- Support explicit attach flows for a user's existing Windows PC, Azure VM, AVD personal desktop, and Windows 365 Cloud PC.
- Use tenant admin consent only for the narrow app permissions required to deploy/inspect Yaver—not the friend's password.
- Prefer Intune or a tenant-approved app deployment for managed Cloud PCs.
- Keep Office activation in the friend's user profile.

### Phase 4 — managed Azure personal desktop

- Build a separate AVD-personal provider adapter.
- Add delegated/customer-managed Azure connection and RBAC preflight.
- Implement resource graph, budgets, teardown, persistence, host assignment, and session readiness.
- Make first-login/Office activation an explicit human step.
- Only then consider automated creation of raw Windows desktop VMs.

## 10. Acceptance matrix

### 10.1 Headless operations

| Operation | Passing evidence | Forced failure that must be named |
|---|---|---|
| Windows release | Authenticode and published SHA-256 validate; correct architecture runs | Tampered binary is rejected before execution |
| Agent | Signed agent answers real authenticated `/info`/health operation | Scheduled task exists but listener is absent |
| Interactive session | Current user/session ID is interactive and desktop is unlocked | Lock or log off returns `interactive_session_required` |
| Capture | `gdigrab` captures a changing frame | Disable capture permission/backend and retain bounded stderr |
| Encode | Decodable H.264 IDR frame produced at declared profile | Use FFmpeg without `libx264` and get an install route |
| ICE | External probe gathers a relay candidate | Close TURN allocation range and get `turn_allocation_failed` |
| Media | Phone on cellular receives first H.264 frame | Block UDP, prove TCP/TLS TURN fallback; then block all and label JPEG |
| Input | Consented click/key changes a harmless test target | Disable control and prove no input is injected |
| Lease | Exactly one controller; second viewer remains view-only | Race two control acquisitions |
| Windows runner | Exact selected Claude/OpenCode/Codex binary produces a real completion | Put a stub on PATH and reject the false green |
| WSL runner | Selected distro/user/path and PTY execute the repo task | Stop distro and show a WSL restart action |
| Seat handoff | WSL dev URL loads inside PowerPoint WebView2 | Bind server to the wrong interface and name reachability failure |
| PowerPoint | Launch, `Office.onReady`, API-set check, document change succeed | Standalone task-pane page cannot count as Office-host success |
| Azure attach | Assigned user, agent, session, Office, and stream all ready | Running VM with no logged-in user stays `awaiting_first_login` |
| Revocation | Removing device/grant immediately blocks relay and agent access | Reuse old cookie/TURN credential and confirm expiry/rejection |

### 10.2 Closed loops

Run these on a real iPhone-class context, a real tablet-class context, and the web dashboard:

1. Sign in as the friend, never as the owner/operator.
2. Select the Windows Office host and see a named last-known state.
3. Wake or reconnect without losing the last good surface.
4. Open PowerPoint and the disposable GanttSnap presentation.
5. Start a task on the chosen Windows-native, WSL2, or Linux runner seat.
6. Keep the existing PowerPoint surface visible while the runner is coding.
7. Queue one render/reload intent.
8. When the task completes, reload exactly once.
9. Assert visible PowerPoint chrome, GanttSnap task pane, and a successful Office API mutation.
10. Show the truthful transport: direct WebRTC, TURN WebRTC, or JPEG fallback.
11. Disable network paths in turn and verify the ladder and remedies.
12. Lock the desktop and verify a named state with a route to user login, not remote credential collection.

Novel surfaces such as watch, TV, car, and AR/VR should consume the same state codes, but they should not gate the first beta. Watch/car should dispatch and report status; they should not pretend to be full PowerPoint control surfaces. TV/AR may be view or limited control clients after the core phone/tablet/web loop is trustworthy.

## 11. Security and privacy requirements

- The pooled relay is hostile/shared infrastructure by design. It forwards ciphertext and authenticates transport use; it does not authorize access to a Windows box.
- A compromised relay must not obtain an agent bearer token, device private key, Office token, Windows password, runner credential, repository credential, or TURN long-lived secret.
- Every Windows device and WSL seat has its own device key and revocation record.
- Pairing two seats is metadata, not shared private key material.
- Remote viewing and control are different permissions. Control remains opt-in and single-writer.
- Show an unobtrusive local notification while the desktop is being viewed or controlled and make local revoke immediate.
- No clipboard sync by default. If later added, separate text, files, images, and secrets with explicit direction and size policy.
- No audio capture by default for a PowerPoint add-in development session.
- No Office document, screen frame, keystroke, prompt, repo content, or runner output in Convex/relay telemetry.
- Logs use stable reason codes and bounded redacted details.
- TURN usernames are opaque account buckets and short-lived; quotas are account-scoped.
- Remove relay secrets from URLs; prefer short-lived signed grants and scoped cookies.
- Azure infrastructure credentials use scoped service principals or delegated customer connections in the proper secret store. User Office credentials never enter the infrastructure provider.
- Destructive Azure cleanup verifies Yaver-specific resource IDs, tags, ownership links, and active assignments before deletion.

## 12. Verification performed for this audit

No machines or cloud resources were changed.

- Read the current Windows desktop, Ghost, remote runtime, WebRTC/TURN, relay provisioning, mobile/web client, WSL, Azure provider, and credential source.
- Verified the current source revision with `git rev-parse --short HEAD`.
- Ran `go test ./...` in `relay`: **PASS**.
- Attempted a Windows cross-target agent test from macOS. The root agent package failed to compile because multiple functions/types are redeclared (`portBusy`, `AccessDeniedReason`, `cleanProjectList`, `boolPtr`, `runGit`, and others). Foreign Windows test executables also cannot execute on macOS, as expected. The compile failures occur independently and block a clean Windows build claim from this source slice.
- Reviewed current Microsoft documentation for Office automation, Office add-in WebView2/runtime requirements, AVD personal desktops and licensing, Windows 365 requirements/access, and Shared Computer Activation.

Runtime production relay state, Azure tenant entitlement, the friend's Windows PC, Office license, GanttSnap repository, and actual cellular TURN behavior were not available to this source-only audit. They must be probed before beta admission.

## 13. Decision

Proceed with **Windows BYO attach** as the first Windows beta path, under these conditions:

1. The Windows agent has a clean signed build and installer-integrity proof.
2. The friend uses his own Yaver account, Windows user, Microsoft 365 identity, repositories, and runner/provider credentials.
3. PowerPoint runs only in his interactive user session.
4. Native Windows and WSL2 are represented as separate seats when both are used.
5. Relay Pro passes an external TURN allocation and real cellular H.264 first-frame test.
6. Mobile no longer routes all relay users directly to JPEG.
7. Web no longer uses the stale `/rtc/offer` and static TURN credential path.
8. The GanttSnap loop proves a real Office API action inside visible PowerPoint, not just a standalone web page.

For Azure, begin with **attach-only support** for an existing eligible Windows desktop. Prefer **AVD personal desktop** or **Windows 365 Cloud PC** when the user wants a rented, persistent Office environment. Do not extend the current Linux Azure adapter in place and do not request the friend's tenant password. A Yaver-managed Azure Windows offering should be a later, separate desktop provider with delegated RBAC, licensing preflight, first-login state, Office readiness, and operation-level teardown/cost proofs.

