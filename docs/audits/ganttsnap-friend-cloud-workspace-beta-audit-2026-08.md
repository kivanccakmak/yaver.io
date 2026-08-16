# GanttSnap friend beta on Yaver Cloud Workspace — deep audit

**Date:** 2026-08-16  
**Source slice:** `cb27d4ae1` (`fix: retain restored integration contracts`)  
**Task:** Determine whether a friend building the GanttSnap PowerPoint add-in can beta-test Yaver using (a) his existing Windows box with Relay Pro, (b) a Hetzner/Linux or Hetzner/Windows host, or (c) an Azure/Windows host; his own OpenCode/DeepSeek, Microsoft, GitHub/GitLab, Vercel, Cloudflare, Supabase, and Firebase accounts; and Yaver clients on phone, web, tablet, TV, watch, car, and AR/VR.  
**Mode:** Analysis only. No product code, deployment, account creation, cloud provisioning, or external resource mutation was performed.

## Executive verdict

The right beta topology is **one independent Yaver account and one dedicated Cloud Workspace owned by the friend**. It must not be a seat inside the owner's account, a shared login, a second Unix user on the owner's box, or a guest token aimed at the owner's Cloud Workspace.

That dedicated-account topology matches the current control plane:

- `cloudMachines.userId` is the owner boundary.
- Cloud machine reads, wake, auto-park, deletion, and provisioning are scoped to the authenticated user's id.
- A normal Cloud Workspace plan has a one-machine quota.
- The BYOK workspace is a dedicated VM whose mutable home/workspace state is stored on a persistent volume.
- AI usage is deliberately BYOK: Yaver sells the workspace and connectivity, not model tokens.

It is **not ready to invite the friend today from this checkout**. Six P0 problem families are open:

1. The Go agent package does not compile at the audited commit because production symbols are duplicated and host-share tests refer to production types/fields that do not exist.
2. The mobile TypeScript baseline is broadly red, including a concrete launch-flag drift: `guests.tsx` imports `ENABLE_GUEST_FEATURES`, but `mobile/src/lib/launchFlags.ts` does not export it.
3. DeepSeek is shown as an OpenCode model/provider, but the first-class runner-auth set/setup API cannot accept `DEEPSEEK_API_KEY`; the encrypted Yaver vault that those APIs write to is also off by default.
4. Linux can build and serve a PowerPoint web add-in, but Yaver's current browser runtime opens the project's localhost dev server in an ephemeral headless Chromium profile. It does not open an authenticated PowerPoint-on-the-web document and therefore cannot honestly prove Office.js integration.
5. The cloud-developer toolchain is not a coherent product contract yet: the Dockerfile attempts to preload Wrangler but not Vercel, Supabase, or Firebase; its npm install failures are ignored; Firebase is detectable/deployable but has no Yaver installer or account provider; and no measured image/tool/cache budget enforces the requested 10 GiB ceiling.
6. GitHub/GitLab device-flow authorization is substantially implemented, but it requires registered OAuth client ids. Vercel's current device flow, Cloudflare's new Authorization Code + PKCE flow, Supabase token login, and Firebase/Google headless login are not unified into a cross-surface Yaver authorization state machine.

The practical product decision is:

| Question | Verdict |
|---|---|
| Give the friend his own Yaver Cloud Workspace | **GO after P0 build/onboarding gates pass** |
| Let the friend use the owner's Yaver account or bearer token | **NO-GO** |
| Add the friend as a guest/teammate on the owner's Cloud Workspace | **NO-GO; feature family is deliberately disabled and incomplete** |
| Use OpenCode on the friend's Linux workspace | **Architecturally GO; must pass live runner/auth probe** |
| Use DeepSeek from the friend's own account | **AMBER; recognized but not productized end to end** |
| Build and preview GanttSnap's standalone web UI on Linux | **GO once baseline and project probes pass** |
| Validate the add-in inside PowerPoint on Linux | **Only via PowerPoint on the web; current Yaver closed loop is incomplete** |
| Existing dedicated Windows box with desktop PowerPoint | **Best native Office proof host; AMBER until real Windows agent/session/WebRTC probes pass** |
| Demand “Relay Pro and WebRTC only” | **NO-GO as phrased; Relay HTTP is JPEG polling, while WebRTC needs a separately proven TURN path** |
| Hetzner Cloud with Windows 10/11 | **NO-GO under Hetzner's current licensing policy** |
| Hetzner Windows Server + desktop Office | **Technically possible on eligible x86/server licensing; manually managed and not the current Yaver workspace path** |
| Azure personal Windows desktop / Windows 365 | **Recommended rented-Windows option, subject to tenant, Windows, Office, and AVD licensing** |
| Use tenant administrator credentials on the Windows host | **NO-GO; use the friend's own least-privilege Entra user and interactive MFA** |
| GitHub/GitLab from the workspace | **AMBER-to-GO; first-class device-flow code exists but needs a live registered-client proof** |
| Vercel/Cloudflare/Supabase/Firebase “seamlessly” | **AMBER/RED; detection and commands exist, but install/auth/link/verify parity does not** |
| Keep the common cloud CLI layer under 10 GiB | **Feasible as a measured CLI-only pack; exclude local emulators/images and enforce a budget** |
| Vibe from phone/web/tablet | **Intended and substantially implemented; needs a release-grade closed loop** |
| See/control from tvOS or Android TV | **Implemented in distinct TV clients/shells, but not release-proven at this commit** |
| Use watch or car as a full visual IDE | **NO; correctly thin voice/status companions** |
| Use Quest/Vision Pro/WebXR to see a remote browser | **Implemented as a conditional JPEG/WebRTC spatial lane; not equivalent to PowerPoint-host validation** |

## 1. The beta being proposed

The desired experience is:

1. The friend signs up with his own identity.
2. He has a persistent Linux workspace in Yaver Cloud.
3. He connects his own source repository and Microsoft developer/tenant access.
4. Yaver detects GanttSnap's required cloud tools, shows their download/disk impact, installs the approved pinned set, and proves each real binary.
5. He authenticates GitHub/GitLab, the cloud providers GanttSnap actually uses, OpenCode, and DeepSeek with credentials that belong to him.
6. A separate existing or rented Windows host runs real PowerPoint when native Office proof is needed.
7. He starts tasks from a phone, web dashboard, tablet, TV, watch, car, or headset.
8. He sees the app or its host, gives follow-up instructions, and keeps the coding loop alive while the Linux box auto-parks when idle.
9. The owner's credentials, repos, prompts, model bills, and machines remain completely outside the friend's trust boundary.

That is a good beta scenario because it stresses Yaver's real thesis: a user-owned coding account, a remotely managed compute box, and many control surfaces. It is also unusually good at exposing false greens:

- “OpenCode installed” versus “the chosen DeepSeek model can complete a real prompt.”
- “dev server running” versus “PowerPoint loaded the task pane and Office.js calls work.”
- “WebRTC session created” versus “the first useful frame arrived.”
- “watch/TV app exists” versus “the surface can perform the intended part of the loop.”
- “workspace saved” versus “repo, auth, and task state survived park/wake.”

## 2. Recommended trust and ownership topology

```text
Friend's identity
    |
    +-- Friend's Yaver account and session tokens
    |
    +-- Friend-owned Cloud Workspace subscription
    |       |
    |       +-- dedicated Linux VM
    |       +-- persistent state volume
    |       +-- GanttSnap repo checkout
    |       +-- friend's Git/Microsoft/OpenCode/DeepSeek credentials
    |       +-- Yaver agent owned by friend's Yaver user id
    |
    +-- Friend's clients
            +-- web dashboard
            +-- iOS/Android phone and tablet
            +-- TV client
            +-- watch/car thin companions
            +-- WebXR/spatial browser

Owner's Yaver account, machines, tokens, vault, and repos
    `-- no trust edge to the friend's workspace
```

### Why a separate account is load-bearing

The code treats a Cloud Workspace as a single-user resource:

- `backend/convex/schema.ts:1616-1620` defines the cloud row with `userId`; `teamId` is explicitly a legacy tombstone that never grants access.
- `backend/convex/cloudMachines.ts:997-1004` lists machines by the owner's `userId` index.
- `backend/convex/http.ts:6677-6678`, `6791-6792`, `7279`, `7388-7389`, and `7450-7451` reject machine operations when the authenticated user is not the row owner.
- `backend/convex/cloudMachines.ts:2060-2105` gives normal plans one managed machine and exempts only the explicit operator/owner allowlist.
- `backend/convex/cloudMachines.ts:295-301` calls the current container bootstrap “single-user safe” and says a shared-kernel container is not an isolation boundary for untrusted tenants.

The pricing implementation says the same thing in product language: Cloud Workspace is `$29/mo`, one saved workspace, 120 standard active hours, private relay, auto-stop, and the user's own Claude/Codex/OpenCode account (`web/app/pricing/page.tsx:38-68`, `75-91`).

### What “space in Yaver Cloud Workspace” should mean

For this beta it should mean **a dedicated workspace attached to the friend's account**, even if the owner chooses to reimburse or sponsor the cost out of band. It should not mean:

- a child directory in the owner's persistent volume;
- a shared Yaver bearer token;
- a copied `~/.config/opencode` or Codex/Claude login;
- a team row pointing at the owner's machine;
- a guest invitation into the owner's repo;
- a second user inside the same plain Docker tenant.

There is no audited “gift a plan” or sponsor-seat product in the current flow. If owner-funded beta access is a product requirement, it needs an explicit entitlement/grant object whose beneficiary remains the friend, rather than account impersonation.

## 3. Sharing and multi-user paths are not a safe shortcut

The repository contains substantial historical guest, host-share, project-share, team, and multi-user code. Its presence must not be mistaken for a shippable path.

### Control-plane gates are off

- `backend/convex/launchFlags.ts:33` sets `ENABLE_GUEST_FEATURES = false`.
- `backend/convex/launchFlags.ts:42` sets `ENABLE_TEAM_FEATURES = false` because known authorization defects exposed member email and under-checked member administration.
- Guest, project-share, and host-share creation/acceptance mutations call `requireGuestFeatures()`.
- `backend/convex/schema.ts:1951` labels guest invitation/access tables as legacy removed account-sharing tombstones.
- `backend/convex/schema.ts:1619` says `cloudMachines.teamId` never grants access.

### The agent still rejects non-owner users

The normal agent middleware caches the validated user id and rejects it when it differs from `ownerUserID` (`desktop/agent/httpserver.go:2174-2221` and the parallel SDK path). This is the correct default for the dedicated machine model.

### Host-share code and tests have drifted apart

`desktop/agent/host_share_auth_test.go` constructs `cachedTokenInfo.hostShare`, `HostShareAccessInfo`, and `storedAt`. The production `cachedTokenInfo` at `desktop/agent/httpserver.go:1738-1747` has none of those fields, and no production `HostShareAccessInfo` definition was found. The normal middleware has no corresponding allow-host-share branch. This is not a hidden beta feature; it is compile-breaking evidence that the host-share contract is not integrated into the current production slice.

### Multi-user code is not wired or sufficient

`desktop/agent/multiuser.go` and `multiuser_http.go` contain an older per-user workspace concept, but no construction/wiring of `NewMultiUserManager` was found in `main.go` or `httpserver.go`. Even in isolation:

- `IsTeamMember` does not query team membership; it checks whether a local session already exists.
- `multiUserAuth` accepts any valid Convex user token and creates a session without calling `IsTeamMember`.
- A dev-manager allocation failure falls back to the shared singleton, which is not an acceptable fail-closed boundary for mutually untrusted users.

The friend beta must not be the experiment that silently re-enables this path.

## 4. Cloud Workspace readiness for this beta

### What is strong in the current design

The current BYOK bootstrap has the right building blocks:

- one `cloudMachines` row owned by one user;
- a persistent volume mounted at `/srv/yaver/state`;
- a persistent source workspace under `/srv/yaver/state/Workspace`;
- persisted Yaver, Git, Claude, Codex, and OpenCode home state;
- Node, Python, Go, Rust, Docker, Expo/EAS, Claude Code, Codex, and OpenCode in the advertised tool inventory;
- authenticated relay/private hostname machinery;
- mandatory auto-park and volume-backed wake;
- a server-side entitlement check before provider spend;
- a one-machine control-plane quota for normal accounts.

Relevant code is in `backend/convex/cloudMachines.ts:295-617`, `997-1124`, `2060-2270`, `2389-2520`, and `3180-3199`.

### Provisioning facts that need closed-loop proof

The beta cannot rely on the row or bootstrap text alone. It must prove:

1. The friend can complete checkout or receive an explicit beta entitlement under his own account.
2. Provisioning produces a usable `/health` and `/info`, not merely a Hetzner server id.
3. The machine registers under the friend's user id and never appears for the owner or a third test account.
4. Private repo authentication works after the friend signs into his Git provider.
5. GanttSnap's dependency install and dev command work on the actual Linux image.
6. OpenCode runs a real provider completion.
7. Park/wake preserves the repo, OpenCode auth/config, Git auth, Microsoft browser state where promised, and task/project selection.
8. Revoking the friend's session or subscription removes control access without deleting project data before the documented grace policy.

### Repository onboarding caveat

The bootstrap always clones the public Yaver repository and can best-effort clone an optional `repoUrl` (`backend/convex/cloudMachines.ts:308-324`). A private GanttSnap repository will not clone before the friend has authenticated Git unless the onboarding flow explicitly sequences credential setup first. The beta should not accept “starter clone skipped” and then leave the phone on an empty workspace.

The GanttSnap source is not present in this repository, so this audit could not verify its manifest, package scripts, Microsoft 365 tenant requirements, HTTPS dev certificates, Office.js API set, or automated tests. Those are beta-entry probes, not assumptions.

## 5. OpenCode and DeepSeek from the friend's own account

### OpenCode

OpenCode is a legitimate first-class runner in the machine inventory and bootstrap. The cloud config also registers the local Yaver MCP server. This makes the basic runner topology viable.

The managed default is not DeepSeek, however. `backend/convex/cloudMachines.ts:263-284` writes:

- provider: `zai-coding-plan`
- model: `zai-coding-plan/glm-4.7`
- `enabled_providers: ["zai-coding-plan"]`

Meanwhile the mobile runner picker and agent catalog currently label `deepseek-v4-flash` as the OpenCode default (`mobile/src/context/DeviceContext.tsx:226-233`; `desktop/agent/httpserver.go:3271-3278`). That is a cross-layer default mismatch. A fresh cloud box can boot with one model while the controller believes another is the default.

### DeepSeek

There is meaningful DeepSeek support in the code:

- `opencodeProviderEnvKey` maps provider `deepseek` to `DEEPSEEK_API_KEY` (`desktop/agent/runner_auth_cmd.go:557-558`).
- Runner status tests know the same mapping.
- The agent model catalog exposes `deepseek-v4-flash`.
- The vision adapter explicitly handles text-only DeepSeek models.

But the usable credential path is incomplete:

- `runnerAuthSetRequest` and `runnerAuthSetupRequest` accept OpenAI, Anthropic, GLM, and ZAI keys only (`desktop/agent/runner_auth_http.go:12-19`; `desktop/agent/runner_auth_setup.go:17-27`).
- `buildRunnerAuthEntries` cannot produce a `DEEPSEEK_API_KEY` vault entry (`desktop/agent/runner_auth_cmd.go:101-139`).
- The CLI flags and MCP setup mirror that omission.
- The managed OpenCode `enabled_providers` list initially hides DeepSeek.
- The local encrypted vault is launch-disabled by default (`desktop/agent/feature_flags.go:16-73`), yet runner-auth tells the user it saves provider keys there.

Therefore “use DeepSeek from his account” is not a one-tap supported promise. Manual `opencode auth login`, manual OpenCode config/auth files, or a service environment variable may make it work, but that would be machine repair rather than a proven Yaver product path.

### Required provider contract before beta

The friend-facing path should be one of these, stated explicitly:

1. **OpenCode-native auth:** launch `opencode auth login` for DeepSeek, persist OpenCode's own credential store on the workspace volume, and live-probe the selected model.
2. **Yaver-managed local secret:** accept `DEEPSEEK_API_KEY` through the same owner-authenticated, non-logging setup channel as other providers, make its storage available on managed boxes, write the OpenCode provider config, and probe the real API.

Either way, success means a dated real completion using the exact model id the task runner will invoke. A key-shaped file or provider catalog row is not success. The key must never enter Convex task data, logs, the repo, or the owner's devices.

## 6. What Linux can and cannot do for a PowerPoint add-in

GanttSnap was not found in this checkout, so the Office-specific analysis applies to a normal Office.js PowerPoint add-in.

Microsoft's current model is a manifest/package plus a web application hosted on a web server. Office on the web can sideload PowerPoint add-ins for testing, and HTTPS is required in important deployment scenarios. See Microsoft's official documentation:

- [Office Add-ins platform overview](https://learn.microsoft.com/en-us/office/dev/add-ins/overview/office-add-ins)
- [Requirements for running Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/requirements-for-running-office-add-ins)
- [Sideload Office Add-ins for testing](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing)

### Linux is suitable for

- cloning the add-in source;
- installing Node dependencies;
- linting, unit testing, bundling, and serving the task-pane/commands web app;
- validating the manifest as data;
- exercising standalone React/HTML UI;
- opening Microsoft 365 and PowerPoint on the web in a supported browser;
- running browser automation against the actual PowerPoint-on-the-web host, if authentication and sideloading are designed into the harness.

### Linux is not suitable for

- running native PowerPoint for Windows or macOS locally;
- proving Windows WebView2-only behavior;
- proving macOS WKWebView-only behavior;
- testing native desktop Office version/API-set differences;
- claiming desktop PowerPoint compatibility from a standalone localhost page.

If GanttSnap must support desktop PowerPoint, the complete matrix needs at least one real Windows Office host and, if claimed, one real macOS Office host. Those may be separate Yaver-connected machines; the Linux workspace remains the coding/build box.

## 7. The current browser preview is not an Office host

Yaver's browser-window runtime is a useful standalone web preview:

- it starts a headless Chromium tab through CDP;
- it points the tab at the project's active local dev-server URL;
- it accepts pointer and keyboard events;
- it screenshots at about 1.4 frames per second;
- it sends JPEGs over a WebRTC data channel because browser-window H.264 encoding is explicitly not implemented.

Evidence: `desktop/agent/remote_runtime_browser.go:1-28`, `705-716`; `desktop/agent/remote_runtime.go:1174-1260`.

It is not currently a PowerPoint-on-the-web harness:

- navigation is automatically resolved to `http://127.0.0.1:<dev-port>`;
- the browser begins at `about:blank` and has no project-independent Office host launch contract;
- each session creates a private temporary home/profile under `/tmp/yaver-browser-window-*` and removes it when the session closes (`desktop/agent/remote_runtime_browser.go:249-299`);
- a Microsoft 365 login and sideload stored in that browser profile will therefore not be durable by default;
- a standalone task pane can render while every `Office.*` call fails because no Office host supplied the Office.js context.

For GanttSnap, the product needs to distinguish two preview types:

| Preview type | What it proves | Current status |
|---|---|---|
| Standalone web preview | UI layout, CSS, generic browser interaction | Supported by direct URL or browser-window capture |
| PowerPoint web-host preview | Manifest sideload, task pane load, Office initialization, presentation read/write | Not a first-class Yaver runtime target |
| Native PowerPoint Windows | WebView2 and desktop Office behavior | Requires a Windows host |
| Native PowerPoint macOS | WKWebView and macOS Office behavior | Requires a Mac host |

A future `powerpoint-web` runtime target should own a persistent, friend-scoped browser profile; open an approved Microsoft 365 origin; make document and sideload selection explicit; wait for `Office.onReady`; run one harmless host capability probe; and report a structured failure if auth, sideload, third-party cookies, HTTPS, or API-set support blocks it. It must not upload the friend's Microsoft cookies to Convex.

## 8. Transport truth: direct URL, WebRTC, and relay are different products

“See it over WebRTC or whatever” should be translated into an explicit ladder.

### Preferred for a web add-in: direct authenticated preview URL

For a normal web project, the highest-quality preview is the browser loading the dev server directly through Yaver's authenticated transport. It preserves DOM text, browser accessibility, normal input, and native frame rate. Streaming screenshots should be the fallback, not the default, when the client browser can reach a web origin.

For PowerPoint-host behavior, the direct URL is only the add-in asset origin; the visible host must still be PowerPoint on the web.

### Direct WebRTC

The web, mobile, TV, and spatial implementations can negotiate WebRTC. For browser-window capture today, the payload is JPEG over a data channel at roughly 1.4 fps, not H.264 video (`remote_runtime_browser.go:1-16`). For simulator/emulator targets, H.264 may be available when the target encoder supports it.

WebRTC is conditional on real media reachability. The web viewer fetches STUN/TURN configuration and, after about eight seconds without a connection, starts authenticated HTTP JPEG polling while negotiation continues (`web/components/dashboard/RemoteRuntimeViewer.tsx:290-380`).

### Relay

The relay path is not WebRTC. Mobile says this directly and requests `relay-jpeg-poll`: still JPEG frames around once per second (`mobile/app/remote-runtime.tsx:132-145`, `648-715`). The web and tvOS viewers have equivalent HTTP/frame fallbacks.

The beta promise should therefore read:

> Full-fidelity direct web preview when possible; direct WebRTC for remotely captured runtimes; authenticated JPEG polling when media cannot connect. The UI always names the active transport.

It should not read “WebRTC anywhere.”

## 8A. The three remote-machine cases

These are not interchangeable hosting SKUs. They produce different Office, licensing, session, transport, and maintenance contracts.

### Case 1 — the friend's existing dedicated Windows box

This is the best first native-PowerPoint host if the friend already has a properly licensed Windows machine and Microsoft 365 Apps. The safe topology is:

```text
Friend's Yaver clients
        |
        +-- owner-authenticated Yaver agent API
        +-- WebRTC signaling + short-lived TURN credentials when needed
        `-- named JPEG fallback when WebRTC cannot connect
                         |
                 Windows interactive user session
                         |
                 PowerPoint + GanttSnap add-in
```

The source contains a real Windows path, not merely a generic SSH story:

- The Windows installer fetches the Windows amd64 agent release (`web/public/install.ps1:1-20`).
- Agent autostart is a limited `ONLOGON` scheduled task named `YaverAgent` (`desktop/agent/process_windows.go:61-84`). This is the right session class for interactive desktop capture; it is not a Session 0 Windows service.
- `desktop-screen` is a first-class remote-runtime target. It uses ffmpeg `gdigrab` on Windows and sends H.264 RTP over WebRTC (`desktop/agent/remote_runtime_desktop.go:1-31`, `278-287`, `343`, `471-477`).
- Windows screen capture and input use GDI and `SendInput`; phase 1 captures only the primary display (`desktop/agent/ghost/screen_windows.go:1-74`; `ghost/input_windows.go:1-25`).
- Native Windows also has a real ConPTY terminal (`desktop/agent/windows_seat.go:1-25`).
- The older `/rd/*` path is separate: MJPEG or polled JPEG, with owner-view enabled by default and remote control opt-in (`desktop/agent/remotedesktop.go:1-20`; `remotedesktop_http.go:1-12`; `mobile/app/remote-desktop.tsx:1-10`).

The operational constraint is decisive: PowerPoint, GDI capture, and `SendInput` need a logged-in, unlocked interactive desktop. Logging off ends the host. Locking the session can make capture/input unavailable or meaningless. Disconnect behavior must be proven on the exact RDP/Windows App/console configuration; a process id or scheduled-task state is not proof.

The current Windows implementation also has material gaps:

- `yaver install <tool>` explicitly supports only macOS and Linux (`desktop/agent/install_cmd.go:1-18`). A missing Node, Git, ffmpeg, Vercel, Firebase, or other tool on Windows therefore cannot yet meet Yaver's seamless-install promise even though runner-specific Node setup has some Windows handling.
- Durable managed child units are unsupported (`desktop/agent/managed_units_windows.go:1-12`).
- Detached autorun falls back to foreground execution (`desktop/agent/runner_detach_windows.go:1-29`).
- The Windows capture/control code has not been live-probed in this audit, and the current Go source does not build at all.

**Recommendation:** use the Windows box as the native Office host, not necessarily as the only coding box. Run the Yaver agent inside the friend's normal Windows login; keep PowerPoint and the disposable test presentation open there; optionally use WSL2 for Linux build tools. Never store the friend's Windows or Microsoft password in Yaver.

### Why “WebRTC only through Relay Pro” is not the current truth

There are three relevant paths:

1. `desktop-screen` H.264 over WebRTC — the desired native Windows lane.
2. `/rd/stream` or `/rd/frame.jpg` — authenticated MJPEG/JPEG remote desktop, not WebRTC.
3. A relay-selected mobile runtime — explicitly `relay-jpeg-poll`, around one still frame per second, not WebRTC (`mobile/app/remote-runtime.tsx:132-145`).

WebRTC can use Yaver-managed TURN credentials. The agent asks an authenticated relay `/ice` broker for short-lived credentials (`desktop/agent/turn_credentials.go:58-82`, `133-229`). But the relay's TURN listener is disabled by default unless a real public IP, port, and auth secret are configured (`relay/main.go:118-125`, `229-267`). The tracked production-style unit is not evidence that a particular Relay Pro deployment currently exposes working TURN. The operation must be probed from the friend's real networks.

Therefore Relay Pro is an entitlement/rendezvous/transport product, not a magic guarantee that every relay path is WebRTC. The beta contract should be **WebRTC preferred, TURN-assisted when direct ICE fails, named authenticated JPEG fallback**. Making WebRTC the only allowed display path would turn a recoverable hotel/mobile/carrier-network restriction into total loss of access.

### Case 2 — Hetzner

There are two different Hetzner proposals:

#### Hetzner Linux Cloud Workspace

This is the current Yaver-managed shape and remains the best coding/build box. It can run the repo, agents, web preview, tests, browsers, and cloud CLIs. It cannot run native Windows PowerPoint. Use PowerPoint on the web for an Office-host web test, or pair the Linux workspace with a separate Windows host.

The managed container/image path is Linux-specific: it installs Docker, mounts `/srv/yaver/state`, and runs the Linux `yaver-cloud` image (`backend/convex/cloudMachines.ts:292-327`, `405-438`, `498-533`). The Azure provider in this checkout is Linux-specific too: its VM `linuxConfiguration`, attached `osType: "Linux"`, and default Canonical Ubuntu image are hard-coded (`backend/convex/cloudProviders/azure.ts:204-229`, `278-286`, `624-633`). “Select Windows” is not a currently supported Yaver provisioning option on either provider.

#### Hetzner Windows Server

Hetzner documents manual Windows Server installation on x86 Cloud servers using the customer's eligible license, while Arm CAX is not eligible. Hetzner also states that Windows 10 and Windows 11 are prohibited on its server hardware because it is not a Qualified Multitenant Hoster. Dedicated servers can use Hetzner Windows Server add-ons and RDP/RDS licensing, but that is a separately managed product and licensing path:

- [Windows on Hetzner Cloud](https://docs.hetzner.com/cloud/servers/windows-on-cloud/)
- [Hetzner Cloud server FAQ — Windows licensing restrictions](https://docs.hetzner.com/cloud/servers/faq/)
- [Windows Server 2025 on dedicated servers](https://docs.hetzner.com/robot/dedicated-server/windows-server/windows-server-2025/)

Microsoft supports Microsoft 365 Apps on supported Windows Server Desktop Experience configurations, but Remote Desktop Services requires the appropriate user licensing and Shared Computer Activation where the machine is shared. Each human uses their own licensed account:

- [Microsoft 365 Apps on Remote Desktop Services](https://learn.microsoft.com/en-us/microsoft-365-apps/deploy/deploy-microsoft-365-apps-remote-desktop-services)
- [Shared Computer Activation overview](https://learn.microsoft.com/en-us/microsoft-365-apps/licensing-activation/overview-shared-computer-activation)
- [Windows Server application compatibility](https://learn.microsoft.com/en-us/windows-server/get-started/application-compatibility)

**Verdict:** a manually built Hetzner Windows Server host may work, but it is not the seamless Yaver Cloud Workspace and is a poorer first choice than a supported Azure personal desktop for client Office. Hetzner Windows 10/11 is a no-go. The better Hetzner architecture is Linux coding workspace plus an existing or Azure Windows Office host.

### Case 3 — rented Windows on Azure

For one friend, the cleanest rented-Windows shape is a **personal desktop**: one persistent Windows 11 Enterprise VM assigned one-to-one through Azure Virtual Desktop, or a Windows 365 Cloud PC. A personal AVD desktop preserves the user's profile and is explicitly designed for one-to-one assignment; Windows 365 packages the Cloud PC lifecycle further:

- [Azure Virtual Desktop personal desktop assignment](https://learn.microsoft.com/en-us/azure/virtual-desktop/configure-host-pool-personal-desktop-assignment-type)
- [Azure Virtual Desktop prerequisites](https://learn.microsoft.com/en-us/azure/virtual-desktop/prerequisites)
- [Azure Virtual Desktop licensing](https://learn.microsoft.com/en-sg/azure/virtual-desktop/licensing)
- [Windows 11 on Azure eligibility](https://learn.microsoft.com/en-us/azure/virtual-machines/windows/windows-desktop-multitenant-hosting-deployment)
- [Windows 365 Enterprise requirements](https://learn.microsoft.com/en-ca/windows-365/enterprise/requirements)
- [Windows 365 end-user access](https://learn.microsoft.com/en-us/windows-365/end-user-access-cloud-pc)

The phrase “use the tenant's creds” must mean **the friend's own Entra user exists in the tenant and has the necessary Windows/AVD and Microsoft 365 Apps entitlements**. It must not mean giving Yaver a Global Administrator password, a shared Office login, or a service-account password. AVD does not by itself include Office licensing. Microsoft 365 Apps activation remains a separate entitlement, and Shared Computer Activation applies if the host is actually shared.

The correct flow is:

1. A tenant administrator assigns the friend only the required Entra group, AVD/Cloud PC access, and Microsoft 365 Apps license.
2. The friend signs into Windows and Office interactively with MFA/Conditional Access.
3. Those refresh tokens stay inside his Windows profile.
4. The Yaver agent installs and registers under the same interactive user.
5. Yaver stores only its own device/session credentials and never receives the Microsoft password or tenant-admin credential.
6. PowerPoint is launched in that interactive session, the add-in is sideloaded, and a disposable presentation is used for automation.

**Recommendation:** choose AVD personal desktop or Windows 365 over a raw shared Windows Server VM when the goal is testing a PowerPoint client add-in. Treat current Yaver Azure provisioning as unrelated—it creates Ubuntu runners today. The Windows desktop must initially be provisioned through Azure/Microsoft administration and then attached to Yaver as a friend-owned machine.

### Comparative decision table

| Property | Existing Windows box | Hetzner Linux | Hetzner Windows Server | Azure personal Windows / Windows 365 |
|---|---|---|---|---|
| Native desktop PowerPoint | Yes | No | Possible with eligible server/Office config | Yes; best rented fit |
| Current Yaver managed provisioning | Attach existing agent | Yes | No | No; current Azure provider is Linux |
| Best coding environment | Windows + optional WSL2 | Yes | Possible, more maintenance | Yes, but costlier than Linux |
| H.264 desktop WebRTC path in source | Yes | Only if a graphical desktop exists | Yes in principle | Yes in principle |
| Interactive unlocked session needed | Yes | Not for ordinary headless web builds | Yes | Yes |
| Seamless Yaver dependency install today | No, general installer excludes Windows | Partial on Linux | No | No |
| Main policy/licensing risk | Office/device entitlement | No native Office | Hetzner + Windows Server + RDS/SCA | Tenant/AVD/Office entitlements |
| Recommended role | Native Office test host | Primary coding/build box | Avoid for first beta | Best rented Office test host |

## 8B. GitHub, GitLab, Vercel, Cloudflare, Supabase, and Firebase audit

### Detection is not readiness

Yaver already recognizes more of this stack than the cloud image ships:

- Stack detection advertises Supabase, Firebase, Vercel, and Cloudflare deploy targets (`desktop/agent/stack_detect.go:212-264`).
- `ops deploy` resolves Cloudflare, Vercel, Firebase, Convex, and Supabase commands (`desktop/agent/ops_deploy.go:247-302`).
- MCP handlers exist for Vercel, Firebase, and Supabase operations (`desktop/agent/httpserver.go:10295-10313`, `10475-10490`, `10701-10740`).
- The install catalogue supports Git, `gh`, `glab`, Vercel, Wrangler, Convex, and an `npx`-backed Supabase wrapper (`desktop/agent/install_cmd.go:56-180`, `1206-1320`).

But these producers do not form one closed loop:

- The cloud Dockerfile requires `gh` and `glab`, and attempts to install Wrangler, Claude, Codex, and OpenCode. Both npm install layers end in `|| true`, so a successfully built image does not prove those commands exist. It does **not** attempt Vercel, Supabase, or Firebase (`desktop/agent/Dockerfile.yaver-cloud:67-119`).
- Firebase is detected and its deploy command is emitted, yet it has no `yaver install firebase` plan and is absent from `AccountProviders`. The UI can therefore offer a deploy whose binary and auth have no first-class route.
- `ops deploy installDeps:true` only auto-installs native Android/JDK prerequisites; it does not install the selected cloud provider CLI (`desktop/agent/ops_deploy.go:92-100`; `build_preflight.go:229-305`).
- The Vercel/Supabase wrappers use unpinned `npx -y <package>` (`desktop/agent/install_cmd.go:1660-1735`). That is small and convenient, but it downloads at first use, is not reproducible, and bypasses the project's lockfile. Supabase's current security guidance explicitly recommends pinning or a project dev dependency instead of ad-hoc latest fetches.
- General Windows installation remains unsupported, so the same detected repo behaves differently on a Windows Office host.

### Current secret-storage caveat

The generic account manager encrypts provider fields with AES-GCM and returns only redacted connection summaries (`desktop/agent/accounts.go:89-107`, `153-195`, `256-279`). That is useful protection against accidental plaintext reads. Its randomly generated master key is stored at `~/.yaver/master.key` beside `~/.yaver/secrets/*.enc` (`accounts.go:116-150`, `198-224`). On a managed workspace, `/root` is the persistent volume. Anyone who obtains that volume or root access can obtain both the ciphertext and its decryption key.

Therefore the current envelope is **authenticated local encryption whose key shares the same trust boundary**, not a hardware-backed or separate-key-domain vault. It protects against an accidental ciphertext-file disclosure but not an offline copy of the whole volume or root compromise. Before an external beta, verify the provider's volume/snapshot encryption guarantees, restrict root/operator access, protect or disable credential-bearing snapshots/backups, and prove fast provider revocation. If the storage layer does not provide the intended protection, use a separate key domain or explicitly accept that beta risk. It does not make a shared host safe. The Yaver vault being launch-disabled while some auth flows claim to persist there is an additional contract gap.

OAuth integrations should prefer each CLI's OS credential store when available, but headless Linux often lacks a keyring and falls back to files. Yaver must report the actual storage backend (`keyring`, `encrypted_local`, `plaintext_cli_fallback`, or `environment_only`) without returning the secret, and should warn/block when a provider would fall back to plaintext on an insufficiently protected host.

### GitHub and GitLab

Git is the strongest integration in this set. Yaver implements owner-authenticated GitHub and GitLab OAuth Device Authorization flows, returns a user code and verification URL, polls on the target box, verifies the resulting identity, and persists the token locally without sending it through Convex (`desktop/agent/git_oauth_device.go:140-224`, `250-405`; `ops_git.go:42-144`). Web and mobile have consumers for that flow.

The remaining gate is deployability of the OAuth client itself. A fresh agent needs a registered GitHub/GitLab OAuth client id from local vault or environment; there is no trustworthy universal compiled default. GitHub officially supports Device Flow for headless apps, and GitLab `glab auth login --device` supports headless authorization on GitLab 17.9+:

- [GitHub OAuth Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GitLab CLI device authorization](https://docs.gitlab.com/cli/auth/login/)

For the friend beta, register and scope Yaver's OAuth apps, test GitHub and GitLab independently, show the requested scopes before opening the browser, and verify clone/fetch/push on the exact private GanttSnap repo. Repository-provider auth does not automatically authorize Vercel to import or deploy an organization repository; provider/team membership remains a second permission boundary.

### Vercel

Yaver currently treats Vercel primarily as a manually pasted token (`desktop/agent/accounts.go:68`) and exposes project-vault token fields in web UI (`web/components/dashboard/VibeCodingView.tsx:3644-3653`). That works for CI-style use but is not the seamless OAuth flow requested.

Vercel changed its CLI login in 2025: current `vercel login` uses OAuth 2 Device Flow, and provider flags such as `--github` and `--gitlab` were removed in February 2026. A current implementation must launch plain `vercel login`, capture its code/URL, let the friend approve on any Yaver client, poll completion on the workspace, then verify with a harmless identity/team/project query:

- [Vercel's current CLI device-flow announcement](https://vercel.com/changelog/new-vercel-cli-login-flow)
- [Vercel CLI](https://vercel.com/docs/cli)
- [Vercel login](https://vercel.com/docs/cli/login)
- [Vercel Git deployments](https://vercel.com/docs/git)

After login, project linkage is a separate explicit operation: select scope/team, run `vercel link`, persist `.vercel/project.json` only if appropriate for that repo, and verify a preview deployment. Production deploy, domain change, environment-secret mutation, and rollback remain confirmation-gated actions. A Vercel token must not be inserted into task prompts or passed in a URL.

### Cloudflare

The image already ships Wrangler, but Yaver only models Cloudflare as pasted API token + account id (`desktop/agent/accounts.go:69`). Wrangler's browser login can hang inside a remote container because the callback listener is not reachable from the user's local browser. `CLOUDFLARE_API_TOKEN` is a valid headless route, but should be a narrowly scoped project token.

As of June 2026, Cloudflare supports third-party OAuth clients using Authorization Code + PKCE for browser/mobile/desktop/CLI public clients; it explicitly does **not** support Device Authorization Grant. A Yaver-native flow therefore needs a public HTTPS callback owned by Yaver (or a deep-linked PKCE callback where supported), state/nonce/PKCE binding, and a secure token handoff to the target box. It cannot copy the Git/Vercel device-code UI mechanically:

- [Cloudflare OAuth client and supported flows](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- [Wrangler authentication behavior](https://developers.cloudflare.com/workers/wrangler/commands/general/)

The minimum beta can use a least-privilege API token stored locally on the friend's box. The target state should be Cloudflare OAuth + PKCE for humans, API tokens only for explicit CI/service use, and a live `wrangler whoami`/read-only account probe before deploy controls turn green.

### Supabase

Supabase's official CLI login is personal-access-token based. It supports `--no-browser`, `--token`, and `SUPABASE_ACCESS_TOKEN`; if native credential storage is unavailable it may write the token to `~/.supabase/access-token`. This is not a missing OAuth browser flow Yaver should invent:

- [Supabase CLI login](https://supabase.com/docs/reference/cli/getting-started)
- [Supabase CLI install modes](https://supabase.com/docs/guides/local-development/cli/getting-started)

Yaver should accept the token through a secret-input surface, never echo it, store it in the target's protected credential store, run a read-only projects probe, then explicitly link the selected project. Database passwords and service-role keys are separate secrets and should be requested only when a specific operation needs them. The cloud CLI pack should prefer a project-pinned Supabase dev dependency or an integrity-verified pinned binary; it should not silently fetch `latest` through `npx` on every clean box.

The local Supabase stack is a different, large capability: it pulls multiple Docker images and runs Postgres/services. It must be opt-in and outside the 10 GiB base-tool promise.

### Firebase / Google Cloud

Firebase is the clearest false green. The project detector, doctor, deploy resolver, MCP commands, and emulator UI know Firebase, but the Yaver installer and account registry do not. The product can say “Firebase deploy” while leaving the user at `firebase: command not found` with no valid install button.

Firebase officially supports `npm install -g firebase-tools`; remote interactive login uses `firebase login --no-localhost`. For CI/headless automation, Google now recommends Application Default Credentials; the old `FIREBASE_TOKEN`/`login:ci` route is legacy and less secure:

- [Firebase CLI install, remote login, and CI authentication](https://firebase.google.com/docs/cli)

For a personal interactive workspace, Yaver should drive `firebase login --no-localhost`, surface the URL/code on every capable client, and verify `firebase projects:list`. For unattended deployment, prefer workload identity or narrowly scoped Application Default Credentials—not the friend's long-lived browser refresh token. Firebase Emulator Suite downloads, Java, and emulator data are opt-in project capabilities outside the base pack.

## 8C. A measured cloud-developer pack under 10 GiB

The 10 GiB promise should cover **Yaver-managed developer tooling added to the workspace**, not the user's repository, `node_modules`, Docker images, build outputs, browser profiles, or database data. Those categories must still be measured separately so they cannot quietly consume the disk.

### Proposed base pack

| Layer | Included | Budget ceiling | Notes |
|---|---|---:|---|
| Core runtime | Node LTS, npm/corepack, Git, curl, CA roots, `jq`, `rg`, archive tools | 1.25 GiB | Node already exists in image; include one version, not nvm duplicates |
| Coding agents | Claude Code, Codex, OpenCode | 1.50 GiB | Credentials excluded from image; versions recorded |
| Source providers | `gh`, `glab`, Git credential helper | 0.40 GiB | OAuth state/token data is tiny and friend-scoped |
| Cloud CLIs | Vercel, Wrangler, Supabase, Firebase, Convex | 1.50 GiB | Pinned versions; wrappers may invoke project-local versions |
| Web proof | one headless Chromium + fonts + ffmpeg | 2.25 GiB | Reuse one browser; do not also install Playwright browsers by default |
| Languages/helpers | minimal Python + venv, minimal Go/Rust only if baseline policy keeps them | 1.50 GiB | Prefer on-demand project profiles when unnecessary |
| Reserved update/cache headroom | npm metadata, CLI updates, temporary extraction | 1.00 GiB | Clean temp files after verified install |
| **Hard ceiling** | | **9.40 GiB** | Leaves 0.60 GiB enforcement margin |

These are design ceilings, not measured facts about the current image. The Dockerfile currently claims “every tool” but neither records the final compressed/uncompressed image size nor gates it. A release pipeline must build the exact image, run `du` by owned path, record tool versions and layer size, and fail if the owned footprint exceeds the ceiling.

### Explicitly excluded from the base 10 GiB

- Android SDK, emulator system images, Gradle caches, and AVD data;
- Flutter SDK and precache;
- Xcode/iOS simulators, which are impossible on Linux/Windows anyway;
- Supabase local Docker images and database volumes;
- Firebase emulators and downloaded Java artifacts;
- Playwright's Chromium/Firefox/WebKit set when system Chromium is available;
- local LLM weights;
- repository dependencies, build caches, artifacts, browser profiles, and user data.

### Optional lightweight profiles

“Most common” should remain a curated, versioned catalogue rather than an ever-growing base image:

| Profile | Candidate tools | Default |
|---|---|---|
| Web deploy | Vercel, Wrangler, Firebase, Netlify, Convex | Install only the providers detected in the repo; Vercel/Wrangler may be base-cache candidates |
| Database/backend | Supabase CLI, `psql`, Turso, Neon helpers | CLI/client only; no local service images by default |
| Git/CI | Git, `gh`, `glab` | Base |
| General cloud | AWS CLI, Azure CLI, Google Cloud CLI | On demand; these suites and component caches are larger and not needed for GanttSnap by default |
| Containers | Docker client/Compose | Client in base only if the daemon/socket exists; pulled images never count as base tooling |
| Mobile | EAS/Expo, Android/Flutter profiles | On demand with separate multi-gigabyte budgets |

The detector should read lockfiles, manifests, deployment config, CI workflows, and existing project bindings. It should propose the smallest profile and let the friend add another. It should never install every provider merely because Yaver knows their names.

Each is an on-demand project capability with a size estimate, free-space preflight, explicit user approval, streamed install, post-install operation probe, and removable-cache classification. “Installed” must include the exact binary path, version, architecture, bytes owned, auth state, and a real harmless operation.

### Dependency lifecycle contract

For every detected provider/tool, every Yaver surface should consume one structured state machine:

```text
not_detected
  -> required_by_project
  -> install_available(size, source, version, permission)
  -> installing(bytes, elapsed, current_step)
  -> installed(version, path, owned_bytes)
  -> auth_required(method, scopes, verification_uri/callback)
  -> authorizing
  -> connected(identity, account/team/project)
  -> linked(repo_project_binding)
  -> verified(operation, checked_at)
  -> ready
```

Failures need stable codes such as `tool.unsupported_os`, `tool.disk_budget`, `auth.client_unconfigured`, `auth.expired`, `auth.scope_missing`, `account.team_access_missing`, `project.link_required`, and `probe.failed`, each with an invocable route. Secrets never appear in this state object.

The state lives and executes on the target box. Convex may hold only non-secret progress/identity metadata needed for discovery and handoff. Web, phone, tablet, TV, watch, car, and spatial clients render the same state at different depths:

- web/phone/tablet: full install, URL/code approval, scope review, account/project selection, revoke;
- TV/headset: show the code/QR and poll, but hand secret entry and detailed scope review to phone/web;
- watch/car: announce that authorization is required and hand off; never display or dictate secrets;
- CLI/MCP: return the same structured state and stream, suitable for headless automation.

Production deployment is never implied by successful authentication. Install and read-only verification may be seamless; preview deployment requires an explicit target; production deployment, environment mutation, domain/DNS changes, database migration, rollback, billing, and account revocation remain separately confirmed actions.

## 9. Requested surface-by-surface audit

The same friend account should authenticate every surface. Surface parity does not mean forcing the same UI onto every screen; it means each surface performs the part it can honestly perform and hands off the rest.

| Surface | Code-backed capability | Honest beta role | Status/gap |
|---|---|---|---|
| Web dashboard | Tasks, projects, direct previews, WebRTC/JPEG remote runtime | Primary desktop control and GanttSnap preview | Best primary surface; must pass closed loop |
| iOS/Android phone | Task creation, live console, project/runtime controls, direct WebRTC or relay frames | Primary mobile cockpit | Substantially implemented; current TypeScript baseline is red |
| Tablet | Same RN app with larger device context | Primary mobile cockpit with more useful preview space | Treat as a real tablet context, not a resized desktop page |
| tvOS | Dedicated Swift TV client with LiveKit WebRTC and HTTP fallback (`tvos/YaverTV/Views/RemoteRuntimeWebRTCView.swift`) | Lean-back monitoring/control | Real implementation; needs current build/device proof |
| Android TV | RN TV launcher with D-pad focus, coding, remote desktop, catalog/runtime routes (`mobile/app/tv-home.tsx`) | Lean-back monitoring and short task input | Real shell; current shared mobile build is not type-clean |
| Apple Watch | Voice in, one-line summary/haptic, no code or diffs (`watch/YaverWatch/WatchProtocol.swift`, `WatchStore.swift`) | Start/check a task, then hand off | Correctly not a visual preview |
| Wear OS | Equivalent thin voice/summary terminal | Start/check a task, then hand off | Correctly not a visual preview |
| CarPlay/Android Auto | Voice task dispatch and one-sentence readback; explicitly refuses code/diff reading (`mobile/src/lib/carVoiceCoding.ts`) | Safe task/status control while driving | Never show or promise the GanttSnap UI while driving |
| Quest/Vision Pro browser | WebXR spatial workspace with remote browser quads; browser target sends JPEG over WebRTC on LAN | Large spatial monitor for standalone preview/control | Useful but low-frame-rate for browser-window capture; not Office-host proof |
| Vision Pro native/glass UI | Glass shell/direct web preview and voice surfaces | Companion/spatial preview depending build | Must be tested separately from WebXR |
| HUD glasses/Mentra | Text/voice-oriented companion | Short task/status interactions | Not a full visual IDE |

### Important TV distinction

There are two TV code families:

- a dedicated native tvOS client with explicit remote-runtime WebRTC handling;
- the React Native TV shell used for Android TV/Google TV and related mobile surfaces.

Passing tvOS does not prove Android TV. Passing the phone build does not prove D-pad focus, overscan, TV authentication, or TV media codecs. Each needs its own closed-loop arc.

### Important AR/VR distinction

The WebXR spatial route (`web/app/spatial`) can place remote runtime windows in a 3D workspace. It remains a browser consumer of the same underlying transport. It does not turn a standalone GanttSnap page into a PowerPoint host, and JPEG data-channel capture at about 1.4 fps should be described as an interactive remote window, not high-frame-rate video.

## 10. Baseline release health at the audited commit

This audit ran non-mutating build checks before making any product claim.

### Agent build

`go test -count=1 ./...` from `desktop/agent` failed to build the main package. Representative duplicate declarations included:

- `portBusy`
- `isUnsupportedNetwork`
- `portBindFailure`
- `AccessDeniedReason`
- `cleanProjectList`
- `boolPtr`
- `prettyPrintJSONObject`
- `yesNo`
- `runGit`
- `dashIfEmpty`

The host-share auth test also references missing production fields/types as described above. Some subpackages passed, but the agent binary baseline is not green.

### Mobile typecheck

`npx tsc --noEmit --pretty false` from `mobile` exited `2` with hundreds of diagnostics. They include missing native module typings/dependencies, stale auth/speech exports, theme-field drift, device/project API drift, and guest-feature drift. One directly relevant error is:

```text
app/(tabs)/guests.tsx(36,10): error TS2305:
Module '"../../src/lib/launchFlags"' has no exported member 'ENABLE_GUEST_FEATURES'.
```

This does not prove every release build is impossible—Expo/native build pipelines may use different typecheck boundaries—but it does prove this checkout cannot support a “all surfaces are beta-ready” claim from a clean global TypeScript check.

### Runtime version checks

- `yaver --version`: not available on this shell's `PATH`.
- `GET http://127.0.0.1:18080/info`: no local agent listening.
- `init.md`: absent at repository root.

No running binary was available to compare with source `cb27d4ae1`.

## 11. Minimum viable beta, once the gates are green

The smallest honest beta should be intentionally narrower than “all screens, everywhere.”

### Phase A — core friend-owned loop

1. Friend creates and verifies his own Yaver account.
2. Friend receives his own Cloud Workspace entitlement/subscription.
3. Workspace provisions and answers real `/health` and `/info` probes.
4. Friend completes Yaver's registered GitHub or GitLab device flow on the target workspace and clones GanttSnap.
5. Yaver detects the project and produces a measured dependency plan before installing anything.
6. The common cloud CLI pack installs within its 10 GiB owned-footprint ceiling; every selected CLI passes a real version and read-only operation probe.
7. Friend authorizes only the providers GanttSnap actually uses—Vercel, Cloudflare, Supabase, Firebase, or others—through each provider's supported human/headless flow.
8. Yaver shows the connected provider identity, team/account, selected project, requested scopes, and revoke route without revealing tokens.
9. Friend authenticates OpenCode and the chosen model provider on the workspace.
10. A headless OpenCode prompt using the exact selected DeepSeek model succeeds.
11. GanttSnap install, unit tests, build, and dev server succeed.
12. A preview deployment succeeds before any production-deploy control is enabled.
13. Friend opens the standalone preview in web, phone, and tablet.
14. Friend creates a task from mobile, watches raw output, and renders exactly once after the task reaches a renderable terminal state.
15. Workspace parks and wakes; repo, provider bindings, and auth remain usable.

### Phase B — real PowerPoint host

1. Choose the friend's existing dedicated Windows machine or an Azure personal Windows desktop/Cloud PC as the native Office host; keep Hetzner Linux as the build box if desired.
2. The friend signs into Windows and Office interactively with his own licensed Entra/Microsoft account; Yaver never receives tenant-admin or Windows credentials.
3. A dedicated PowerPoint-on-the-web test document and a disposable desktop presentation exist in the friend's tenant.
4. The add-in is sideloaded through a supported Microsoft flow.
5. Browser and Windows profiles/sessions are explicitly persistent and friend-scoped.
6. The test waits for `Office.onReady` and proves one read plus one harmless write in each claimed host.
7. The Windows session remains interactive/unlocked and `desktop-screen` produces a useful H.264 WebRTC frame plus input echo.
8. Direct ICE and TURN-assisted ICE are tested separately; blocking UDP produces the named fallback rather than a false WebRTC label.
9. The rendered task pane is judged on pixels on web, phone/tablet remote view, and one TV/headset surface.
10. macOS is added only if GanttSnap claims native PowerPoint for Mac compatibility.

### Phase C — companion breadth

1. tvOS and Android TV each start or observe the same beta task and receive the rendered preview/fallback.
2. Watch and Wear OS start/check a task and hand off to phone for visuals.
3. Car surfaces dispatch a safe voice task and never expose code or a visual preview.
4. WebXR opens the spatial workspace and receives a useful first frame; the transport and frame rate are named.

## 12. P0 gates before inviting the friend

### P0.1 — make the audited source buildable

- Restore `go test ./...` for `desktop/agent`.
- Resolve duplicate production declarations without deleting unrelated user work.
- Either restore the host-share production contract or quarantine/remove stale tests and routes in a deliberate product decision. Do not paper over it with empty types.
- Establish the intended mobile typecheck/build command and make that release gate green.
- Fix the mobile guest launch-flag mismatch even if guest functionality remains off.

### P0.2 — make dedicated-account onboarding a tested verb

One bounded test or diagnostic should answer:

- authenticated user id;
- subscription/entitlement state;
- cloud machine row owner;
- provider server/volume presence;
- agent registration owner;
- `/health` and `/info` capability response;
- repo availability;
- selected runner and model live-probe result;
- park/wake persistence result.

This must be the same operation the web/mobile onboarding surfaces consume, not a private admin script.

### P0.3 — finish DeepSeek BYOK

- Decide OpenCode-native login versus Yaver local-secret setup.
- Make cloud bootstrap, agent catalog, mobile default, and actual OpenCode config agree on the provider/model.
- Add a first-class `DEEPSEEK_API_KEY` setup path if API-key onboarding is the decision.
- Resolve the vault-off contradiction for managed boxes.
- Live-probe the exact model and return a structured route when auth/model entitlement fails.
- Keep the friend's secret only on his workspace/device trust graph.

### P0.4 — define GanttSnap's honest preview contract

- Label standalone preview as standalone.
- Add or explicitly defer a `powerpoint-web` host target.
- If implemented later, persist the Microsoft profile only within the friend's encrypted/dedicated workspace state.
- Prove `Office.onReady`, document access, and an actual Office API operation.
- Add Windows/macOS hosts before claiming native desktop PowerPoint support.

### P0.5 — prove the three primary surfaces

Before expanding the beta, make web, one real phone, and one real tablet pass:

- sign in as the friend;
- see only the friend's workspace;
- wake it;
- choose GanttSnap;
- run the chosen OpenCode/DeepSeek model;
- stream real raw output;
- render once after completion;
- show the active direct/WebRTC/relay transport;
- survive reconnect and park/wake.

### P0.6 — make the cloud-developer pack a bounded product

- Define the base-pack manifest with pinned versions, source URLs/registries, supported OS/architecture, and per-tool owned paths.
- Add Vercel, Supabase, and Firebase to the cloud-image or verified on-demand profile; do not let detection imply installation.
- Add a real Firebase install route and include Firebase in the auth/account contract.
- Replace unpinned `npx -y <latest>` wrappers with project-pinned dependencies or integrity-verified pinned artifacts.
- Measure the built image and installed owned footprint; fail the image release above 9.4 GiB and reserve the remaining 0.6 GiB as margin.
- Keep emulators, Docker service images, Android/Flutter SDKs, browsers beyond the single baseline Chromium, and model weights opt-in and outside the base promise.
- Surface estimated bytes, current bytes, elapsed time, and post-install version/operation proof on every full-control surface.

### P0.7 — unify provider authorization without pretending every provider uses Device Flow

- Register and live-probe Yaver GitHub and GitLab OAuth clients; make missing client configuration a named setup failure.
- Drive current plain `vercel login` Device Flow; do not use removed `--github`/`--gitlab` flags.
- Implement Cloudflare Authorization Code + PKCE or explicitly use a least-privilege token for the beta; do not invent a Cloudflare device flow.
- Treat Supabase as PAT-based and protect the fallback plaintext CLI credential path on headless Linux.
- Drive `firebase login --no-localhost` for a human workspace and use workload identity/Application Default Credentials for unattended automation.
- Separate `authenticated`, `account selected`, `project linked`, and `read-only probe passed`; no one-bit “connected” false green.
- Provide revoke/sign-out and token-expiry recovery on web, mobile, CLI/MCP, with handoff-only behavior on constrained surfaces.

### P0.8 — prove one Windows Office host

- Cross-build and release the Windows agent from a green source tree, then install through the signed release path.
- Probe agent HTTP, ConPTY, PowerPoint launch/focus, GDI capture, H.264 WebRTC first frame, TURN-assisted ICE, input echo, and the JPEG fallback.
- Prove behavior after RDP/Windows App disconnect, lock, reconnect, reboot, and agent update.
- Confirm the exact friend/tenant/Windows/Office licensing combination with the tenant administrator.
- Refuse Session 0/service-hosted Office automation and refuse tenant-admin/password storage.

## 13. P1 hardening for a useful external beta

- Add an owner-funded beta entitlement/grant if the friend should not pay, while preserving beneficiary ownership.
- Add a private-repo onboarding lane that detects missing Git auth before clone.
- Add a PowerPoint manifest/API-set doctor for the GanttSnap repo.
- Add durable Microsoft web-session lifecycle with explicit sign-out/revoke.
- Add per-surface capability language so watch/car never advertise preview and WebXR never advertises native Office.
- Add telemetry that contains reason codes and timings only—never prompts, filenames, source, Microsoft cookies, or provider secrets.
- Add quotas for active compute time, concurrent tasks, preview sessions, relay frames, and artifact storage, with visible remaining allowance.
- Add account/data export and beta offboarding: revoke sessions, stop compute, return repo ownership, and define persistent-volume retention/deletion.

## 14. If shared workspaces are reconsidered later

This beta should not depend on shared-machine work, but a future team product would need all of the following before a feature flag can move:

- authenticated team membership checked server-side on every request;
- explicit roles and project-scoped grants;
- per-user OS or microVM isolation, not plain co-tenant Docker;
- separate Git, Microsoft, runner, shell, task, terminal, and browser-profile state;
- no fallback from failed per-user allocation to an owner singleton;
- per-user process, port, filesystem, log, environment, and resource quotas;
- provider credentials scoped to user or project with no owner inheritance;
- revocation that kills live terminals, browser sessions, WebRTC peers, tasks, and cached authorization immediately;
- audit events visible to both workspace administrator and member without exposing secret content;
- adversarial tests in which tenant A attempts every agent, relay, file, terminal, preview, and vault route belonging to tenant B.

Until then, dedicated friend-owned VMs are both simpler and safer.

## 15. Headless-first acceptance plan

Every row below must be exercised against the real beta account and real box. A database row or process id is insufficient.

| Probe | Success criterion | Negative control |
|---|---|---|
| Identity | `/auth/validate` and machine `/info` agree on friend's ownership | Owner and third-account token receive 403 |
| Provision | `/health` and required tool operations work | Disable a required image/tool and see a named failure route |
| Git | Friend can clone/fetch/push allowed GanttSnap repo | Unauthenticated/private repo fails before task dispatch with Git-auth action |
| Tool budget | Exact pack manifest installs at ≤9.4 GiB owned footprint | Artificially lower budget and see `tool.disk_budget` before download |
| Provider CLI | Required Vercel/Cloudflare/Supabase/Firebase CLI resolves and passes version/read probe | Remove binary and see a valid streamed install route, never a deploy attempt |
| Provider auth | Identity + account/team + selected project + scopes are verified | Expired/wrong-scope token produces provider-specific reconnect route |
| OpenCode | `opencode --version` plus one real no-op completion | Remove auth and see provider-specific remediation |
| DeepSeek | Exact selected model completes and reports provider/model id | Invalid key and unsupported model are distinguished |
| GanttSnap web | install/test/build/dev server and direct HTTP asset fetch pass | Kill dev server and ensure preview says why |
| Office host | PowerPoint web loads add-in, `Office.onReady` fires, test presentation changes | Standalone page must not count as Office-host success |
| Windows Office | Native PowerPoint is visible, add-in works, H.264 first frame and input echo succeed | Lock/log off and confirm a named `interactive_session_required` state |
| Direct preview | useful page fetched with correct auth and no secret in URL | Cross-user token and origin rejected |
| WebRTC | offer/answer, candidate types, ICE path, first useful H.264 frame, input echo | Block direct UDP and prove TURN or named fallback |
| Relay/TURN | short-lived credential, relay candidate, first useful frame; active transport named | Disable TURN and confirm the UI does not call JPEG polling WebRTC |
| Relay JPEG | authenticated frame arrives and is labeled still-frame polling | Wrong account/device cannot fetch frame |
| Park/wake | repo, runner auth, and project state remain; health recovers | Detach/miss volume and verify fail-closed error, never ephemeral success |

## 16. Closed-loop pixel arcs

After headless probes pass:

### Web

- Sign in as the friend.
- Confirm only the friend's workspace appears.
- Wake it and open GanttSnap.
- Start a small coding task.
- Verify raw output changes while `running`.
- Verify no reload occurs while coding.
- Verify one render after `completed`/`review`.
- Verify the old good preview stays visible during refresh.
- For Office mode, assert visible PowerPoint chrome and task pane, not merely GanttSnap pixels.

### Phone and tablet

- Use genuine device contexts and, for final beta, real devices.
- Assert Yaver auth storage and transport behavior for the RN app, not a narrowed dashboard.
- Repeat task, raw console, render, reconnect, and wake.
- Ensure the tablet uses its additional area rather than stretching phone controls.

### tvOS and Android TV

- Test each build separately.
- Assert D-pad/focus behavior, auth, first useful frame, transport label, and safe task dispatch.
- Confirm a stalled stream exposes a reason/action rather than an infinite spinner.

### Watch, Wear OS, and car

- Ask for a small GanttSnap change.
- Receive “working” then one safe sentence/haptic.
- Ask to read code/diff while driving and confirm refusal/handoff.
- Confirm the phone can open the exact task after handoff.

### WebXR/headset

- Enter the real WebXR device context.
- Open the friend's remote browser window.
- Verify first useful frame, interaction, and active transport.
- Confirm the surface calls a JPEG lane what it is and does not claim PowerPoint-host validation without visible PowerPoint chrome and an Office API assertion.

## 17. Privacy and security acceptance criteria

The beta is acceptable only if all are true:

- The friend's AI, Git, and Microsoft credentials are never copied to the owner's account or devices.
- Vercel, Cloudflare, Supabase, Firebase/Google, Azure, and Office credentials stay on the friend's device/workspace trust graph; tenant-admin credentials are never requested.
- Convex stores identity, discovery, lifecycle, and routing metadata—not prompts, raw task output, source, paths, provider keys, or Microsoft session cookies.
- Relay authorization remains same-owner/access-graph scoped and forwards only encrypted/authenticated traffic.
- A relay compromise does not give shell, agent, or cross-tenant access.
- Browser and WebRTC control endpoints require the same bearer/device ownership checks as ordinary agent routes.
- No bearer or provider token appears in a URL, screenshot, task prompt, repo file, or log.
- OAuth state, PKCE verifier, device code, refresh token, and PAT lifetimes are bounded and stored according to their secrecy; user codes may be displayed but are never treated as durable credentials.
- The friend's persistent volume is dedicated to him and has a documented deletion/export path.
- Beta support access, if ever added, is explicit, time-limited, least-privilege, visible, revocable, and cannot read secrets/source by default.

## 18. Metrics that would make this beta informative

Collect only privacy-safe operational measurements:

- signup-to-entitled time;
- entitlement-to-healthy-workspace time;
- wake-to-healthy and wake-to-first-task time;
- runner auth attempts and structured failure codes;
- exact runner/provider/model selected, without prompt or key;
- task queued/running/terminal durations;
- dev-server start-to-first-byte;
- preview start-to-first-useful-frame;
- selected transport and fallback reason;
- reconnect success rate;
- park/wake persistence failures;
- surface used and handoff destination;
- Office-host readiness failure code (`microsoft_auth`, `sideload_missing`, `office_not_ready`, `api_set_unsupported`, `https_required`, etc.).

The beta should not record prompts, source, filenames, presentation contents, slides, screenshots, task stdout, or credentials merely because they would make debugging easier.

## 19. Final recommendation

Invite the friend only after the core build is green and the following exact path has passed once internally:

> New non-owner account → own Cloud Workspace entitlement → healthy dedicated Linux build box → registered GitHub/GitLab device authorization → private GanttSnap clone → measured ≤9.4 GiB base tool pack → only the required cloud providers authenticated, selected, linked, and read-probed → own OpenCode/DeepSeek authentication → real model completion → GanttSnap build/dev server + preview deployment → web + real phone + real tablet loop → park/wake persistence → cross-user access denial.

Use PowerPoint on the web and one native Windows PowerPoint host as separate, explicit second milestones. Prefer the friend's existing dedicated Windows box; if a rented host is required, prefer an Azure personal Windows desktop or Windows 365 Cloud PC. Keep Hetzner Linux as the economical coding box. Do not promise Windows 10/11 on Hetzner, do not treat current Yaver Azure provisioning as Windows-capable, and do not use shared tenant-admin credentials.

Until the browser lane can open a persistent authenticated Office host and prove an Office.js operation, describe Yaver's Linux GanttSnap rendering as **standalone web preview**, not **PowerPoint add-in validation**. Until the Windows lane has produced a real H.264 first frame and input echo through direct and TURN-assisted ICE, describe Relay Pro as **connectivity with an authenticated JPEG fallback**, not “WebRTC only.”

The cloud-provider goal is feasible without a bloated SDK image: ship a small, pinned, measured CLI pack and install emulators/local stacks only when a project needs them. The harder missing product is not disk space; it is one typed install/auth/link/probe/revoke state machine that web, mobile, CLI/MCP, TV/headset handoff, and watch/car handoff all consume. Vercel and Git providers can use device flows, Cloudflare requires Authorization Code + PKCE, Supabase is PAT-based, and Firebase needs remote browser login or workload identity. Treating all four as a generic “OAuth” button would be another false green.

Do not make watch, car, or every novelty surface a gate for the first friend beta. They are valuable parity probes after the core loop works. The first beta should establish one trustworthy identity, one dedicated box, one real model, one real repo, and one honest GanttSnap render. Breadth is useful only after that spine is true.

## Evidence/check log

Read and then code-checked:

- `CLAUDE.md`
- `docs/architecture/AI_ARCH.md`
- `docs/architecture/REMOTE_WORKER.md`
- `init.md` was requested by the project guide but is absent.

Repository probes:

```text
git HEAD: cb27d4ae1
yaver --version: command not found
http://127.0.0.1:18080/info: connection refused
GanttSnap references in this checkout: none
desktop/agent go test ./...: FAIL (main package build errors)
mobile npx tsc --noEmit: FAIL (exit 2; hundreds of diagnostics)
current Yaver Azure provider OS: Ubuntu/Linux only
current yaver-cloud Dockerfile requires: gh, glab
current yaver-cloud Dockerfile attempts with ignored npm errors: Wrangler, Claude, Codex, OpenCode
current yaver-cloud Dockerfile omits: Vercel, Supabase, Firebase CLI
current generic installer OS support: macOS/Linux; Windows excluded
current Firebase state: detected/deployable, but no install plan or account provider
```

External policy/documentation checked on 2026-08-16:

- Microsoft Azure Virtual Desktop, Windows 11 multitenant hosting, Microsoft 365 Apps activation/SCA, Windows 365, Office add-in runtime/sideloading documentation;
- Hetzner Cloud and dedicated-server Windows licensing/installation documentation;
- GitHub and GitLab OAuth device-flow documentation;
- Vercel CLI/device-flow and Git integration documentation;
- Cloudflare Wrangler and OAuth Authorization Code + PKCE documentation;
- Supabase CLI install/login and npm supply-chain guidance;
- Firebase CLI install, remote login, and headless/CI credential guidance.

No implementation, deployment, provisioning, billing, account invitation, credential operation, commit, or push was performed.
