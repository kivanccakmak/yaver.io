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

Current source defaults remote **view** on, while control defaults off. For this beta the safer product contract is an explicit local first-run view choice as well. Until that change exists, onboarding must show the current policy and require the friend to confirm it locally before any frame is served.

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

- Remote view currently defaults on in `desktop/agent/remotedesktop.go`; the proposed explicit first-run consent is not yet implemented.
- The public Windows installer downloads an amd64 executable but does not currently verify checksum or Authenticode before execution.
- Windows runner discovery relies mainly on the agent `PATH` and does not explicitly search `%APPDATA%\npm`.
- The native Node and FFmpeg auto-install recipes do not currently cover Windows.
- The runner browser interceptor deliberately has no working native Windows browser shim, so “remote OAuth is seamless” is unproven.
- Mobile currently selects JPEG whenever a relay base URL exists; managed Relay Pro does not yet operation-prove TURN.
- Several browser/WebView paths still carry `token`/`__rp` query credentials. They should become one-time exchange values or scoped, Secure/HttpOnly/SameSite cookies where browser constraints require cookies—not reusable secrets in navigation URLs, history, logs, or referrers.
- Desktop capture uses the whole Windows desktop/virtual screen; per-window or per-monitor privacy is not yet a guarantee.

## 14. Product work required before “seamless”

### P0

- Restore a clean signed Windows build and release-integrity path.
- Make Windows installer architecture-aware and verify signed/checksummed artifacts before replacement.
- Add native Windows Node, FFmpeg, Git, and runner discovery/install/prove flows, including `%APPDATA%\npm`.
- Add evidence-based provider detection, 10 GiB managed-tool budget, install receipts, and safe reclamation.
- Add a real native Windows runner OAuth/device-flow handoff or an honest local-login route.
- Add typed Git/provider authorization sessions with secret redaction, OS-keyring enforcement, scope/project selection, expiry, revoke, and operation-level proof.
- Change first-run remote view from implicit default to explicit local consent.
- Prove `gdigrab -> H.264 -> phone first frame` on real Windows.
- Fix mobile's `relay URL => JPEG only` decision.
- Deploy and externally prove managed TURN.
- Remove/fix the stale web `/rtc/offer` and static TURN credential path.
- Add explicit interactive-session/locked/logged-off reason codes.
- Replace reusable query credentials with bounded browser-safe grants/cookies.
- Bind remote-runtime sessions to the authorized viewer device/grant and tear them down on revoke.

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

### Later

- Direct WSLg/Wayland/PipeWire capture only if users need a dedicated Linux-window stream.
- Cloud Windows/AVD provisioning.
- Clipboard/files/audio with separate permissions.
- TV/AR view clients and watch/car task-only controls.

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
