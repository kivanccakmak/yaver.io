# Windows BYO laptop + Relay Pro — realistic native-first beta plan

**Date:** 2026-08-16  
**Source slice:** `8cb585c85`  
**Mode:** Planning and analysis only. No implementation, deployment, install, account change, or remote-machine mutation was performed.  
**Beta user:** One invited friend, using his own Windows laptop, Microsoft/Office account, Git account, coding-runner accounts, and Yaver account.

## 1. Decision

Use the friend's existing Windows laptop as the first real Windows beta. Start with **one native Windows Yaver agent and one device identity**.

The default topology is:

```text
Physical Windows laptop
  +-- Native Windows Yaver agent
        +-- repository + Git
        +-- Node/package manager
        +-- Claude/OpenCode/Codex
        +-- tests + dev server + browser
        +-- PowerPoint + WebView2
        +-- Windows desktop pixels/input
```

This is the simplest and safest first product: one scheduler, one repository path model, one runner environment, one device key, one desktop session, and no cross-seat handoff.

WSL2 is optional. Add a second WSL Yaver seat only when a measured project operation cannot work natively on Windows. Do not install WSL merely because it is available.

The first beta should support four distinct surfaces:

| User need | First-beta surface | Transport |
|---|---|---|
| See and control PowerPoint/Windows | Native Windows `desktop-screen` | H.264 WebRTC when proven; authenticated JPEG fallback |
| Watch Claude/OpenCode/Codex working | Native Windows ConPTY runner console | Authenticated WebSocket/SSE through Yaver relay |
| View the web app | Native Windows dev-server/browser preview | Authenticated HTTP through the Windows agent tunnel |
| Use an optional WSL-only tool | Add WSL only after a native capability failure | WSL terminal/web output; WSLg window through Windows desktop |

Do **not** make WSL or a separate streamed WSL desktop a beta dependency.

## 2. Can WSL stream its screen?

### 2.1 Practical answer

**WSL applications can be seen remotely, but the correct first implementation is to capture them as part of the Windows desktop.**

Microsoft's WSLg integrates individual Linux X11 and Wayland applications into the Windows desktop. It does not provide a full independent Linux desktop. WSLg applications appear in the Windows Start menu, taskbar, and Alt-Tab. See [Microsoft's WSL GUI application guide](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps).

That means:

- launch a Linux GUI app from WSL;
- WSLg renders it as a visible Windows desktop window;
- the native Windows Yaver agent captures that window using `ffmpeg`/`gdigrab`;
- the phone/tablet controls it through the same Windows `SendInput` path.

This is enough for browsers, editors, utilities, and visual WSL apps that WSLg supports.

### 2.2 What current Yaver cannot do

The Linux `desktop-screen` implementation uses `x11grab` and explicitly refuses to start when `WAYLAND_DISPLAY` is set (`desktop/agent/remote_runtime_desktop.go:439-470`). WSLg supports Wayland and X11 and normally exposes a Wayland environment. Current Yaver therefore cannot honestly claim a separate WSLg desktop capture target.

Even without that guard, WSLg is not a complete GNOME/KDE desktop framebuffer. Capturing an X root window would not reliably represent every WSLg application.

A future direct WSL display feature would need a WSLg-aware capture design, such as a supported PipeWire/Wayland portal path, plus operation-level tests. It is not necessary for the friend beta.

### 2.3 Better WSL presentation modes

For the first beta, use:

1. **Terminal:** raw runner/tmux stream from the WSL Yaver agent.
2. **Web UI:** direct dev-server/browser preview from WSL.
3. **GUI app:** WSLg window inside the native Windows desktop stream.
4. **Files/diffs:** structured Yaver task/diff surfaces rather than pixels.

Pixels are the right proof for PowerPoint and GUI behavior; they are a poor substitute for a terminal stream or structured diff.

## 3. Honest beta scope

### In scope

- One friend-owned Windows 11 laptop.
- One friend-owned Yaver account and Relay Pro entitlement.
- Native Windows Yaver agent.
- Native Windows repository, Git, Node, runner, tests, and dev server.
- WSL2 only as an optional fallback after a native operation fails.
- GitHub or GitLab authentication belonging to the friend.
- One selected AI runner at first; expand only after the first works.
- GanttSnap repository in a native Windows project directory.
- Native Windows dev server viewed from PowerPoint and phone.
- Real desktop PowerPoint and GanttSnap task pane.
- Phone, tablet, and web control surfaces.
- View/control consent, revocation, audit, and single-writer lease.
- Direct and relay/fallback connectivity tests.

### Out of scope for the first beta

- A Yaver-provisioned Azure Windows desktop.
- Multiple Windows users sharing one laptop.
- WSL as a mandatory part of the first topology.
- Separate full WSL desktop streaming.
- Multi-monitor PowerPoint presenter mode.
- GPU/nested emulator guarantees.
- Fully unattended recovery before Windows user login.
- Watch, car, TV, or AR/VR as release gates.
- Clipboard/file synchronization through the screen session.
- Running Office as a service or Session 0.

## 4. Required laptop state

The beta laptop should satisfy:

- Supported Windows 11 release with current security updates.
- amd64 initially, matching the current installer artifact.
- BitLocker/device encryption enabled where available.
- A normal non-shared Windows user profile belonging to the friend.
- PowerPoint/Microsoft 365 Apps installed and licensed for that user.
- Edge WebView2 runtime operational.
- Git and a supported Node.js LTS installed natively for the friend during the current manual beta.
- The selected coding runner installed natively and authenticated by the friend.
- A Windows FFmpeg build with working `gdigrab` and H.264 encoding.
- At least 16 GiB RAM; 32 GiB preferred for PowerPoint, browser, WSL, Node, and an AI runner together.
- Sufficient free SSD space for repository, Node caches, WSL virtual disk, and Office updates.
- Laptop plugged in during remote sessions.
- Windows sleep/lid policy deliberately set for the beta; the product must report the chosen state.
- Stable outbound internet access. No public inbound RDP, SSH, or Yaver port.

The user must understand one physical constraint: if the laptop sleeps, powers off, loses networking, or is waiting at the pre-login screen after reboot, Yaver cannot stream the interactive desktop. WSL cannot keep Windows awake.

The manual tool prerequisites are current product gaps, not the desired final onboarding. Yaver's bundled Node installer has no Windows artifact path, the FFmpeg install plan has only macOS/Linux recipes, and Windows runner discovery does not search the normal `%APPDATA%\npm` directory explicitly. The production goal is still “install Yaver, approve named dependencies, and let Yaver install/prove them.”

## 5. Identity and execution layout

### 5.1 One native Windows device

Suggested alias: `ganttsnap-windows`.

The single native agent owns:

- the canonical Windows repository path;
- Git credentials and operations;
- native Node/package manager;
- native Claude Code, OpenCode, Codex, or another selected runner;
- tests, builds, and dev-server processes;
- browser preview;
- PowerPoint, Office activation, and WebView2;
- desktop screen capture;
- mouse/keyboard input;
- Windows session state and scheduled logon task.

It uses one unique device key under the friend's Yaver account. All task, terminal, preview, desktop, and Office operations resolve against this same device until a real limitation requires another seat.

### 5.2 Optional WSL expansion

Only add WSL if a named operation fails natively—for example a Linux-only build script, shell assumption, container workflow, or deployment parity test.

If added, WSL becomes a separate `ganttsnap-wsl` device with its own key, repository decision, runner credentials, status, and port. It is not an invisible extension of `ganttsnap-windows`.

The optional relationship may later use `physicalHostGroup` metadata, but this is not needed for the native-first beta.

## 6. Port and networking plan

### 6.1 Agent ports

Both environments default to port `18080`, but they are independent only while WSL2 uses its normal virtualized/NAT network namespace.

For the first beta:

- Windows native agent: `18080`.
- WSL agent: `18080` inside the WSL NAT namespace.
- Do not enable WSL mirrored networking until dual-agent bind and discovery are tested.
- Both agents register outbound to Relay Pro as different devices.

Using a non-default WSL agent port sounds simple, but current CLI/status paths contain multiple hard-coded `18080` probes. Starting WSL on `18081` could make the process healthy while local diagnostics falsely report it offline. That is a product gap, not a beta workaround to normalize.

### 6.2 Dev-server reachability

Microsoft documents that Windows can ordinarily reach a WSL2 dev server through localhost forwarding. Windows 11 mirrored mode also permits bidirectional localhost access, but it changes the networking model. See [WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking) and [WSL interop](https://learn.microsoft.com/en-us/windows/dev-environment/wsl-interop).

For GanttSnap, test the real chain:

```text
WSL dev server
  -> Windows browser
  -> PowerPoint WebView2 task pane
  -> WSL Yaver relay preview
  -> real phone on cellular
```

Do not accept `curl localhost` inside WSL as proof that PowerPoint can load the add-in.

The dev server should bind according to the chosen reachability model, use HTTPS when the Office add-in requires it, and expose only through the authenticated Yaver tunnel—not an unauthenticated public port.

## 7. Persistence and restart reality

### 7.1 Windows agent

The native Windows agent installs an `ONLOGON`, limited-privilege scheduled task. That is correct for interactive desktop capture, but it means:

- it starts after the friend logs into Windows;
- it cannot stream the pre-login screen;
- it should not be replaced with a `SYSTEM` service for PowerPoint control;
- after reboot, a human login may be required before the Office host returns.

### 7.2 WSL agent

Current Yaver WSL autostart writes shell hooks and tries a Windows scheduled task or Startup wrapper that invokes `wsl.exe`. It correctly depends on Windows login.

Microsoft supports systemd in WSL, but also states that systemd services do not by themselves keep the WSL instance alive. See [systemd in WSL](https://learn.microsoft.com/en-us/windows/wsl/systemd).

The product state must distinguish:

- Windows asleep/offline;
- Windows booted but no user logged in;
- Windows logged in and locked;
- Windows agent offline;
- WSL distribution stopped;
- WSL running but WSL agent offline;
- both seats ready;
- Office activation/action required.

## 8. Relay Pro plan

### 8.1 Beta transport ladder

Target behavior:

```text
LAN/direct WebRTC
  -> server-reflexive WebRTC
  -> TURN-assisted WebRTC
  -> authenticated JPEG fallback
```

Control-plane requests can use Relay Pro regardless of which media path wins.

### 8.2 Current limitation

The audited mobile remote-runtime screen selects `relay-jpeg-poll` whenever `activeRelayBaseUrl` exists. Managed Relay Pro provisioning also does not currently prove an installed TURN service. Therefore the beta must not promise “Relay Pro means WebRTC.”

Two honest stages are possible:

- **Beta A:** Relay-authenticated JPEG desktop fallback plus terminal/dev-server surfaces. Label it `Relay · JPEG` and measure usability.
- **Beta B:** After managed TURN and mobile transport selection are fixed, require a real H.264 first frame over TURN from a phone on cellular. Label it `Relay · WebRTC/TURN` only after that operation passes.

The native Windows `desktop-screen` target already contains the intended `gdigrab -> libx264 -> RTP` path, but readiness must prove capture, encode, ICE, decode, and input—not merely find FFmpeg.

## 9. User workflow

### 9.1 One-time onboarding

1. Friend creates/signs into his own Yaver account.
2. Relay Pro entitlement is attached to that account.
3. Install a signed/checksummed Windows Yaver release.
4. Authorize the Windows agent and name it `ganttsnap-office`.
5. Enable remote view; keep remote control off until explicitly tested.
6. Run the Windows operation-level doctor.
7. Install/update WSL2 and the selected Ubuntu distribution.
8. Install the Linux Yaver agent inside WSL under the friend's Linux user.
9. Authorize it as a second device and name it `ganttsnap-code`.
10. Clone GanttSnap into the selected canonical WSL repository location.
11. Authenticate GitHub/GitLab through the friend's supported device/browser flow.
12. Install and authenticate one selected coding runner in WSL.
13. Install only the cloud CLIs detected from the project.
14. Start GanttSnap's dev server and prove Windows/PowerPoint/WebView2 reachability.
15. Sign into PowerPoint manually and sideload/deploy the GanttSnap add-in through a supported test path.

No Windows, Microsoft, Git, runner, or provider password is shared with the Yaver owner/operator.

### 9.2 Normal remote session

1. Friend opens Yaver on phone/tablet/web.
2. Yaver shows `ganttsnap-code` and `ganttsnap-office` as two related seats.
3. Friend starts a coding task on `ganttsnap-code`.
4. The live WSL runner console streams without opening the Windows desktop.
5. Render/reload requests queue while the runner is coding.
6. When the task completes, Yaver checks the WSL dev server.
7. Yaver opens or focuses PowerPoint on `ganttsnap-office`.
8. The Windows desktop stream remains visible.
9. GanttSnap reloads exactly once.
10. A test action proves `Office.onReady`, required API-set support, and a disposable presentation mutation.
11. Pixel assertion verifies visible PowerPoint chrome and task pane.
12. Friend reviews and accepts/rejects the result.

### 9.3 WSL GUI application

If the friend wants to see a Linux GUI tool:

1. Launch the application inside WSL using WSLg.
2. It appears as an ordinary window on the Windows desktop.
3. View/control it through `ganttsnap-office`.
4. Keep the owning process/task status on `ganttsnap-code`.

The UI should say `WSLg app shown through Windows desktop`, not `WSL desktop stream`.

## 10. Staged delivery plan

### Stage 0 — admit only an operable laptop

Required evidence:

- exact Windows version/architecture;
- laptop power and sleep/lid policy;
- PowerPoint and WebView2 launch;
- Office signed-in state;
- WSL2 distribution/version/user;
- available RAM/disk;
- signed Windows agent build;
- current WSL agent build;
- no conflicting listener state.

**Go:** all required operations pass.  
**No-go:** Windows agent does not compile/install, laptop cannot remain awake, Office is not licensed, or the friend will not use a separate account.

### Stage 1 — Windows view-only

- Register only the Windows seat.
- Capture a real changing desktop frame.
- View from web, then phone on another network.
- Lock/log off and confirm named failure states.
- Reboot and confirm the documented human-login requirement.
- Keep control disabled.

**Go:** view is reliable and honest about JPEG/WebRTC.  
**No-go:** black/stale frame, endless spinner, incorrect session, or cross-user access.

### Stage 2 — controlled Windows input

- Enable control explicitly.
- Acquire a single-writer lease.
- Test mouse, typing, chords, DPI mapping, and local revoke on a harmless test app.
- Show local view/control notification.
- Repeat with PowerPoint and a disposable presentation.

**Go:** input is accurate, revocable, and audited.  
**No-go:** input enters the wrong session/app or survives revoke.

### Stage 3 — WSL coding seat

- Register the WSL agent separately.
- Prove repository path and Git operations.
- Prove the exact runner binary and a real model completion.
- Stream raw console output.
- Stop WSL with `wsl --shutdown` and confirm a named recovery route.
- Verify Windows and WSL agents cannot be confused.

**Go:** a task runs entirely in the intended WSL repo.  
**No-go:** task lands in Windows, wrong distro/user, wrong CWD, or a PATH stub.

### Stage 4 — WSL-to-PowerPoint closed loop

- Start the WSL dev server.
- Load it from Windows browser and PowerPoint WebView2.
- Run a small GanttSnap task in WSL.
- Queue one render.
- Reload PowerPoint once after completion.
- Prove an Office API action and visible pixels.

**Go:** code-to-Office loop works without manual path/URL repair.  
**No-go:** standalone web page is mistaken for PowerPoint-host validation.

### Stage 5 — Relay Pro WebRTC/TURN

- Put phone on cellular and laptop on ordinary home/office internet.
- Fetch short-lived authenticated ICE credentials.
- Gather a real relay candidate.
- Receive a decodable H.264 first frame.
- Block UDP and prove TCP/TLS TURN fallback.
- Block all TURN paths and prove named JPEG fallback.
- Measure bitrate, latency, and paid bandwidth accounting.

**Go:** actual transport matches the UI label.  
**No-go:** Relay Pro entitlement is treated as proof of TURN.

### Stage 6 — resilience week

Exercise repeatedly:

- screen lock;
- sign out/sign in;
- lid close/open under selected policy;
- sleep/wake;
- Wi-Fi change;
- relay reconnect;
- WSL shutdown/restart;
- Windows Update reboot;
- PowerPoint modal/update/activation dialog;
- dev-server crash;
- runner authentication expiry;
- device/grant revocation.

Every failure must become a named state with a visible next action before expanding the beta.

## 11. Required headless probes

| Probe | Passing evidence | Failure route |
|---|---|---|
| Windows agent | Signed binary answers authenticated agent route | Reinstall/repair signed agent |
| Interactive session | Correct user, unlocked interactive desktop | Ask user to log in/unlock; never collect password |
| Capture | `gdigrab` returns changing frames | FFmpeg/backend remedy with bounded stderr |
| Encode | Decodable H.264 IDR frame | Install supported FFmpeg/encoder |
| ICE | Candidate census reaches `relay-ok` for Pro promise | TURN/firewall/certificate repair |
| Control | Test-target input echo under lease | Enable control or repair DPI/session mapping |
| WSL | Selected distro/version/user actually starts | WSL update/restart action |
| WSL agent | Its own authenticated endpoint answers | Restart the WSL agent, not Windows agent |
| Repo | Git root, remote, branch, status, read/write operation | Choose/clone/authenticate correct repo |
| Runner | Real completion from selected account/model | Device/browser auth action |
| Dev URL | WSL, Windows browser, WebView2, and relay fetch succeed | Bind/certificate/networking action |
| Office | PowerPoint + GanttSnap + `Office.onReady` + API mutation | Sign in/activate/sideload/upgrade action |

## 12. Security rules

- Friend uses his own Yaver account and credentials.
- Native Windows and WSL seats use different device keys.
- Pairing does not authorize either seat to impersonate the other.
- Relay remains shared/pass-through; keys and same-owner checks enforce isolation.
- No public RDP/SSH/agent port.
- No Windows/Microsoft password in Yaver, Convex, logs, tasks, or vault sync.
- View and control are separate permissions.
- Control defaults off until Stage 2 passes.
- Local user can revoke immediately.
- No clipboard/audio/file transfer in the first beta.
- Screen pixels, Office documents, prompts, source, and runner output do not enter control-plane telemetry.
- URLs do not carry long-lived bearer or relay credentials.
- The beta uses disposable Office test documents for automated mutations.

## 13. Product work required before “seamless”

### P0

- Restore a clean signed Windows build and release-integrity path.
- Prove `gdigrab -> H.264 -> phone first frame` on real Windows.
- Fix mobile's `relay URL => JPEG only` decision.
- Deploy and externally prove managed TURN.
- Remove/fix the stale web `/rtc/offer` and static TURN credential path.
- Add explicit interactive-session/locked/logged-off reason codes.
- Make WSL and Windows seats visibly distinct.

### P1

- Add physical-host grouping and cross-seat task/render handoff.
- Remove hard-coded default-port assumptions before supporting alternate WSL ports/mirrored networking.
- Add operation-level WSL distro/user/repo/runner/dev-URL doctor.
- Add a signed, pinned Windows dependency installer.
- Preserve bounded FFmpeg failure output.
- Add multi-monitor capture/selection.
- Add task-aware sleep/park suppression and honest power state.

### Later

- Direct WSLg/Wayland/PipeWire capture only if users need a dedicated Linux-window stream.
- Cloud Windows/AVD provisioning.
- Clipboard/files/audio with separate permissions.
- TV/AR view clients and watch/car task-only controls.

## 14. Realistic effort bands

These are scope bands, not delivery promises:

- **Manual two-seat laboratory proof:** a few focused engineering days after a clean Windows build exists.
- **One-friend view-only beta with truthful JPEG fallback:** roughly one focused iteration, assuming no new Windows capture defect.
- **Reliable WSL coding → PowerPoint closed loop:** several focused iterations because path, URL, identity, task/render, and session boundaries all need negative tests.
- **Relay Pro TURN-backed H.264 product quality:** a separate networking/release workstream, not a checkbox inside onboarding.
- **Broad unattended consumer beta:** only after a resilience period demonstrates reboot/login/sleep/update recovery.

Do not schedule from these bands until the Stage 0 probes run on the friend's exact laptop. The first operation results will determine whether the work is installer, Windows capture, WSL networking, Office, or relay dominated.

## 15. Final recommendation

Start with this exact product statement:

> Connect your own Windows 11 laptop to Yaver Relay Pro. Use the Windows seat to view and control PowerPoint and any visible WSLg windows. Use the separate WSL2 seat for Linux repositories, AI coding runners, terminal output, tests, and dev servers. Yaver coordinates task completion and one PowerPoint reload. The laptop must be powered, networked, and logged into the friend's interactive Windows session.

For the first beta, direct WSL “screen streaming” is unnecessary and unsupported by current Yaver. WSL terminal and web output should use native structured transports; WSL GUI windows should ride inside the Windows desktop stream.

Do not call the result seamless until the two seat identities, runner placement, dev URL, PowerPoint host, Relay Pro transport, lock/logoff behavior, and recovery actions pass the acceptance stages above.
