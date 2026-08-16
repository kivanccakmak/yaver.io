# Can Yaver have Cloud Windows like Cloud Linux? — feasibility deep audit

**Date:** 2026-08-16  
**Source slice:** `8cb585c85`  
**Mode:** Analysis only. No code, deployment, Azure resource, tenant, user, license, or credential was changed.  
**Question:** Can Yaver offer a Microsoft Windows cloud development workspace, comparable to the current Linux Cloud Workspace, for AI coding and real desktop PowerPoint development?

## 1. Short answer

**Yes.** Yaver can offer a Cloud Windows development workspace.

The best first managed form is an **Azure Virtual Desktop personal desktop**:

- one persistent Windows 11 desktop assigned to one user;
- Microsoft Entra joined with the user's own sign-in and MFA;
- a supported image with Microsoft 365 Apps, or a controlled golden image;
- a signed Yaver Windows agent running in the user's interactive session;
- Claude Code, OpenCode, Codex, Git, Node, browsers, and optional WSL2;
- outbound Yaver Relay Pro connectivity;
- H.264 WebRTC desktop view/control with TURN when direct ICE fails;
- start-on-connect and controlled deallocation/hibernation to reduce compute cost;
- persistent disk/profile/repository state across stops.

But it is **not** “change Ubuntu to Windows in the existing provider.” Cloud Windows is a separate product class because it adds:

- Windows and remote-desktop access rights;
- Entra user assignment and interactive sign-in;
- Office installation and per-user activation;
- a desktop/session lifecycle distinct from VM lifecycle;
- GUI capture/control and consent;
- Windows update/reboot behavior;
- optional WSL2 and nested-virtualization requirements;
- significantly different cost and storage behavior;
- tenant-admin integration when managed on the user's Microsoft tenant.

The practical decision is:

> Build `Cloud Windows` beside `Cloud Linux`, not inside it. Reuse Yaver identity, task routing, relay, vault, projects, and clients; introduce a separate Windows desktop provider, lifecycle, readiness model, image pipeline, and price.

## 2. What “same as Cloud Linux” can and cannot mean

### 2.1 What can be the same

The user experience can converge on the same high-level verbs:

- Create workspace.
- Wake workspace.
- Open a terminal or live runner console.
- Ask Claude/OpenCode/Codex to work.
- View a browser, emulator, or desktop.
- Resume from phone, tablet, web, TV, or another authorized device.
- Persist repositories and approved credentials.
- Park when idle.
- See usage, cost, health, and the route to any required fix.
- Delete the workspace and its Yaver-owned resources safely.

The shared control-plane concepts can also be reused:

- Yaver account and entitlement;
- device ownership and collaborator grants;
- task state and runner routing;
- structured failure codes;
- relay registration;
- OAuth/vault abstractions;
- project catalog;
- telemetry that excludes source, screens, prompts, and secrets;
- headless diagnostics followed by a real pixel-level closed loop.

### 2.2 What must remain different

| Concern | Cloud Linux | Cloud Windows |
|---|---|---|
| Primary workload | Headless agent, CLI, containers, web server | Interactive desktop plus CLI/dev tools |
| Boot identity | Machine/service identity | Machine identity **and** assigned human user |
| Bootstrap | cloud-init, SSH key, systemd, shell scripts | ARM/AVD resources, VM extensions/Intune, signed installer, user-logon setup |
| Readiness | Agent and required operations answer | Infrastructure, user assignment, first login, interactive session, agent, desktop, Office, and stream all answer |
| Authentication | Yaver and runner/provider credentials | Those plus Entra/Windows sign-in and Office activation |
| Persistence | Data volume/snapshot | OS/profile disk, repositories, app state, Office profile, possibly FSLogix |
| Park | Delete/recreate or stop with durable volume | Deallocate or hibernate; preserve user/profile disk and AVD assignment |
| Wake | Recreate/boot then agent health | Start VM, AVD session becomes reachable, user session is restored/created, interactive agent becomes ready |
| Rendering | Browser/dev server, optional virtual display | Real Windows desktop, WebView2, PowerPoint, browsers, WSL apps |
| Automation | Headless is normal | Office and screen control require an interactive user session |
| Licensing | Linux distribution/open-source tool terms | Windows access rights, AVD/Windows 365 entitlement, Microsoft 365 Apps entitlement |
| Cost shape | Low-cost Linux compute; delete-to-zero practical | Higher Windows compute plus persistent disks and Microsoft licensing |

The UI can say “Cloud Workspace,” but it must render the selected capability truthfully: `Linux coding workspace` or `Windows desktop workspace`.

## 3. The three Microsoft cloud products Yaver could use

### 3.1 Azure Virtual Desktop personal desktop — recommended

An AVD personal host pool assigns one desktop to one user. Microsoft describes personal desktops as a one-to-one mapping with persistent files and settings and as a good fit for resource-intensive users. That matches a developer using PowerPoint, WebView2, local repositories, and coding agents. See [personal desktop assignment](https://learn.microsoft.com/en-us/azure/virtual-desktop/configure-host-pool-personal-desktop-assignment-type).

AVD gives Yaver:

- supported Windows 11 Enterprise desktop images;
- Microsoft Entra user authentication;
- personal assignment;
- Windows App/web/iOS/Android access as a recovery path;
- Start VM on Connect;
- personal-host-pool autoscale;
- deallocate or hibernate policies;
- Microsoft 365 Apps-capable images;
- no requirement to expose inbound RDP to the internet.

Microsoft's current AVD quickstart creates a Windows 11 Enterprise multi-session host with Microsoft 365 Apps preinstalled, Entra join, SSO, a full desktop application group, and no inbound NSG rules. That proves the underlying Microsoft platform supports the intended shape. See the [AVD quickstart](https://learn.microsoft.com/en-us/azure/virtual-desktop/quickstart?tabs=macos).

For Yaver, use a **personal host pool**, even if the image is technically multi-session capable. The first product should be one person, one desktop, one Office profile, one repository identity, and one control lease.

### 3.2 Windows 365 Cloud PC — viable attach path

Windows 365 is a Microsoft-managed Cloud PC assigned through a provisioning policy and a user license. It is operationally simpler for a company already using Entra and Intune, but it is less like Yaver's consumption-based Linux machine:

- the Cloud PC is tied to a Windows 365 license/SKU;
- provisioning is driven by an Intune policy and assigned Entra groups;
- lifecycle and resizing are Windows 365 operations, not ordinary Azure VM operations;
- the price is generally a fixed licensed Cloud PC rather than an hourly VM Yaver can freely scale to zero;
- Yaver cannot treat the underlying host as a normal ARM VM it owns.

Windows 365 Enterprise currently requires the relevant Windows, Intune, Entra, and Windows 365 licensing. A Microsoft-hosted network can avoid a customer Azure subscription for an Entra-joined Cloud PC. See [Windows 365 requirements](https://learn.microsoft.com/en-ca/windows-365/enterprise/requirements) and [Windows 365 provisioning](https://learn.microsoft.com/en-us/windows-365/enterprise/provisioning).

This makes Windows 365 a strong **attach an existing assigned Cloud PC** option. It is not the cleanest first basis for a Yaver-priced, usage-metered Cloud Windows product.

### 3.3 Raw Windows 11 Azure VM — technically possible, not the best first product

Azure can run eligible Windows 11 Enterprise images. Microsoft documents the license entitlements and the `MicrosoftWindowsDesktop` marketplace images. See [deploying Windows 11 on Azure](https://learn.microsoft.com/en-us/azure/virtual-machines/windows/windows-desktop-multitenant-hosting-deployment).

A raw VM gives maximum lifecycle control, but Yaver would have to recreate much of the desktop product:

- Windows eligibility and license flags;
- Entra join and user assignment;
- supported remote access;
- secure first-login/bootstrap;
- session awareness;
- desktop availability across disconnects;
- passwordless/MFA behavior;
- Office deployment and activation;
- update/reboot management;
- recovery access;
- safe deallocation and deletion.

AVD already provides the supported desktop access and assignment layer. A raw VM should be reserved for BYO attach or a later specialized product.

## 4. Recommended Yaver product definition

### 4.1 Product name and boundary

Create a separate product capability:

```text
Cloud Workspace
  +-- Linux Workspace
  +-- Windows Desktop Workspace
```

Do not make “Windows” a hidden provider setting. Placement should select Windows only when the requested operation genuinely requires it, for example:

- native PowerPoint/Excel/Word;
- a Windows-only SDK or COM integration;
- WebView2-specific add-in behavior;
- Windows installer/package testing;
- Visual Studio/MSBuild workloads not supported elsewhere;
- Windows UI automation;
- a Windows browser/driver compatibility target.

Ordinary TypeScript builds, web servers, CI, and AI runners should continue on cheaper Linux unless the user explicitly wants the Windows desktop or the project capability graph proves it is required.

### 4.2 Initial machine profile

A credible starting profile is:

- Windows 11 Enterprise;
- 4 vCPU and 16 GiB RAM as the floor for PowerPoint, browser/WebView2, Node, and one AI coding runner;
- 128–256 GiB premium/standard SSD depending on repository and SDK needs;
- amd64 initially;
- Entra joined;
- personal AVD host assignment;
- Microsoft 365 Apps image only when Office is part of the subscription/tenant contract;
- signed Yaver Windows agent;
- Git, Node, PowerShell 7, browser, and approved runner bootstrap;
- optional WSL2 profile on a size and security configuration proven to expose nested virtualization;
- outbound-only Yaver Relay Pro.

Microsoft's sample AVD environment uses 4 vCPU/16 GiB, which is a useful platform example, not a guarantee that it is sufficient for every repository. Yaver must measure project pressure and offer a safe resize path.

### 4.3 Product tiers

Avoid silently absorbing Windows into the existing Linux flat price. The cost model is materially different.

Possible packaging:

| Tier | Meaning | Billing shape |
|---|---|---|
| BYO Windows | User owns physical/cloud Windows machine; Yaver connects it | Relay/management subscription only |
| Cloud Windows Hours | Yaver/customer Azure subscription, AVD personal host billed while active | Included hours plus overage; persistent storage billed/covered separately |
| Cloud Windows Dedicated | Persistent assigned desktop with larger included use | Higher monthly price |
| Attach Windows 365 | User/tenant already owns Cloud PC license | Yaver management/relay only; Microsoft license remains external |

Do not publish a price until Azure compute, disks, IP/network egress, AVD access entitlement, Office licensing, relay/TURN bandwidth, image maintenance, and support costs are wired to real regional estimates.

## 5. The lifecycle that makes Cloud Windows real

### 5.1 Provision

The managed AVD path needs a transaction that creates or verifies:

1. Customer/Yaver Azure connection with bounded RBAC.
2. Yaver-specific resource group and tags.
3. VNet/subnet and egress policy, with no public inbound RDP.
4. AVD personal host pool.
5. Desktop application group.
6. AVD workspace registration.
7. Windows 11 session host from an approved image.
8. Entra join and SSO configuration.
9. User assignment.
10. Windows/AVD license setting and tenant entitlement.
11. Signed Yaver agent deployment.
12. Required developer tools and optional Office image.
13. External agent, relay, TURN, desktop-capture, and user-session probes.

Partially created satellites—NICs, disks, public IPs, host registrations, assignments, and role bindings—must remain inventoried and recoverable. A failed provision cannot leak monthly resources.

### 5.2 First login

The workspace is not fully ready after ARM reports success.

The first interactive login must establish:

- the user's Windows profile;
- MFA/Conditional Access completion;
- Office activation/sign-in where required;
- Yaver scheduled task or user-session companion;
- PowerPoint first-run/update dialogs;
- runner and Git/provider login owned by the user;
- optional WSL distribution/user initialization;
- a real captured desktop frame.

The state should be `awaiting_first_login`, with an action that opens Microsoft Windows App/AVD web access. Yaver must not request or store the user's Windows/Microsoft password to complete this step.

### 5.3 Active

`active` should mean all operations required by the requested task are ready. For a PowerPoint development task:

```text
VM running
AND AVD session host available
AND assigned user has an interactive unlocked session
AND Yaver interactive agent answers
AND desktop capture produces a changing frame
AND H.264 encoder produces a decodable first frame
AND ICE is direct-capable or TURN relay-capable
AND PowerPoint launches
AND Office add-in requirements pass
AND selected coding runner produces a real completion
```

Anything less needs a more specific state.

### 5.4 Park

Windows park should default to **deallocate while retaining the desktop's disks and assignment**.

Azure states that a deallocated VM does not incur compute charges, although OS/data disks and other retained resources continue to cost money. See [Azure VM states and billing](https://learn.microsoft.com/en-us/azure/virtual-machines/windows/tutorial-manage-vm) and [VM cost planning](https://learn.microsoft.com/en-us/azure/virtual-machines/cost-optimization-plan-to-manage-costs).

Important differences from Linux:

- shutting down Windows from inside the guest does not necessarily deallocate it;
- disconnecting a desktop does not necessarily sign the user out;
- Start VM on Connect powers on a VM, but does not automatically deallocate it later;
- AVD autoscale or a Yaver lifecycle controller must perform deallocation;
- deallocation must not occur while a coding task, file write, Office save, runner auth, installation, or render is active.

Microsoft's [Start VM on Connect FAQ](https://learn.microsoft.com/en-us/azure/virtual-desktop/start-virtual-machine-connect-faq) explicitly distinguishes shutdown/sign-out from Azure deallocation.

### 5.5 Hibernate

Hibernation can preserve memory state to the OS disk and then deallocate the VM. AVD personal scaling plans can choose hibernate for supported desktops. See [AVD autoscale scaling plans](https://learn.microsoft.com/en-us/azure/virtual-desktop/autoscale-create-assign-scaling-plan).

It is attractive for a developer desktop, but should be an optional capability after a real probe because:

- only supported sizes/images/configurations work;
- the OS disk must hold the memory image;
- Windows guest configuration and the Azure hibernation extension must be healthy;
- security/nested-virtualization settings can interact with hibernation;
- resume can fail due to regional capacity, requiring a cold boot fallback;
- external WebRTC and runner connections will still reconnect rather than survive as live sockets.

Default beta behavior should be a clean save/sign-out/deallocate path. Add hibernate after the exact golden image and SKU pass suspend/resume failure tests.

### 5.6 Wake

Wake should report distinct progress:

```text
requested
allocating_compute
booting_windows
avd_host_registering
awaiting_user_session
starting_yaver_agent
restoring_runner
probing_desktop
ready
```

Start VM on Connect can power on an assigned personal desktop, but cold-start delay is expected. Microsoft surfaces that state to Windows App users. Yaver must surface the same truth rather than showing “offline.” See [Start VM on Connect](https://learn.microsoft.com/en-us/azure/virtual-desktop/start-virtual-machine-connect).

## 6. Identity and credentials

Cloud Windows has four distinct authority domains:

| Identity | Purpose | Where it lives |
|---|---|---|
| Yaver user/device | Workspace ownership, tasks, relay, grants | Yaver auth/device keys |
| Azure management principal | Create/read/delete only scoped Windows workspace resources | Customer/Yaver Azure app with RBAC; secret/certificate in approved secret store |
| Microsoft user | Entra/Windows login, MFA, AVD assignment | Microsoft-controlled interactive auth; never stored by Yaver |
| Developer/provider accounts | GitHub/GitLab, Claude, OpenCode, Codex, Vercel, Cloudflare, etc. | User vault and provider-supported device/browser flows |

For a friend beta, prefer **customer-owned tenant/subscription attach**:

- the tenant administrator grants a narrowly scoped Yaver enterprise application or performs provisioning manually;
- the friend's normal Entra account is assigned the desktop and relevant licenses;
- the friend completes Windows and Office sign-in;
- Yaver receives only the infrastructure/API authority it needs;
- no tenant-admin or user password is sent to the Yaver agent or stored in Convex.

A future Yaver-owned Azure subscription is possible, including AVD external-user access pricing where eligible, but it introduces commercial licensing, tenant invitation, support, regional capacity, data residency, and abuse responsibilities. It should follow the customer-owned beta.

## 7. Office and PowerPoint

### 7.1 Yes, real PowerPoint can run

A Cloud Windows desktop can run desktop PowerPoint and GanttSnap in a real Office host. AVD supports Windows 11 Enterprise session hosts and Microsoft 365 Apps-capable images. Microsoft documents installing Microsoft 365 Apps into an AVD image; see [customizing an AVD image](https://learn.microsoft.com/en-us/azure/virtual-desktop/set-up-customize-master-image).

The user's Microsoft 365 plan must include the appropriate desktop apps and AVD/shared-computer rights for the selected topology. Shared Computer Activation is necessary for shared/multi-user scenarios with supported plans, but it is not automatically required merely because a personal desktop is remote. See [Shared Computer Activation](https://learn.microsoft.com/en-us/microsoft-365-apps/licensing-activation/overview-shared-computer-activation).

### 7.2 It cannot be a headless Office server

Microsoft does not support unattended, non-interactive Office automation from Windows services or equivalent server-side contexts. PowerPoint assumes a user profile and interactive desktop and can display modal dialogs. See [Microsoft's Office automation guidance](https://support.microsoft.com/en-us/visio/considerations-for-server-side-automation-of-office).

Therefore Yaver's PowerPoint lane must:

- run in the assigned user's session;
- require the user to complete Office/MFA prompts;
- use a disposable test presentation for automation;
- detect blocking dialogs visibly;
- never run Office as `SYSTEM` or Session 0;
- classify locked/logged-off state;
- save or discard only under an explicit policy;
- never reuse one user's Office token/profile for another user.

### 7.3 GanttSnap development split

The efficient placement is:

- TypeScript/build/unit tests may run on Cloud Linux, Windows native, or WSL2.
- PowerPoint/WebView2 integration tests run on Cloud Windows.
- PowerPoint on the web is a separate browser-host test.
- Native macOS PowerPoint compatibility still requires a Mac.

Yaver should route only the Windows-required validation step to Cloud Windows instead of paying Windows rates for every lint/build task.

## 8. Coding runners and WSL2

### 8.1 Native Windows runners

Claude Code, OpenCode, Codex, Git, Node, and browser development can run natively when their Windows distributions are supported and their real binary/model operation passes. Yaver should not infer runner readiness from a command name on PATH.

The Windows agent needs:

- ConPTY-backed terminal sessions;
- Windows-native path and quoting behavior;
- foreground/detached process lifecycle that survives UI disconnects;
- package-install recipes with signed/pinned sources;
- browser/device OAuth surfaced to phone/web;
- repository/provider credentials scoped to the user's account;
- a structured route when a runner works only in WSL.

The audited source has ConPTY support, but Windows detached runner/service behavior and general Windows installers remain incomplete.

### 8.2 WSL2

WSL2 can make Cloud Windows a strong full-stack developer box, but it is an optional capability with real infrastructure constraints.

Windows 365 officially supports WSL and other nested-virtualization workloads on qualifying Cloud PCs, currently requiring 4 vCPU or higher and a supported region. See [Windows 365 virtualization-based workloads](https://learn.microsoft.com/en-us/windows-365/enterprise/nested-virtualization).

For Azure VMs/AVD, Yaver must select and probe a VM size and security configuration that exposes nested virtualization. “Windows 11” or “Hyper-V feature installed” is not proof that WSL2 can start a distro.

When used, WSL should be a distinct Yaver seat or a first-class runner adapter. It must expose:

- selected distribution and Linux user;
- Windows-to-WSL path mapping;
- repo location;
- environment and vault boundary;
- PTY and signal behavior;
- dev-server address reachable from WebView2/PowerPoint;
- WSL stopped/running state;
- restart route;
- separate health from the native Windows desktop.

Do not describe the current `tmux` WSL shim as general runner integration.

## 9. Current Yaver source gap

The current provider model is explicitly Linux-only:

- `backend/convex/cloudProviders/types.ts:3-9` defines only Linux/serverless/inference machine profiles.
- There is no `windows-desktop`, `office-host`, `avd-personal`, or `windows-wsl` profile.
- `AzureProvider.describeCapabilities()` returns `profiles: []` and `productionEligible: false` (`azure.ts:76-98`).
- The Azure provider advertises cloud-init, Docker, and systemd rather than Windows/AVD capabilities.
- It selects a Linux-oriented default SKU decision and has no pricing integration (`azure.ts:110-126`).
- VM creation uses Linux configuration, SSH keys, and cloud-init.
- Attached/restored OS disks are hardcoded as Linux.
- The default image is Canonical Ubuntu 22.04 (`azure.ts:624-634`).
- Azure credentials are global operator environment variables, not a per-customer Azure connection.
- The shared `CreateMachineRequest` has no user assignment, Entra join, desktop pool, Office image, interactive agent, or license contract.
- Normal provider placement rejects Azure because it is not production eligible.
- The main Cloud Workspace orchestration remains deeply coupled to Hetzner provisioning and Linux cloud-init.

This means Cloud Windows is not a small extension to `azure.ts`. It requires at least:

1. New workload capability and placement types.
2. A Windows desktop provider interface.
3. AVD/Windows resource orchestration.
4. Per-customer Azure connection/RBAC.
5. Windows image and signed-agent pipeline.
6. Interactive-session lifecycle.
7. Windows runner/tool installer support.
8. Relay Pro WebRTC/TURN completion.
9. Windows/Office closed-loop testing.
10. Cost/licensing/budget integration.

## 10. Proposed provider interfaces

Do not overload the current Linux `AbstractCloudProvider` until its contract becomes meaningless. Introduce a desktop-specific layer:

```ts
type DesktopProfile =
  | "windows-dev"
  | "windows-office"
  | "windows-dev-wsl"
  | "windows-gpu";

type DesktopReadiness = {
  infrastructure: "pending" | "ready" | "failed";
  assignment: "pending" | "ready" | "failed";
  login: "awaiting_first_login" | "signed_out" | "locked" | "interactive";
  agent: "offline" | "starting" | "ready" | "auth_required";
  desktop: "unavailable" | "capture_ready" | "stream_ready";
  office?: "not_requested" | "activation_required" | "ready" | "blocked";
  runner?: "not_requested" | "auth_required" | "ready" | "failed";
};
```

Provider capabilities should include operation-backed facts such as:

- `windows-11-desktop`
- `avd-personal-host`
- `entra-join`
- `user-assignment`
- `start-on-connect`
- `deallocate-stops-compute-spend`
- `personal-disk-persistence`
- `hibernate-probed`
- `m365-apps-image`
- `interactive-session-probe`
- `windows-agent-signed`
- `desktop-h264-first-frame`
- `turn-relay-probed`
- `runner-native-windows`
- `runner-wsl2`
- `tagged-cleanup`
- `budget-telemetry`

No capability is declared because an API or image exists. It is declared only after the provider-specific operation passes.

## 11. Security architecture

### 11.1 Network

- No public inbound RDP, WinRM, SMB, or Yaver agent port.
- AVD uses its supported reverse-connect service path.
- Yaver agent connects outbound to the authenticated relay.
- WebRTC attempts direct ICE and uses authenticated TURN when necessary.
- HTTP/JPEG is a fallback and is labeled as such.
- Relay Pro pool tenancy remains key-isolated; paid tier is not an authorization boundary.
- Azure NSGs restrict unsolicited inbound traffic.
- Cloud Windows is not placed directly on a customer's corporate network by default.

### 11.2 Desktop control

- View and control are separate grants.
- Control is opt-in, single-writer, revocable, and locally visible.
- The last good frame remains visible during reconnect/reload.
- Lock, secure desktop, UAC, MFA, and Ctrl+Alt+Del boundaries are not bypassed.
- Clipboard/file transfer is off by default and separately permissioned if introduced.
- Audio capture is off by default.
- Screen frames and input do not pass through Convex.

### 11.3 Tenant and resource isolation

- One personal desktop maps to one assigned user.
- No shared Windows password or Office profile.
- Each Windows/WSL Yaver seat has a unique device key.
- Customer Azure resources carry immutable Yaver ownership tags and database links.
- Cleanup lists and proves exact resource IDs before deletion.
- Role assignments, disks, NICs, IPs, AVD registrations, and image versions are part of the orphan inventory.
- Decommission revokes access, deletes Yaver-owned compute resources, and retains/deletes recovery data only under explicit policy.

## 12. Implementation sequence

### Phase A — attach before manage

- Support a user's existing Windows PC, Azure VM, AVD personal desktop, or Windows 365 Cloud PC as a Yaver device.
- Finish the signed Windows installer and real Windows readiness doctor.
- Prove native runner and PowerPoint operations.
- Complete Relay Pro TURN and mobile WebRTC behavior.
- Learn the session, lock, disconnect, sleep, and reboot failure modes without owning Microsoft infrastructure.

### Phase B — customer-owned AVD beta

- Tenant admin creates or authorizes a narrowly scoped Yaver Azure application.
- Yaver validates subscription, quotas, region, AVD and Windows/Office entitlement.
- Provision a personal AVD desktop from an approved gallery image.
- Assign the friend and require first interactive login.
- Deploy/claim the signed Yaver agent.
- Run the full GanttSnap loop.
- Deallocate and wake repeatedly with budget telemetry.
- Prove cleanup against Yaver-specific test resources.

### Phase C — production Cloud Windows

- Add golden-image CI with Windows Update, Office/WebView2, runner/tool checks, Sysprep/image publication, and rollback.
- Add regional SKU/capacity and cost selection.
- Add subscription packaging and active-hour accounting.
- Add optional WSL2 and larger profiles.
- Add hibernation only for image/SKU combinations that pass destructive failure tests.
- Add external-user/Yaver-owned subscription model only after licensing and support review.

## 13. Acceptance gates

| Gate | Passing operation | Required failure proof |
|---|---|---|
| Azure connection | Token can read/create only approved resource group resources | Attempt outside scope is denied |
| Budget | Regional compute, disk, retained resources, egress, and license inputs resolve | Missing/unknown cost blocks paid placement |
| Image | Exact Windows/Office/Yaver image version boots and passes health | Withdraw image and prove fallback/abort |
| Entra | Correct user is assigned and SSO path is valid | Unassigned user cannot see/connect |
| First login | User profile and interactive Yaver agent become ready | Before login state remains `awaiting_first_login` |
| Office | PowerPoint launches, activation is valid, required API set works | Expired/unlicensed Office names the human action |
| Runner | Chosen native/WSL runner performs a real model completion | PATH stub or wrong WSL distro is rejected |
| Capture | Changing Windows frame is captured and H.264 decoded | Locked/Session 0/black frame is not called ready |
| Relay | Cellular viewer gathers TURN candidate and receives first frame | Close allocation range and show named failure/fallback |
| Control | Authorized input changes disposable test document | View-only grant cannot inject input |
| Persistence | Repo/profile survive deallocate/wake | Detach storage in test and block park/readiness |
| Park | No task/save/install/render in flight; VM reaches deallocated/hibernated | Guest shutdown without deallocation is detected as billable |
| Wake | Start through interactive ready state with timed phases | Capacity/login/agent failure has distinct remedy |
| Cleanup | All Yaver-owned satellites listed and removed; retained data explicit | Unlinked/ambiguous resource is not deleted |
| Cross-tenant | Tenant A cannot discover, relay to, assign, wake, or view tenant B | Negative access suite passes on every route |

## 14. What should be built first for the GanttSnap friend

Do not begin by making Yaver an AVD reseller. Begin with evidence:

1. Use the friend's existing Windows PC or an Azure/Windows desktop he already controls.
2. Install the signed Yaver Windows agent under his own Windows session.
3. Verify PowerPoint, WebView2, Office activation, the GanttSnap manifest, and required Office.js APIs.
4. Verify his chosen Claude/OpenCode/Codex environment, native or WSL2.
5. Prove direct and TURN-assisted H.264 from a real phone on cellular.
6. Prove input, control lease, local notification, revoke, lock, logoff, sleep, reboot, and reconnect.
7. Run actual GanttSnap change → task completion → one PowerPoint reload → Office API assertion → visible pixel assertion.
8. Only then provision the same environment as an AVD personal desktop in his/customer tenant.
9. Measure hourly compute, retained disk, relay bandwidth, boot time, task time, and support incidents.
10. Use those measurements to define the product price and SLA.

## 15. Final decision

Yaver **can and should** have a Cloud Windows product if real Windows applications are a strategic workload.

The recommended architecture is:

> Azure Virtual Desktop personal host + Windows 11 Enterprise + the user's Entra identity + optional Microsoft 365 Apps + signed interactive Yaver agent + optional WSL2 + outbound Relay Pro + direct/TURN WebRTC + persistent disk/profile + controlled deallocate/wake.

It should coexist with Cloud Linux:

- Cloud Linux remains the default low-cost coding/build/runtime machine.
- Cloud Windows is selected for Windows/Office/UI operations.
- Tasks can span both without pretending their files, runners, sessions, or credentials are one environment.
- Windows 365 and existing Azure/physical PCs are supported first as attachable BYO machines.
- AVD personal becomes the first genuinely Yaver-provisioned Cloud Windows path.

The current repository does not implement this product. Its machine-profile system is Linux-only, its Azure adapter is Ubuntu/cloud-init-only and not production eligible, its Windows build is not clean at the audited source slice, and Relay Pro's managed TURN path is not deployment-proven. Those are engineering gates, not reasons the product is impossible.
