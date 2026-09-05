# Windows BYO laptop + Relay Pro — realistic native-first beta plan

**Date:** 2026-08-16  
**Source slice:** `21235ee2c4` plus the local Windows/BYO implementation and audit pass on branch `codex/windows-native-wsl-agent`.
**Mode:** Plan plus local implementation evidence. No deployment, publish, account change, cloud provisioning, or remote-machine mutation was performed.
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

### 1.1 Current-code reality

| Capability | Current source evidence | Honest status for the friend beta |
|---|---|---|
| Native Windows agent build | `GOOS=windows GOARCH=amd64 go build ./...` passed on 2026-08-16 | Cross-build passes; signed release/install/upgrade still needs proof |
| Persistent runner terminal | `desktop/agent/windows_seat.go`, `runner_pty.go` | Native in-process Windows seats exist; reconnect survives only while the agent process lives |
| Native command execution | `command_shell.go`, `exec.go`, `platform.go` | PowerShell 7 is preferred, Windows PowerShell and `cmd.exe` are fallbacks, and explicit `shell=wsl` has a typed interop path |
| ConPTY startup | `pty_master_windows.go`, `windows_process_args.go` | Startup flags, UTF-16 environment block, and Windows process handles are corrected and cross-built; real Windows TUI execution remains a hardware gate |
| PowerPoint desktop use | Interactive `ONLOGON` task plus native desktop capture/input | Correct topology; must prove the friend's exact Windows session and Office dialogs |
| Screen capture | `remote_runtime_desktop.go` uses FFmpeg `gdigrab desktop`; `remote_runtime_capture.go` now selects its H.264 RTP path | Implemented and no longer dead behind JPEG selection, but a changing first frame on real Windows is still a gate |
| Remote input | Local view/control policy plus session lease | First view choice and control default-off are enforced; DPI, secure-desktop boundary, notification, and revoke need closed-loop proof |
| Relay WebRTC | Authenticated remote-runtime/WebRTC routes and TURN broker exist | Mobile now attempts WebRTC media even when HTTP signaling uses the relay, then falls back once to relay JPEG after a named ICE failure; managed TURN is not yet end-to-end proven |
| Native dependencies | Shared discovery searches `%APPDATA%\npm`, WinGet, Scoop, Volta and other user paths; Yaver installs official Windows x64/arm64 Node zips privately and launches npm/npx `.cmd` shims through `cmd.exe` | Node install/callability is implemented and contract-tested off-host; FFmpeg auto-install still does not cover Windows and real Windows execution remains a hardware gate |
| Runner OAuth | Auth endpoints exist | Native Windows browser interception is not implemented honestly; local one-time login is the beta fallback |
| WSL screen | Linux path is X11-only and rejects Wayland | No direct WSLg desktop claim; Windows capture can show visible WSLg windows |
| Windows beta doctor | `doctor_windows_byo*.go`, CLI and authenticated HTTP route | Project boundary, tools, session, Office/WebView2, power, changing-frame and H.264 probes exist; the live proof still must run on the friend's machine |

### 1.2 BYO host streaming is one capability family, not a Windows special case

The product target is an **optional host-desktop capability** on every BYO machine where the OS exposes a safe interactive capture/input API. “Optional” is load-bearing: installing Yaver must not silently enable screen viewing, and a headless development box remains fully useful through terminal, files, diffs, tasks, and browser preview.

| BYO host | Pixel path | Input path | Honest current boundary |
|---|---|---|---|
| Windows | FFmpeg `gdigrab` -> libx264 -> WebRTC; authenticated JPEG fallback | `ghost`/`SendInput` under the signed-in user | Primary display only; no UAC secure-desktop crossing; requires interactive login and explicit local view/control choices |
| macOS | FFmpeg `avfoundation` -> libx264 -> WebRTC | `ghost`/Quartz accessibility input | Screen Recording and Accessibility permissions must be operation-proven; display index and lock state remain real-machine gates |
| Linux X11 desktop | FFmpeg `x11grab` -> libx264 -> WebRTC | `ghost` X11 input | Requires a real `DISPLAY`; container/headless inventory is not a desktop |
| Linux Wayland | none claimed yet | none claimed yet | Fail with a named Wayland reason until a portal/PipeWire capture plus compositor-approved input design exists |
| Headless Linux/Hetzner | no host desktop | no host desktop | Use terminal, browser-window, dev-server, and structured operations; do not manufacture a fake “PC stream” unless a separately governed virtual desktop is intentionally provisioned |
| WSL/WSLg | native Windows agent captures visible WSLg windows as Windows pixels | native Windows input | WSL agent remains a coding seat; it does not claim the Windows host desktop or an independent WSLg desktop |

The same `desktop-screen` session, consent, lease, audit, WebRTC/TURN, and fallback state machine should serve Windows, macOS, and X11 Linux. Only capture/input adapters are OS-specific.

### 1.3 Client-surface contract and audited reality

“All surfaces” does **not** mean squeezing a 1440x900 desktop onto every display. It means every surface consumes the same authorized capability and either provides an appropriate interaction or gives an explicit handoff.

| Client surface | Appropriate mode | Current code reality | Gate before calling it supported |
|---|---|---|---|
| Web / desktop browser | Full pixels, pointer, keyboard, text, launch/focus | Generic `RemoteRuntimeViewer` consumes remote-runtime targets | Add a first-class, project-independent “This PC” entry and closed-loop desktop target test |
| iOS / Android phone | Full pixels, touch-to-pointer, text, voice | `mobile/app/remote-runtime.tsx` plus the `Remote PC` native-catalog entry | Prove real desktop aspect ratio, keyboard/modifiers, revoke, direct/TURN/JPEG labels on both platforms |
| Tablet | Same as phone with larger layout and keyboard/trackpad | Shares the RN viewer | Run genuine tablet contexts/devices; a resized phone/desktop is not proof |
| tvOS | View plus Siri Remote pointer/scroll/text/voice | Native WebRTC/JPEG viewer and `desktop_voice` client exist | Add desktop discovery and pixel/input/revoke loop on Apple TV hardware |
| Android TV | View plus D-pad/voice, no workstation claim | Android-TV is currently a **render target**; an equivalent Yaver TV viewer is not proven | Build/verify a client consumer or explicitly hand off to phone/web |
| visionOS / XR | Large spatial pixels, gaze/pinch mapped to lease-bound pointer, keyboard/voice | visionOS currently exposes runtime status/reload panels, not the desktop media/control consumer | Port the generic session/transport contract and run headset pixel/input tests |
| watchOS / Wear OS | Speech-only accessibility-tree control and short spoken result | Both native clients call `desktop_voice`; intentionally no video | Prove discovery, ambiguity, consent refusal, cross-machine routing, and handoff to phone |
| CarPlay / Android Auto | Voice-only safe intents and spoken state; never dense pixels | Car voice/task plumbing exists, but end-to-end `desktop_voice` consumption is not proven on both | Wire allowlisted desktop intents, require confirmation for risky actions, and prohibit video while driving |
| Glasses / Mentra | Voice/text summary, optional future low-rate glance card | Current miniapp dispatches tasks and text/TTS, not desktop media | Add explicit desktop-voice/handoff consumer; treat video as device- and safety-policy-specific |

A producer with no consumer is not shipped. A catalog declaration, target ID, or comment that lists a surface is inventory—not a closed loop.

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
- Pixel parity on watch/car as a first-friend release gate. Their shared
  authorization/failure/handoff plumbing is in scope, but the correct UX is
  speech-only rather than a miniature desktop.
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

The remaining manual tool prerequisites are current product gaps, not the desired final onboarding. Yaver now installs official Windows x64/arm64 Node zips into its private runtime and launches their npm/npx batch shims correctly; the FFmpeg install plan still has only macOS/Linux recipes. Native discovery also searches normal Windows user tool locations, including `%APPDATA%\npm`, but discovery is not installation and a path hit is not an operation proof. The production goal is still “install Yaver, approve named dependencies, and let Yaver install/prove them.”

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

For the first beta there is one native Windows agent on the normal local port, `18080`. It makes outbound connections to Yaver's control plane and Relay Pro. The laptop does not need a public IP, router configuration, or an inbound firewall rule.

The agent listener must remain loopback/LAN-scoped according to existing Yaver policy and must never be exposed directly to the internet. A remote client reaches it only through an authenticated Yaver path.

If WSL is added later, its networking and port are a separate admission problem. Current CLI/status paths contain hard-coded `18080` probes; an alternate WSL port can be healthy while diagnostics falsely report it offline. WSL mirrored networking can also make two agents contend for the same port. Do not add the second seat until those cases are operation-tested.

### 6.2 Dev-server reachability

The native-first GanttSnap chain is:

```text
Native Windows dev server
  -> Windows browser
  -> PowerPoint WebView2 task pane
  -> Windows Yaver relay preview
  -> real phone on cellular
```

Do not accept `curl localhost` or a standalone browser page as proof that PowerPoint can load and execute the add-in.

The dev server should bind according to the chosen reachability model, use HTTPS when the Office add-in requires it, and expose only through the authenticated Yaver tunnel—not an unauthenticated public port.

If a later Linux-only operation forces WSL, Microsoft documents that Windows ordinarily reaches a WSL2 dev server through localhost forwarding; mirrored mode changes this model. At that point test the full WSL-to-WebView2 chain described in [WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking), rather than assuming localhost equivalence.

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
3. Install a signed, checksummed Windows Yaver release under the friend's normal Windows user.
4. Authorize the Windows agent and name it `ganttsnap-windows`.
5. Show the local consent page. The friend explicitly enables view; control remains off.
6. Run the native Windows operation-level doctor.
7. Select a project folder owned by the friend; do not default to the whole profile or drive.
8. Clone GanttSnap there and authenticate GitHub/GitLab through the friend's supported browser/device flow.
9. Detect the project and propose only its required native dependencies. The friend approves each privileged or large install.
10. Install and authenticate one selected coding runner natively. For the first beta, if Yaver's browser handoff is not proven on Windows, the friend signs in once in a local Windows terminal.
11. Start GanttSnap's native dev server and prove browser, Relay preview, and PowerPoint WebView2 reachability.
12. The friend signs into PowerPoint manually and sideloads or receives the GanttSnap add-in through a supported test path.
13. Prove view-only access from a second network.
14. Only then may the friend opt into remote control, with local notification and immediate revoke.

No Windows, Microsoft, Git, runner, or provider password is shared with the Yaver owner/operator.

### 9.2 Normal remote session

1. Friend opens Yaver on phone/tablet/web.
2. Yaver shows one device, `ganttsnap-windows`, with separate Code, Preview, and Desktop capabilities.
3. Friend starts a coding task in the allowlisted native Windows repository.
4. The live native runner console streams without opening the desktop.
5. Render/reload requests queue while the runner is coding.
6. When the task completes, Yaver checks the native dev server.
7. Yaver opens or focuses PowerPoint in the same interactive Windows session.
8. The Windows desktop stream remains visible.
9. GanttSnap reloads exactly once.
10. A test action proves `Office.onReady`, required API-set support, and a disposable presentation mutation.
11. Pixel assertion verifies visible PowerPoint chrome and task pane.
12. Friend reviews and accepts/rejects the result.

### 9.3 Optional WSL expansion

Add WSL only after the native Windows doctor records a named, reproducible blocker. At that point create a separate WSL device identity, choose whether Windows or WSL owns the canonical repository, and prove every cross-boundary URL/path explicitly. Do not silently move an existing Windows project into WSL or run two agents as if they were one.

### 9.4 WSL GUI application

If the friend wants to see a Linux GUI tool:

1. Launch the application inside WSL using WSLg.
2. It appears as an ordinary window on the Windows desktop.
3. View/control it through `ganttsnap-windows`.
4. Keep the owning process/task status on the separately named WSL seat.

The UI should say `WSLg app shown through Windows desktop`, not `WSL desktop stream`.

## 10. What the friend must provide—and what Yaver must not ask for

### 10.1 Required from the friend

| Item | Why it is required | Safe acquisition |
|---|---|---|
| His own Yaver account | Device ownership, Relay Pro entitlement, audit, and revocation | He signs in on a trusted device and pairs his laptop |
| Physical control of the laptop | Install approval, first login, UAC, Office dialogs, and emergency revoke | Local actions by the friend; never remote password entry by an operator |
| A dedicated Windows user profile, preferably standard-user | Separates the beta from other household/company users | Existing user or a new local/organization user he controls |
| Supported Windows 11 amd64 laptop | Current Windows artifact and capture path target | Operation-level admission check |
| His own Microsoft 365/Office license | Desktop PowerPoint must be licensed in his interactive session | He signs into Office and completes MFA locally |
| A permitted GanttSnap repository and project directory | Bounds what the coding agent can read/write | Explicit folder picker plus Git remote confirmation |
| GitHub or GitLab authorization | Clone, branch, pull, and push if he later authorizes push | Provider OAuth/device flow in his browser |
| One runner account | Claude Code, Codex, OpenCode, or another selected coding path | Local runner/browser sign-in; Yaver stores no password |
| Consent for named dependency installs | Git, Node, runner, FFmpeg, and project packages may change the machine | Per-install explanation, size, publisher, destination, and undo route |
| Power/network availability | Interactive screen streaming stops when the laptop sleeps or signs out | Plugged in, agreed sleep/lid policy, outbound internet |
| Disposable test data | Proves Office mutations without risking personal/business files | A new presentation with no confidential content |
| Explicit view and control choices | Pixels and input are separate sensitive capabilities | View opt-in first; control opt-in later; both revocable locally |

The friend does **not** need Azure credentials, a public IP, router port forwarding, RDP, an SSH server, a Microsoft tenant admin account, or WSL for the native-first beta.

### 10.2 Microsoft/Office boundary

Yaver needs a working interactive PowerPoint session, not possession of the friend's Microsoft identity. PowerPoint runs as the friend's Windows user; Office and WebView2 retain their own sign-in state. Microsoft documents that Office desktop add-ins on Windows use Edge WebView2, and that unattended/non-interactive Office automation—including a task running as `SYSTEM`—is unsupported. See [Office Add-in webviews](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/browsers-used-by-office-web-add-ins) and [server-side Office automation considerations](https://support.microsoft.com/en-us/visio/considerations-for-server-side-automation-of-office).

For one developer, use the least powerful supported add-in path:

1. local or Office-on-the-web sideload for development when permitted;
2. Microsoft 365 Integrated Apps assignment to `Just me` or a dedicated beta group when the tenant blocks sideloading;
3. Marketplace/production distribution only after the beta.

Microsoft documents sideloading as a testing mechanism and recommends Integrated Apps for centrally deploying add-ins to selected users/groups. See [sideload Office Add-ins for testing](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing) and [deploy Office Add-ins in the Microsoft 365 admin center](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/manage-deployment-of-add-ins).

Tenant admin help is conditional, not a default requirement. It is needed only if the organization blocks sideloading, centrally deploys the manifest, or must consent to declared Microsoft Graph scopes. If GanttSnap uses Graph, GanttSnap—not Yaver—owns the Entra app registration, redirect URIs, MSAL/NAA integration, scope declaration, consent, token handling, and revocation. Yaver may surface the sign-in dialog and a structured success/failure state; it must not extract Office cookies or Graph tokens.

### 10.3 Git, runners, and cloud-provider accounts

The same ownership rule applies to GitHub/GitLab, Vercel, Cloudflare, Supabase, Firebase, and later providers: the friend owns the account and chooses the exact organization/team/project. Yaver detects project evidence and brokers the provider's supported login; it does not become the account owner or ask for a reusable secret in chat.

Detection should be evidence-based—for example a lockfile/package dependency, `vercel.json`/`.vercel`, Wrangler config, `supabase/config.toml`, or `firebase.json`—and must degrade to “not detected.” Detection does not authorize installation, project linking, resource creation, or deployment.

The first Windows workspace image should contain only the universal native core: Yaver, Git, Node/package manager, one runner, FFmpeg, and browser/Office prerequisites. Provider CLIs install on demand, preferably project-local through the lockfile. Yaver-managed SDK/CLI binaries and caches get a **10 GiB hard budget**, with projected size shown before install and an LRU/reclaim UI. Repository dependencies, Docker images, model weights, and the user's existing software are reported separately rather than hidden inside that budget.

Use one uniform Yaver authorization-session UI over provider-specific flows:

| Provider class | Safe beta flow | Important constraint |
|---|---|---|
| GitHub/GitLab | Browser OAuth or device authorization | Show provider, scopes, org/repo, expiry, and completion; never display the resulting token |
| Vercel | Current CLI device flow | User verifies the browser request; link only the selected team/project |
| Cloudflare Wrangler | Browser OAuth with selected scopes and OS-keyring storage | Prefer `--use-keyring`; callback is local to the Windows session |
| Firebase | Browser login; supported non-localhost flow only when needed | Prove account with `projects:list`; avoid legacy long-lived CI tokens for an interactive seat |
| Supabase | Supported browser/token flow routed through a secret-input control | The secret bypasses the LLM, transcript, and logs; reject plaintext credential storage |

Current official provider behavior is not uniform: Vercel documents OAuth device flow; Wrangler uses browser OAuth and can use Windows Credential Manager; Firebase documents `--no-localhost` for remote login; Supabase may use a personal access token and warns that it can fall back to plaintext when native credential storage is unavailable. See [Vercel CLI login](https://vercel.com/docs/cli/login), [Wrangler login/keyring](https://developers.cloudflare.com/workers/wrangler/commands/general/), [Firebase CLI authentication](https://firebase.google.com/docs/cli), and [Supabase CLI login](https://supabase.com/docs/reference/cli/getting-started). “Seamless” therefore means one safe Yaver UX with honest provider-specific states—not pretending every provider has identical OAuth.

Authentication grants the minimum connection only. `link project`, `pull environment`, `preview deploy`, `production deploy`, DNS/domain mutation, database migration, secret write, and destructive resource actions are separate capabilities. Production deploy stays off until the friend explicitly selects provider, account/team, project, environment, source commit, and action. Read-only `whoami`/project-list plus a no-op or preview operation proves the connection before any mutation.

### 10.4 Never request or collect

- Windows password, PIN, Windows Hello secret, or recovery questions.
- Microsoft password, MFA code, recovery code, refresh token, or browser/Office cookies.
- BitLocker recovery key.
- Microsoft 365 global-admin password. If admin consent is required, the admin follows a Microsoft-hosted flow and approves only the declared app/scopes.
- Git, runner, Vercel, Cloudflare, Supabase, Firebase, or other provider secrets pasted into chat, task prompts, logs, URLs, or screenshots.
- Disabling Defender, firewall, Secure Boot, BitLocker, tenant Conditional Access, or endpoint protection as a blanket workaround.
- Public RDP/WinRM/SMB/Yaver ports or permanent router forwarding.
- Access to the entire user profile, OneDrive, Documents, or other repositories when one project directory is sufficient.
- Real customer presentations for automated beta mutations.

### 10.5 Capability grants

Pairing the laptop is not blanket authorization. The friend grants capabilities independently:

| Grant | Default | Scope |
|---|---|---|
| Device ownership | Required | One device key under his Yaver account |
| Project access | Denied until selected | Exact canonical project root; no parent traversal |
| Runner execution | One selected runner | Exact device, project, runner, and task |
| Dependency installation | Ask | Named package/version/source/size; elevation shown separately |
| Desktop view | Explicit opt-in recommended | One Windows interactive session |
| Desktop control | Off | Separate opt-in, single-writer lease, local revoke |
| Clipboard/files/audio | Off and out of scope | Must become separate future grants |
| Dev-server publication | Private only | Authenticated Yaver preview for specific local port |
| External deploy/push | Off unless the friend asks | Specific provider/project/environment/branch |
| Guest collaboration | Off | Separate, expiring device/project/view grants; never inherited from Relay Pro |

Current local source now defaults remote **view** off until an explicit first-run local choice is recorded; control remains a separate opt-in. The remaining gate is closed-loop proof that remote callers cannot establish first consent, every surface renders the refusal and route, and local revoke tears down live media/input.

## 11. Staged delivery plan

### Stage 0 — admit only an operable laptop

Required evidence:

- exact Windows version/architecture;
- laptop power and sleep/lid policy;
- PowerPoint and WebView2 launch;
- Office signed-in state;
- native Git, Node, runner, FFmpeg, browser, and dev-server operation;
- available RAM/disk;
- signed Windows agent build;
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

### Stage 3 — native Windows coding seat

- Prove the allowlisted native repository path and Git operations.
- Detect `package.json`, lockfile, Office manifest, and required CLIs.
- Present dependency installs before changing the machine.
- Prove the exact runner binary and a real model completion.
- Stream raw console output.
- Stop/restart the Yaver agent and prove the named Windows seat reattaches or reports an honest loss.
- Expire runner authentication and prove a visible re-authentication route.

**Go:** a task runs entirely in the intended native Windows repo and the real runner operation succeeds.

**No-go:** wrong user/CWD, whole-profile scan, PATH stub, silent installer, or false authenticated state.

### Stage 4 — native code-to-PowerPoint closed loop

- Start the native Windows dev server.
- Load it from the Windows browser and PowerPoint WebView2.
- Run a small GanttSnap task natively.
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

### Stage 6 — optional WSL admission

Skip this stage unless a named native operation is impossible or materially worse.

- Record the failing native command and why WSL resolves it.
- Register WSL as a separate device identity.
- Decide one canonical repository owner; avoid editing the same checkout from both environments.
- Prove distro/user/CWD, runner, Git, dev-server reachability, shutdown, restart, and port isolation.
- Show WSLg windows through the Windows desktop stream rather than claiming a WSL desktop.

**Go:** WSL resolves the named blocker without weakening identity or confusing task placement.

**No-go:** WSL is added only as convention, or creates ambiguous device/path/port state.

### Stage 7 — resilience week

Exercise repeatedly:

- screen lock;
- sign out/sign in;
- lid close/open under selected policy;
- sleep/wake;
- Wi-Fi change;
- relay reconnect;
- optional WSL shutdown/restart, if admitted;
- Windows Update reboot;
- PowerPoint modal/update/activation dialog;
- dev-server crash;
- runner authentication expiry;
- device/grant revocation.

Every failure must become a named state with a visible next action before expanding the beta.

### Stage 8 — generalize the proven BYO contract to macOS and Linux

Do this only after Windows Stages 1–7 stop producing Windows-specific contract changes.

- Run the same capture -> encode -> ICE -> decode -> input -> revoke probe on a signed macOS agent with Screen Recording and Accessibility permissions.
- Run it on a real X11 Linux workstation.
- Run it on Wayland and headless Linux and require named, visible `unsupported` states with the correct structured alternatives.
- Prove lock/logout/sleep behavior on each OS.
- Keep consent, session authorization, lease, audit, bitrate accounting, and transport labels identical; only the capture/input adapter may differ.
- Verify app launch/focus for a safe allowlisted application on each OS.

**Go:** the same client can switch among authorized Windows/macOS/X11 machines without learning an OS-specific security model.
**No-go:** a platform advertises `desktop-screen` from binary inventory but cannot deliver changing pixels or revoke input.

### Stage 9 — client-surface parity

- Web, iOS, Android, and tablet: full desktop viewer/control loop.
- tvOS: full view plus constrained remote input.
- visionOS/XR: spatial viewer/control consumer.
- watchOS/Wear: speech-only `desktop_voice` loop plus phone handoff.
- CarPlay/Android Auto: allowlisted voice actions plus confirmation/handoff; no driving video UI.
- Glasses: speech/text consumer and explicit handoff; video only after a device-specific safety/privacy review.
- Add one parity test that enumerates producer capability, consumer, supported interaction mode, refusal reason, and handoff for every surface. A surface with neither a consumer nor an explicit refusal/handoff fails.

**Go:** every advertised surface has a real consumer and a failure route appropriate to its form factor.
**No-go:** a catalog string or target declaration is counted as support without pixels/spoken output on the real client.

### Stage 10 — application use cases beyond coding: PowerPoint and Talos/Logo

GanttSnap/PowerPoint is the first Windows GUI closed loop. Talos adds a useful second class: a developer may need to inspect a proprietary Windows Logo ERP UI while coding the Talos web/mobile/agent stack.

- Treat native PowerPoint/Logo/ERP as **host applications**, not special transports. Use `desktop-screen`, app launch/focus, accessibility-tree actions where reliable, and bounded pixel assertions.
- Keep Talos' Logo production-data rule intact: Logo SQL and business data stay read-only. Remote desktop must never become a way to bypass provider/API permissions or automate unreviewed production mutations.
- Prefer Talos' structured API/MCP/web surfaces for repeatable operations; use desktop pixels for visual verification, legacy UI workflows, and human-supervised diagnosis.
- Use a disposable tenant/company/document for any write-path automation test.
- Expect legacy Win32 accessibility trees to be incomplete. When semantic control is unavailable, require visible pixels plus user-driven pointer input; never guess coordinates invisibly.
- Treat headless Hetzner ERPNext as web/terminal/ops, not as a fake desktop. A separately provisioned GUI session would be a new governed resource.
- Add optional per-window capture/redaction before allowing confidential ERP desktops in a broader beta; whole-desktop capture can expose unrelated customer data and notifications.

**Go:** a user can say “open PowerPoint” or “open Logo,” see the correct authorized machine, interact under a lease, and revoke immediately without weakening application/data policy.
**No-go:** desktop access is used as an authorization bypass, wrong-window pixels are streamed, or confidential content enters telemetry.

### Stage 11 — cloud Windows, only after BYO completion gates

Cloud Windows is another host adapter and lifecycle provider, not a shortcut around Stages 0–10. Begin it only after BYO Windows, macOS, Linux-X11, and required client-surface contracts pass.

Recommended evaluation order as of 2026-08:

1. **Windows 365 Cloud PC** for the fastest persistent one-user desktop if the tenant can assign the required Windows 365 and Microsoft 365 Apps licenses. Microsoft recommends Windows 365 rather than new Dev Box investment, and supports browser/app access on major desktop/mobile platforms. Yaver remains an additional coding/streaming/control layer, not a replacement for Microsoft's access and tenant controls.
2. **Azure Virtual Desktop personal desktop** for a one-user-to-one-VM persistent mapping, explicit Azure networking, image, autoscale, and policy control. Prefer personal rather than pooled for Office add-in development until profile, activation, runner credentials, and Yaver device identity are proven under pooling.
3. **Raw Azure Windows 11 VM** for a bounded engineering/dev-test spike where the subscription has valid Windows client multitenant-hosting/dev-test rights. It carries the most lifecycle, access, image, patching, cost, and interactive-session work.
4. **Microsoft Dev Box** only for an existing committed deployment. Microsoft now marks Dev Box as maintenance mode and directs new virtualized developer-environment investment toward Windows 365.

Cloud admission requirements:

- The user or tenant admin authorizes Yaver through Azure/Entra OAuth with least-privilege, resource-scoped roles; no tenant password or reusable Azure secret is pasted into Yaver.
- Provisioning, start, stop, resize, snapshot, delete, image update, and cost-limit are separate grants. Delete is never implied by “disconnect.”
- Use Windows 11 Enterprise client images for desktop Office/add-in work; do not automate Office in Session 0 or as `SYSTEM`.
- For a personal one-user desktop, use that user's eligible Microsoft 365 Apps license and interactive sign-in. For pooled/multi-user VDI, verify Shared Computer Activation eligibility and configure it explicitly; every user still needs an eligible license.
- The cloud machine gets its own Yaver device key, project grants, runner/provider OAuth state, and audit trail. Tenant credentials do not flow into the coding model.
- Prove an interactive user session exists after start/restart. VM power-on is inventory; PowerPoint/WebView2/capture/input is the operation.
- Bound spend before provision: region/SKU/disk/image/hourly estimate, idle shutdown, monthly ceiling, owner-visible usage, and an explicit persistence choice.
- Re-run the complete Windows doctor and phone-on-cellular closed loop. Azure proximity does not prove TURN, capture, Office activation, or input.

Official constraints behind this ordering: Azure supports Windows 11 Enterprise and multi-session images only with qualifying licenses; AVD personal desktops provide a persistent one-to-one user mapping; Microsoft 365 Apps shared-computer activation is for licensed multi-user/RDS/VDI scenarios; and Microsoft currently recommends Windows 365 over new Dev Box deployments. See [Windows 11 on Azure](https://learn.microsoft.com/en-us/azure/virtual-machines/windows/windows-desktop-multitenant-hosting-deployment), [AVD personal desktop assignment](https://learn.microsoft.com/en-us/azure/virtual-desktop/configure-host-pool-personal-desktop-assignment-type), [Microsoft 365 Apps shared computer activation](https://learn.microsoft.com/en-us/microsoft-365-apps/licensing-activation/overview-shared-computer-activation), [Windows 365 overview](https://learn.microsoft.com/en-us/windows-365/overview), and [Dev Box definitions](https://learn.microsoft.com/en-us/azure/dev-box/how-to-manage-dev-box-definitions).

## 12. Required headless probes

| Probe | Passing evidence | Failure route |
|---|---|---|
| Windows agent | Signed binary answers authenticated agent route | Reinstall/repair signed agent |
| Interactive session | Correct user, unlocked interactive desktop | Ask user to log in/unlock; never collect password |
| Project boundary | Canonical selected root, bounded scan, and no parent traversal | Re-select the project root |
| Git | Real remote fetch plus bounded read/write check in the project | Provider device/OAuth flow or repository permission action |
| Node/package manager | Exact binary/version executes under the agent's environment | Signed native Windows install proposal |
| Runner discovery | Exact `.exe`/`.cmd` path resolves under the agent, including the user's npm location | Refresh PATH/search `%APPDATA%\npm` or reinstall |
| Runner auth | Real account/model completion, not a config-file or process check | Local Windows sign-in until remote OAuth interception is proven |
| Provider auth | `whoami` plus exact visible account/team/project list | Typed browser/device/secret-input flow; never paste token into task output |
| Provider scope | Preview/read operation targets selected project/environment | Re-link or reduce scope; production mutation remains disabled |
| Tool budget | Projected and actual Yaver-managed CLI/cache usage stays within 10 GiB | Ask before install, reclaim unused version, or decline |
| Capture | `gdigrab` returns changing frames | FFmpeg/backend remedy with bounded stderr |
| Encode | Decodable H.264 IDR frame | Install supported FFmpeg/encoder |
| ICE | Candidate census reaches `relay-ok` for Pro promise | TURN/firewall/certificate repair |
| Control | Test-target input echo under lease | Enable control or repair DPI/session mapping |
| Dev URL | Agent, Windows browser, WebView2, and remote phone fetch succeed | Bind/certificate/tunnel action |
| Office | PowerPoint + GanttSnap + `Office.onReady` + API mutation | Sign in/activate/sideload/upgrade action |
| Optional WSL | Exact distro/user/CWD, own authenticated endpoint, and Windows/WebView2 URL fetch | WSL update/restart/path/network action |

An inventory result is never sufficient: `ffmpeg.exe` on `PATH`, an Office process, a runner auth file, or a TURN configuration does not pass unless the corresponding capture, API call, model completion, or relayed ICE operation succeeds.

## 13. Security and P2P threat model

### 13.1 Trust boundaries

```text
Friend's phone/tablet/web client
  |  Yaver account + device/session authorization
  |  authenticated signaling/control plane
  v
Shared Yaver control plane / Relay Pro
  |  may observe routing metadata; must not hold endpoint decryption keys
  |  same-owner/scoped-grant checks do not replace endpoint authorization
  v
Friend's Windows Yaver agent
  |  local policy + project allowlist + view/control grants
  v
Interactive Windows user -> PowerPoint / repo / runner / provider CLIs
```

Relay Pro is connectivity and quality-of-service, not the security boundary. A hostile or compromised relay must not gain a shell, inject control, mint endpoint authorization, or cross from tenant A to tenant B. The Windows agent authorizes the caller against its own account/device/grant state before creating a session or accepting input.

### 13.2 Signaling, media, and fallback

For the intended WebRTC path:

1. the authenticated client asks the Windows agent for a short-lived remote-runtime session;
2. authenticated, bounded signaling exchanges SDP/ICE;
3. ICE tries a direct host/server-reflexive path;
4. if direct connectivity fails, the client obtains short-lived, account-scoped TURN credentials and uses TURN;
5. video is protected by WebRTC DTLS-SRTP and data channels by DTLS/SCTP between endpoints; TURN forwards packets and does not terminate the media encryption;
6. the agent accepts control messages only for the authorized live session and active control lease.

TURN still sees connection metadata, allocation timing, and bandwidth. Direct ICE can reveal endpoint IP information to the authorized peer through signaling/candidates. For the friend's own devices, direct-first is reasonable after disclosure. For any future guest/collaborator, offer a **TURN-only privacy mode** so peers do not learn the laptop's host/server-reflexive address, while making the latency/cost trade-off clear.

The authenticated JPEG fallback is not P2P and must never be described as WebRTC. It sends frames through the relay's authenticated HTTP path. The UI must state `Direct WebRTC`, `TURN WebRTC`, or `Relay JPEG`; record no pixels by default; and expose measured latency/bitrate without putting content in telemetry.

### 13.3 Consent and least privilege

- Friend uses his own Yaver account and credentials.
- The native Windows seat has its own non-exported device private key. Any later WSL seat gets a different key.
- Pairing or Relay Pro entitlement does not grant project, screen, input, deploy, or guest access.
- Relay remains shared/pass-through; keys and same-owner checks enforce isolation.
- No public RDP/SSH/agent port.
- No Windows/Microsoft password in Yaver, Convex, logs, tasks, or vault sync.
- View and control are separate permissions.
- View should require a local first-run choice; control defaults off until Stage 2 passes.
- Control is bound to one live viewer/device/session, one writer lease, and a short idle expiry.
- Local user can revoke immediately.
- Starting control posts a local notification/indicator that names the remote device; periodic reminders do not replace the initial indicator.
- Lock, sign-out, user switch, device revoke, grant expiry, or agent shutdown terminates input and live peer connections.
- No clipboard/audio/file transfer in the first beta.
- Screen pixels, Office documents, prompts, source, and runner output do not enter control-plane telemetry.
- Provider OAuth responses and secret-input values bypass the coding model, task transcript, screen recording, and general logs.
- URLs do not carry long-lived bearer or relay credentials.
- The beta uses disposable Office test documents for automated mutations.

### 13.4 Local Windows security

- Run Yaver as the friend's normal interactive user, never `SYSTEM`, administrator-by-default, or another logged-in user's session.
- Use UAC only for a named operation that truly requires elevation. The friend approves it locally; remote input should not be expected to cross the Windows secure desktop.
- Store device/runner/provider tokens in the existing encrypted local Yaver secret design; the Windows product should use a Windows user-bound protection mechanism such as DPAPI/Credential Manager rather than plaintext files. This is a required implementation check, not a claim that every current path already does so.
- Restrict local policy and audit files to the friend. Audit view/control start, stop, caller device, grant, task, and result—never keystrokes, screen contents, OAuth codes, or document contents.
- Pin project roots using canonical Windows path handling; reject junction/symlink/reparse-point escapes where a capability would otherwise cross the allowlist.
- Verify downloaded Yaver and dependency artifacts by publisher/signature and checksum. Record version/source and provide an uninstall route.
- Defender/firewall findings become named remediation states; never silently create broad exclusions.

### 13.5 Revocation and incident response

The friend must be able to revoke from the laptop and another trusted Yaver surface. Revocation must:

1. close live WebRTC/relay streams and control leases;
2. invalidate the scoped device/session/grant server-side;
3. expire or rotate TURN credentials and relay sessions;
4. prevent reconnect without a new authorized pairing/grant;
5. preserve content-free audit metadata for the friend;
6. offer a local `disable all remote access` kill switch that works even if the cloud is unavailable.

### 13.6 Current security/product gaps that block a broad beta

- The public Windows installer downloads an amd64 executable but does not currently verify checksum or Authenticode before execution.
- Native Windows Node install is implemented but still needs a clean-machine operation proof; the FFmpeg auto-install recipe does not currently cover Windows.
- The runner browser interceptor deliberately has no working native Windows browser shim, so “remote OAuth is seamless” is unproven.
- Mobile now attempts WebRTC media before a bounded JPEG fallback; managed Relay Pro still does not operation-prove TURN end to end.
- Several browser/WebView paths still carry `token`/`__rp` query credentials. They should become one-time exchange values or scoped, Secure/HttpOnly/SameSite cookies where browser constraints require cookies—not reusable secrets in navigation URLs, history, logs, or referrers.
- Desktop capture uses the whole Windows desktop/virtual screen; per-window or per-monitor privacy is not yet a guarantee.
- Real Windows execution has not yet proven ConPTY, npm `.cmd` runner shims,
  changing desktop pixels, H.264 decode, PowerPoint, WebView2, lock/logoff, or
  local revoke on the friend's exact hardware.
- Web/mobile/tvOS have media consumers, and watchOS/Wear have speech consumers;
  visionOS, Android TV-as-a-client, car, and glasses still lack the complete
  consumer/refusal/handoff parity described in Section 1.3.

## 14. Product work required before “seamless”

### P0

- Turn the passing Windows cross-build into a reproducible signed release and operation-proven install/upgrade path.
- Make Windows installer architecture-aware and verify signed/checksummed artifacts before replacement.
- Add native Windows FFmpeg and Git install/prove flows. Yaver-managed Node and
  npm-shim callability now exist, but clean-machine installation and real model
  completion still must be proven.
- Add evidence-based provider detection, 10 GiB managed-tool budget, install receipts, and safe reclamation.
- Add a real native Windows runner OAuth/device-flow handoff or an honest local-login route.
- Add typed Git/provider authorization sessions with secret redaction, OS-keyring enforcement, scope/project selection, expiry, revoke, and operation-level proof.
- Prove `gdigrab -> H.264 -> phone first frame` on real Windows.
- Prove direct ICE, TURN-assisted ICE, and the bounded JPEG fallback from the real mobile app on cellular/Wi-Fi transitions.
- Deploy and externally prove managed TURN.
- Remove/fix the stale web `/rtc/offer` and static TURN credential path.
- Add explicit interactive-session/locked/logged-off reason codes.
- Replace reusable query credentials with bounded browser-safe grants/cookies.
- Bind remote-runtime sessions to the authorized viewer device/grant and tear them down on revoke.
- Add the project-independent web “This PC” entry and close the visionOS,
  Android TV client, car, and glasses consumer/handoff gaps without duplicating
  authorization or failure classifiers.

### P1

- Add project-root permission UX and canonical/reparse-point escape tests.
- Add native dependency detection from repository evidence and bounded install receipts/rollback.
- Add Office host doctor: activation, WebView2, manifest, HTTPS, `Office.onReady`, API set, and disposable mutation.
- Add TURN-only privacy policy for guest/collaborator scenarios.
- Add WSL physical-host grouping and cross-seat task/render handoff only when WSL is admitted.
- Remove hard-coded default-port assumptions before supporting alternate WSL ports/mirrored networking.
- Add operation-level WSL distro/user/repo/runner/dev-URL doctor as optional expansion work.
- Add a signed, pinned Windows dependency installer.
- Preserve bounded FFmpeg failure output.
- Add multi-monitor capture/selection.
- Add task-aware sleep/park suppression and honest power state.

### Later, after the numbered gates

- Direct WSLg/Wayland/PipeWire capture only if users need a dedicated Linux-window stream.
- Cloud Windows/Windows 365/AVD provisioning, strictly after BYO and client-surface gates in Stage 11.
- Clipboard/files/audio with separate permissions.
- Any pixel mode on a safety- or size-constrained client beyond the explicit
  surface contract; watch/car remain speech/handoff surfaces by design.

## 15. Realistic effort bands

These are scope bands, not delivery promises:

- **Manual native-Windows laboratory proof:** a few focused engineering days after a clean Windows build exists.
- **One-friend view-only beta with truthful JPEG fallback:** roughly one focused iteration, assuming no new Windows capture defect.
- **Reliable native coding → PowerPoint closed loop:** several focused iterations because Windows install/discovery, OAuth, WebView2, task/render, and session boundaries all need negative tests.
- **Relay Pro TURN-backed H.264 product quality:** a separate networking/release workstream, not a checkbox inside onboarding.
- **Optional WSL expansion:** a separate increment after a real native limitation is measured.
- **Broad unattended consumer beta:** only after a resilience period demonstrates reboot/login/sleep/update recovery.

Do not schedule from these bands until the Stage 0 probes run on the friend's exact laptop. The first operation results will determine whether the work is installer, Windows capture, WSL networking, Office, or relay dominated.

## 16. Final recommendation

Start with this exact product statement:

> Connect your own Windows 11 laptop to Yaver Relay Pro. One native Windows Yaver agent runs the allowlisted GanttSnap repository, selected AI coding runner, tests, dev server, browser preview, PowerPoint, and desktop stream in your own interactive user session. You grant view and control separately, keep all account passwords with their providers, and can revoke access locally. The laptop must be powered, networked, and logged in. Add WSL later only if a measured task requires Linux.

For the first beta, direct WSL “screen streaming” is unnecessary and unsupported by current Yaver. If WSL is later admitted, its terminal and web output should use structured transports; WSL GUI windows should ride inside the Windows desktop stream.

Do not call the result seamless until native dependency installation, runner auth and real completion, project boundary, dev URL, PowerPoint host, first changing frame, control revoke, Relay Pro transport, lock/logoff behavior, and recovery actions pass the acceptance stages above.

## 17. Native Windows distribution and desktop-GUI agent audit

**Audit date:** 2026-08-16. The published-artifact rows below remain a read-only snapshot. The source-state notes were updated after the local hardening work described in §17.9. Nothing was published or deployed.

### 17.1 Bottom line

Yaver can cross-build and publish a native Windows amd64 Go executable, and a Windows x64 Electron/NSIS installer is downloadable. Those are useful release ingredients, but they do **not** yet form a production-safe native Windows install channel or a desktop app that demonstrably becomes an agent.

Do not give either current Windows download to the friend as the supported beta path yet. Keep the friend on the controlled laboratory path until the P0 gates below pass. WSL2 remains the only Windows path the public download page currently calls supported, despite other public copy claiming the GUI turns Windows into a node.

### 17.2 Published-state evidence

| Question | Operation-level result on 2026-08-16 | Verdict |
|---|---|---|
| Is a current native agent artifact published? | GitHub release `v1.99.413` contains `yaver-windows-amd64.exe` and `.zip`; the downloaded exe's SHA-256 matches that release's `checksums.txt` | **Yes, amd64 bytes exist** |
| Is the native agent Authenticode-signed? | The published 61,601,280-byte PE has a zero certificate-table offset and size | **No** |
| Is a Windows desktop installer published? | GUI release `gui/v0.1.2` contains `yaver-gui-0.1.2-win-setup.exe` | **Yes, x64 installer bytes exist** |
| Is the GUI installer Authenticode-signed? | The published 97,511,809-byte PE also has a zero certificate-table offset and size | **No** |
| Is npm current? | Registry `latest` is `yaver-cli@1.99.411`, while source and the newest agent release are `1.99.413` | **No; registry is two releases behind** |
| Does native-Windows npm fetch the current agent? | The published 1.99.411 package defaults `WINDOWS_REPO` to `kivanccakmak/yaver-cli`, whose latest release is `v1.37.0`; the canonical repo has the 1.99.x Windows asset | **No; it selects a stale distribution** |
| Is Scoop published? | No Yaver manifest exists in this repo, Scoop Main, or Scoop Extras; no release job publishes one | **No** |
| Is WinGet published? | No Yaver manifest exists in this repo or the community `winget-pkgs` path; no release job publishes one | **No** |
| Is Chocolatey published? | No nuspec/package pipeline exists in current source | **No** |
| Is there a PowerShell installer? | The source `web/public/install.ps1` is now canonical-repo and architecture-aware, requires the release SHA-256 plus valid Authenticode, installs per-user, and leaves an existing binary intact on failure. The public site has not been redeployed. | **Source hardened; published operation unproven**. The current unsigned release will correctly be rejected until a signed release exists. |
| Can the canonical deploy wrapper ship GUI/Windows? | `deploy/deploy.sh` has CLI/npm and mobile/web targets, but no `gui`, `desktop`, or `windows` target | **No single supported deploy front door**; GUI is tag-workflow-only |

The repository's `docs/security/SECURITY.md` statement that Homebrew/apt/AUR/Scoop/WinGet/Chocolatey are published from `release-cli.yml` is stale and contradicted by code. The live download page is also internally contradictory: it says the desktop GUI embeds the Go agent, later calls the GUI merely a client surface, and separately says native Windows is unsupported. Release copy must become one truthful contract before beta.

### 17.3 Desktop GUI as an agent: source audit

The current release candidate for the new shell is `electron/` (`yaver-gui`), not `desktop/app/` or `desktop/installer/`. All three Electron trees still exist, which is a packaging and ownership hazard. Only one may own the public product and release URL.

What is present in `electron/`:

- electron-builder bundles `resources/bin/yaver.exe` into the Windows app;
- `AgentManager` can probe `127.0.0.1:18080/health`, adopt a healthy listener, or spawn `yaver serve --debug` and restart it after a crash;
- the window loads the real Yaver web dashboard in a hardened Electron shell, so WebRTC/JPEG/terminal/task behavior can reuse the web UI instead of forming a fourth client protocol;
- closing the window hides to the tray, which is the correct shape for an interactive per-user agent;
- the Go agent itself can register a limited-privilege `ONLOGON` Scheduled Task once `serve` actually runs.
- `app.whenReady()` now starts/adopts the agent, names bootstrap as `pairing`
  instead of a false-green, and real quit stops only the child owned by the GUI;
- a process-scoped `prevent-app-suspension` blocker and start-at-login policy
  default on for the remote-node role, with visible tray toggles and no power-plan
  or administrator mutation;
- the same in-window `/auth` surface provides sign-in and account creation, and
  the same dashboard now renders selectable ongoing/review/completed task history,
  the raw console, stop, complete, and confirmed delete operations.

What still blocks the production claim:

1. Fresh-GUI pairing is not yet a packaged closed loop. The shared dashboard can
   reclaim a bootstrap device through `/auth/pair/owner-claim`, and the tray now
   says `pair this PC`, but a clean Windows install still needs a pixel-level
   test proving sign-up/sign-in → local-device claim → authenticated `/info`.
2. Agent state has a typed preload/IPC seam and an honest tray state, but the
   dashboard does not yet consume the local status as a first-run `pairing`,
   `ready`, `locked`, or `screen consent required` action panel.
3. Adoption still begins with anonymous `/health`. It now distinguishes
   bootstrap, but must additionally prove Yaver version/device identity and an
   authenticated owner route before saying the external listener is trusted.
4. The fetcher now verifies `checksums.txt`, and both Windows release workflows
   fail unless every PE is Authenticode-valid. Those workflows have not yet run
   with the real signing secret, so publisher chain/timestamp remain gates, not
   claims.
5. GUI start-at-login and a reversible system-awake assertion now exist. The
   single reference-counted policy for GUI + Go agent, AC/battery guard, and
   display-awake-only-during-view states remain to be implemented.
6. The Electron suite is now 33 passing tests and includes readiness/quit/power
   wiring; the web task parity contract adds three passing tests. No clean
   Windows package test yet proves install, account creation, agent pairing,
   task run/resume/delete, capture, lock, reboot, upgrade, or uninstall.
7. Windows update is not trustworthy yet. npm postinstall deliberately skips
   both `current` repoint and service bounce on Windows; the Go self-updater
   depends on symlink creation and `syscall.Exec` behavior that is not
   operation-proven for a standard Windows account.

WebRTC is not an Electron-specific subsystem. Once the embedded Go agent is truly started, paired, registered, granted local view/control consent, and reachable, the GUI can consume the same dashboard remote-runtime viewer as web while phones/tablets use their existing client. That is the desired architecture. A bundled binary or a catalog entry alone does not prove capture, H.264, ICE/TURN, decode, pixels, control lease, revoke, or lock behavior.

### 17.4 Canonical Windows install product

Ship two clearly named choices from the same signed release lineage:

1. **Yaver Desktop for Windows (recommended):** signed x64 first, per-user NSIS install, bundles and supervises the same signed Go agent, includes pairing/doctor/repair UI, and keeps the tray alive. No Node prerequisite merely to become a Yaver node.
2. **Yaver Agent for PowerShell (advanced/headless):** signed native executable installed per user with a versioned path, checksum plus Authenticode verification, atomic `current` pointer appropriate for Windows, limited `ONLOGON` Scheduled Task, and an explicit uninstall/disable path.

Scoop and WinGet are distribution metadata over those same signed artifacts, not new products. Publish them only after signing, stable URLs, upgrade/rollback, and install/uninstall tests pass. Prefer exact IDs (`winget install --exact --id Yaver.Yaver`) and a Yaver-owned Scoop bucket initially if community acceptance cadence is uncertain. Do not keep `irm ... | iex` as the only native path; if retained, the script must pin a release, verify SHA-256 from an independently fetched signed manifest, require a valid Yaver Authenticode publisher, and never execute on verification failure.

The release front door must add a dry-runnable owner-only GUI/Windows target that triggers or validates the existing tag workflow without bypassing the repository's deployment boundary. A Windows release is complete only when CI installs the produced artifact into a clean Windows VM as a standard user and probes the operation.

### 17.5 Privilege and UAC contract

Yaver Desktop and the Go agent run as the signed-in friend, with the application manifest at `asInvoker`. They must **not** request administrator at first launch or run the interactive agent as `SYSTEM`.

| Operation | Default privilege | Elevation behavior |
|---|---|---|
| Install desktop per user, pair, run agent, code, capture own desktop, WebRTC, user Scheduled Task | Standard user | No UAC |
| Install for all users / Program Files, system service, machine-wide dependency, protected firewall rule | Elevated helper for that exact operation | Explain publisher, action, target, and why; friend approves the OS UAC prompt locally |
| Git/runner/provider OAuth, Office sign-in | User/provider consent | Never use UAC; never collect the password |
| Remote control while UAC/lock/Winlogon secure desktop is active | Not permitted | Pause pixels/input with `SECURE_DESKTOP_ACTIVE`; ask the friend to complete locally |
| Change persistent AC/lid/power policy | User-selected OS setting, possibly admin/policy-managed | Diagnose and deep-link; do not silently mutate a company policy |

The canonical Electron configuration now explicitly sets `asInvoker`,
`perMachine: false`, `allowElevation: false`, and
`selectPerMachineByDefault: false`. This is source evidence only until the NSIS
artifact is installed on a clean standard-user Windows account. For the friend
beta, keep the per-user path and avoid elevation unless a named dependency
proves it is necessary.

### 17.6 Power and availability contract on every desktop OS

“Avoid power save” means a revocable runtime assertion, not permanently rewriting the user's power plan at initialization.

| Host | Current implementation | Required behavior |
|---|---|---|
| Windows native agent/GUI | Electron now owns a process-scoped `prevent-app-suspension` request with a visible tray opt-out; the Go adapter remains absent and doctor only reports AC sleep policy | Unify GUI + Go ownership, add AC/battery state, and add display-required only during an authorized screen-view/control session. No admin needed. |
| macOS agent | `caffeinate -dimsu -w <pid>` is on by default for an authenticated agent and supervised | Keep the system-availability assertion, but separate system-awake from display-awake and surface the user's choice; prove Screen Recording after display lock/wake. |
| Linux non-WSL agent | supervised `systemd-inhibit --what=sleep` is on by default | Keep and operation-probe the inhibitor; provide a named remedy when systemd-inhibit is absent. Wayland desktop streaming remains unsupported until portal/PipeWire exists. |
| WSL agent | Correctly refuses to claim it can inhibit the Windows host | Native Windows companion owns host availability; WSL reports the dependency and never changes host power by inference. |
| Desktop Electron shell | Process-scoped system-awake blocker defaults on, is tray-controlled, and stops on real quit | The canonical shell and agent must share one reference-counted policy so two inhibitors do not fight. Add task/view/battery states and stop assertions on disable/sign-out/uninstall/real quit. |

Recommended states:

- `available`: keep system awake while the user has enabled “This PC is remotely available” and the machine is on AC;
- `task-active`: keep system awake for an active coding/build/deploy task;
- `view-active`: keep system and display awake for an authorized live desktop session;
- `battery-guard`: warn and release the always-on assertion at a user-selected low-battery threshold unless a safety-critical save is finishing;
- `disabled`: no assertion, with the UI honestly warning that the machine may go offline;
- lid close, shutdown, hibernate, firmware behavior, corporate policy, and pre-login remain OS/physical boundaries, never claims Yaver bypasses.

The first-run UI should ask once: “Keep this PC available for remote Yaver sessions while plugged in?” Default on for the explicitly chosen remote-node role, with a visible toggle and exact effect. This is consent to a runtime inhibitor, not consent to change the Windows power plan.

### 17.7 P0 release gates

1. Choose `electron/` as canonical or migrate it, then archive/remove the two competing release-capable Electron products from public ownership paths.
2. Wire embedded-agent start, fresh pairing, authenticated identity/version adoption, status/recovery UI, ownership-aware quit, and standard-user Scheduled Task persistence.
3. Add a test that fails when `app.whenReady()` does not start/adopt the agent; add a packaged clean-VM test that installs GUI, signs in, and proves authenticated `/info` plus device registration.
4. Sign the outer NSIS installer, installed GUI executable, and embedded/native Go agent with the expected Yaver publisher. Make release fail when any required PE lacks a valid timestamped Authenticode chain.
5. Make the GUI release publish `checksums.txt` and provenance; verify the embedded agent before packaging and verify download artifacts before install/update.
6. Point every Windows resolver at `yaver-io/yaver.io`, publish npm at the same version only after Windows assets exist, and fail release when npm/GitHub/GUI embedded versions diverge.
7. Replace the native PowerShell prototype with an architecture-aware, pinned, signed/checksummed per-user installer and repair/uninstall commands.
8. Add `gui`/`desktop` release validation to `deploy/deploy.sh`; do not publish by ad hoc tag instructions outside the canonical owner gate.
9. Implement Windows native keep-awake plus the cross-platform reference-counted power state above; never request admin merely to inhibit sleep.
10. Prove native Windows ConPTY runner completion, PowerShell and npm `.cmd` shims, dependency install routes, PowerPoint/WebView2, changing pixels, H.264, direct WebRTC, TURN, JPEG fallback, input/revoke, lock/UAC pause, sleep/wake, reboot/login, upgrade, rollback, and uninstall on a clean Windows 11 x64 VM and the friend's laptop.
11. Make website/download/dashboard/release notes say one consistent truth and remove claims that are not backed by those operations.
12. Only after the signed x64 lane is stable, add a separately built and tested Windows arm64 agent/GUI/installer and architecture-aware package-manager manifests.

### 17.8 Go/no-go sentence

**Go** when a standard Windows user downloads one signed Yaver installer, verifies the Yaver publisher, installs without UAC for the per-user path, signs in once, sees the local agent become ready, keeps the PC available while plugged in, and can complete a real runner-to-PowerPoint-to-phone/WebRTC loop with local revoke.

**No-go for the published build today:** the downloadable PE entry points remain
unsigned and npm remains stale; Scoop/WinGet and clean-Windows proof do not
exist; fresh pairing/identity and the PowerPoint/WebRTC/revoke loop are not
closed; and public copy still contradicts itself. Local source now starts the
embedded agent, reports pairing honestly, supports account creation plus shared
task history/actions, inhibits sleep reversibly, verifies release checksums,
uses the canonical Windows resolver, and fails future releases closed on
missing Authenticode—but none of that is a shipped claim until the release and
clean-machine gates pass.

### 17.9 Local implementation delta: GUI account and task parity

The canonical desktop product is `electron/`: one hardened Electron shell over
the shared web dashboard plus one bundled Go agent. React Native is not embedded
as a second desktop renderer. Mobile/phone/tablet continue to use the React
Native app; desktop reuses the web dashboard; both speak the same Go-agent task,
terminal, preview, OAuth, device, and relay protocols. This avoids a fourth task
store and keeps a task resumable from any authorized surface.

Account behavior inside the GUI:

- an unauthenticated desktop opens the same chrome-free `/auth` journey inside
  the app window;
- account creation supports passkeys and Google, Microsoft, Apple, GitHub, and
  GitLab OAuth; email/password sign-up and reset render when that backend
  capability is enabled;
- provider pages and callbacks are allowlisted in-window, while unrelated web
  navigation stays outside the application;
- Yaver account authentication, runner OAuth (Codex/Claude/OpenCode providers),
  Git provider authorization, and Office sign-in remain distinct grants. The
  GUI must never treat one as consent for another.

Task behavior inside the GUI:

- the sidebar consumes the agent's real 20-row task list and labels
  queued/running work as `ongoing`, with review/completed/failed/stopped history;
- selecting a historical task hydrates full turns and reconnects its raw
  `rawSince` console lane; the runner/tmux session remains agent-owned, so hiding
  the window or moving to mobile does not create a new task;
- ongoing work has Stop, review has Complete, and terminal work has confirmed
  Delete. Delete removes the agent-local task record; it is not represented as a
  recoverable trash state;
- terminal state crosses an explicit preload bridge for native notifications;
  DOM text observation remains only a compatibility fallback for older deployed
  dashboards;
- Electron remains in the tray when its window closes. Explicit Quit releases
  the GUI-owned sleep assertion and stops only the agent child the GUI spawned;
  an independently running agent that was adopted is left alone.

Verification completed locally on 2026-08-16:

- Electron unit/contracts: 33/33;
- desktop task/runner-renderer parity contract: 4/4;
- web TypeScript and the full Next.js production build: pass after
  regenerating Next route types;
- native Windows/WSL/ConPTY/capture/control focused Go contract set: pass;
- `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build`: pass;
- Electron 43.4.0 + electron-builder 26.15.3 audit: zero known npm
  vulnerabilities (the prior lock had 14, including one critical);
- unsigned directory-only macOS packaging/config validation: pass;
- `git diff --check`: pass.

The repository-wide `go test -count=1 ./...` is **not green** and is not being
reported as one: several assertions outside the focused Windows set fail (ACP
method mapping, MCP inventory, autorun flags/git configuration, browser CDP), two
HTTP tests time out, and `TestBuildBusConcurrentRaceOneWinner` hangs until the
suite's ten-minute timeout. The Windows-focused contracts above complete in
under one second, but the global suite remains a release gate that needs its
own repair rather than being waived.

Still required before the friend beta: a signed Windows CLI release, a signed
NSIS build produced by the hardened workflow, checksum/provenance publication,
standard-user clean-VM install, pixel-level sign-up/OAuth and device-pair proof,
real Codex/OpenCode task resume across desktop and phone, secure-desktop/lock
refusal, restart/start-at-login, and the GanttSnap PowerPoint + WebRTC loop.

### 17.10 Canonical macOS/Linux desktop and npm entry point

`electron/` is now the one release-capable desktop product. The old
`desktop/installer` workflow is a fail-closed tombstone so it cannot publish a
second app with a different ID, auth/task UI, repository URL, or lifecycle.

The canonical GUI release matrix is:

| OS | Architectures | Artifacts | Release requirement |
|---|---|---|---|
| macOS | arm64, x64 | architecture-specific DMG + ZIP | Developer ID signature, hardened runtime, notarization, Gatekeeper assessment, stapled ticket, embedded agent |
| Windows | x64 first | per-user NSIS installer | valid Simkab Authenticode on every PE, timestamp, embedded agent, no elevation |
| Linux | x64, arm64 | AppImage, deb, rpm, tar.gz | package metadata/content probe, executable AppImage runtime, embedded agent |

The unified npm package remains the console product and does not embed an
Electron runtime. `yaver desktop install|update|status|path|download` is an
explicit optional GUI entry point. It selects the current OS/architecture,
resolves only a `gui/v*` component release, downloads the exact asset plus
`checksums.txt`, verifies SHA-256, applies the OS trust check, and installs per
user. macOS uses `~/Applications/Yaver.app`; Linux AppImage uses
`~/.local/opt/yaver` plus an XDG desktop entry and `~/.local/bin/yaver-desktop`;
deb/rpm downloads print the exact explicit `apt-get`/`dnf` command instead of
silently requesting sudo. Windows opens the verified Simkab-signed installer.

The desktop release front door is now `./deploy/deploy.sh desktop` (or `gui`).
It validates synchronized GUI versions, a clean `main` worktree, and immutable
tag state before pushing `gui/v<version>`. No release was triggered here.

Local evidence on 2026-08-16: CLI desktop contracts 7/7; Electron contracts
33/33; desktop task/placement parity 4/4; macOS arm64 unsigned directory-only
packaging succeeds; Electron dependency audit reports zero known
vulnerabilities; full web production build succeeds. Signed DMG/NSIS and native
Linux packages remain CI/clean-machine gates.

## 18. PowerPoint add-in and local/remote runner-renderer decision

The detailed Office/Partner Center analysis is in
[`docs/audits/yaver-powerpoint-addin-windows-partner-deep-audit-2026-08.md`](../audits/yaver-powerpoint-addin-windows-partner-deep-audit-2026-08.md).

The decision is to keep Yaver Desktop as the shared control surface and native
agent, optionally add a thin Office.js developer bridge, and keep GanttSnap as
the real PowerPoint add-in. The add-in performs semantic PowerPoint operations;
the native Windows agent owns repositories, runners, capture, WebRTC, input,
consent, and recovery.

Runner and renderer placement is intentionally independent and already has a
shared code path across web/mobile/Electron through machine roles. All four
combinations are valid: local/local, remote/remote, local runner/remote
renderer, and remote runner/local renderer. For the first GanttSnap split, use
the friend-selected runner and set `ganttsnap-windows` as renderer, with
`runner-clone` and `autoPush: ask`.

Do not call the Office lane complete until a real PowerPoint host—not a
standalone task-pane URL—passes `Office.onReady`, a reversible Office.js
operation, one post-task reload, a visible PowerPoint/task-pane pixel assertion,
WebRTC direct and TURN first-frame tests, and local revoke/lock refusal.

Simkab can enroll as the Microsoft publisher, but Partner Center enrollment is
separate from Windows Authenticode. The existing SimplySign/Certum license must
still be proven usable either as an exportable protected CI PFX or on a tightly
controlled Windows signing runner; ownership of the license alone does not make
the current hosted workflow operable.
