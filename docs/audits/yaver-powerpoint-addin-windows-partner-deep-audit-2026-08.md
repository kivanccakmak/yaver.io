# Yaver + PowerPoint add-in development, streaming, and Microsoft publishing — deep audit

**Date:** 2026-08-16
**Decision scope:** Whether Yaver should itself become a PowerPoint add-in, how
it can develop and remotely validate GanttSnap, how local/remote runner and
renderer placement should work, and what Simkab needs for Microsoft public
distribution.
**Code-source caveat:** GanttSnap source is not present in this checkout. Its
manifest, API requirement sets, authentication, build scripts, and current
Microsoft validation state therefore remain entry probes, not assumptions.

## 1. Bottom line

Yes, Yaver can provide an excellent PowerPoint development loop, including a
small PowerPoint-hosted Yaver companion. It should not move its agent, coding
runner, or screen streamer inside PowerPoint.

Use three deliberately separate pieces:

1. **GanttSnap Office add-in:** the actual product, implemented as an Office.js
   PowerPoint task-pane/ribbon add-in and hosted over HTTPS.
2. **Optional Yaver Developer Bridge add-in:** a thin Office.js pane for
   development actions such as start task, show logs, report the active host/API
   set, request one post-task reload, and request a locally consented share. It
   is a client of Yaver, not the Yaver daemon.
3. **Yaver Desktop + native Go agent:** owns runners, repositories, dependency
   installation, ConPTY/PTY, device routing, desktop capture, WebRTC/TURN,
   control leases, secure storage, and recovery.

The key boundary is:

> Office.js supplies semantic PowerPoint operations. The native Yaver agent
> supplies machine operations and pixels.

A PowerPoint add-in is a sandboxed web application. It can create and format
slides and shapes through supported PowerPoint JavaScript APIs, but it is not a
general Windows remote-desktop host. Microsoft describes Office Add-ins as
cross-platform web applications, while COM/VSTO are Windows-only installed
models. See [Office Add-ins glossary](https://learn.microsoft.com/en-us/office/dev/add-ins/resources/resources-glossary)
and [PowerPoint shape APIs](https://learn.microsoft.com/en-us/office/dev/add-ins/powerpoint/shapes).

## 2. Recommended product topology

```text
phone / tablet / web / Yaver Desktop
              |
              | authenticated Yaver task + stream protocols
              v
        Yaver control plane
              |
       +------+-----------------------+
       |                              |
runner device                    renderer device
local or remote                  local or remote
Codex/Claude/OpenCode            dev server + target host
repo clone + tests               Windows: PowerPoint + WebView2
       |                              |
       +---- explicit git/sync ------+
                                      |
                           GanttSnap Office.js add-in
                                      |
                           semantic Office.js assertions
                                      + native-window pixels
```

The desktop GUI is one more shared Yaver control surface. It does not imply that
its embedded local agent must run the task or render the result.

## 3. Runner/renderer placement contract

Yaver already has the beginnings of the right model in code:

- `web/components/dashboard/MachineRolesCard.tsx` selects primary/secondary
  runner and renderer devices.
- `desktop/agent/ops_machine_roles.go` exposes the same owner-scoped choice to
  CLI/MCP and supports account-wide or project-specific rows.
- `desktop/agent/ops_machine_roles_doctor.go` probes both roles before claiming
  the split is reachable.
- `web/lib/agent-client.ts`, `web/lib/connectionFanout.ts`, and the equivalent
  mobile modules route task and render traffic independently.
- Electron loads the shared dashboard, so this control already belongs to the
  desktop GUI instead of needing a second desktop-only implementation.

Required combinations:

| Runner | Renderer | Example | Result |
|---|---|---|---|
| Local desktop | Local desktop | Friend codes and opens PowerPoint on one Windows laptop | Single-box default |
| Remote Linux | Local Windows desktop | Cheap Hetzner/Yaver cloud runner; friend's PowerPoint renders | Recommended split when Linux coding is preferable |
| Local Windows desktop | Remote Windows desktop | Local AI credentials; dedicated Office validation PC | Supported only after explicit repo/sync and renderer authorization |
| Remote Linux | Remote Windows desktop | Cloud coding box plus dedicated Windows Office host | Good later-stage team topology |
| Remote Windows | Same remote Windows | Azure/Windows 365/AVD personal desktop | Cloud Windows single-box |
| Local or remote runner | Browser renderer | Standalone task pane or PowerPoint on the web | Web-host test, not native-Windows proof |

The runner selection and renderer selection are separate grants. A runner may
write code without permission to view the Windows desktop. A renderer may build
and display a disposable test deck without receiving the runner's provider
tokens. A secondary role is failover inventory only until its real transport
and required capability pass the doctor.

For GanttSnap, default the project row to:

```yaml
runner: <friend-selected local or remote coding device>
renderer: ganttsnap-windows
workspace: runner-clone
autoPush: ask
```

`runner-clone` plus an explicit git commit/push/pull or artifact handoff is the
safest first split. Do not mount a whole Windows home directory into an
untrusted remote runner. Do not auto-push by default. Never represent a task as
rendered merely because the runner build succeeded.

## 4. What a Yaver PowerPoint companion should do

The optional companion can be useful if it stays small:

- show the connected Yaver account/device and the selected runner/renderer;
- create a task against the explicitly selected repository/project;
- stream concise task state and open the full Yaver console when requested;
- report `Office.onReady`, host/platform/build, and supported requirement sets;
- run a deterministic disposable-document probe through `PowerPoint.run`;
- queue one refresh after the coding task reaches `completed` or `review`;
- ask the local user to start/stop PowerPoint window sharing;
- report named causes such as `POWERPOINT_API_SET_UNSUPPORTED`,
  `ADDIN_MANIFEST_INVALID`, `OFFICE_NOT_ACTIVATED`, or
  `WINDOW_SHARE_CONSENT_REQUIRED`, each with an actionable route.

It should not:

- embed the Go daemon or an LLM provider secret in JavaScript;
- scrape Office/Microsoft cookies, the Office token cache, or Windows
  Credential Manager;
- silently start screen sharing when the task pane opens;
- issue arbitrary desktop input without a separate local control lease;
- expose the local agent unauthenticated to the add-in origin;
- claim PowerPoint compatibility from a standalone web page;
- put a full remote-desktop wall into a narrow task pane by default.

The add-in can provide a `Open in Yaver` deep link or a short-lived pairing
code. For production, prefer the normal Yaver HTTPS/device channel over direct
task-pane access to `localhost`. A direct development bridge, if retained,
needs an exact HTTPS origin allowlist, bearer/device proof, CORS without `*`, a
short expiry, and no token in a URL.

## 5. PowerPoint development and validation loop

### 5.1 Headless first

Before pixels, the runner should prove:

1. the selected directory is the exact Git root and within the user's project
   grant;
2. the manifest parses and declares PowerPoint;
3. all referenced source/icon URLs are HTTPS when required;
4. the dev certificate is trusted by the same interactive Windows user;
5. package install, lint, unit test, and production build succeed;
6. the required PowerPoint API sets are declared and runtime-checked;
7. the task-pane URL answers from the actual PowerPoint/WebView2 context;
8. `Office.onReady` fires inside PowerPoint, not in a standalone browser;
9. a disposable presentation accepts a harmless, reversible Office.js
   mutation and the value can be read back.

Requirement-set support varies by Office version and platform, so a binary
presence check is insufficient. Microsoft requires developers to declare
requirements and recommends runtime checks for APIs used by the add-in. See
[Develop Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/develop-overview?view=powerpoint-js-preview)
and [Office client/platform availability](https://learn.microsoft.com/en-us/javascript/api/requirement-sets?view=word-js-preview).

### 5.2 Closed loop second

Then prove what the user sees:

1. PowerPoint is running in the authorized interactive Windows session.
2. The expected disposable presentation and GanttSnap pane are visible.
3. A task begins on the chosen runner; the last good PowerPoint frame stays
   visible while coding.
4. Reload intents coalesce while the runner is `queued` or `running`.
5. At `completed` or `review`, the renderer synchronizes the exact commit or
   artifact and reloads once.
6. An Office.js assertion proves the intended slide/shape state.
7. A pixel assertion proves PowerPoint chrome and the task pane are visibly
   present.
8. A changing H.264 frame reaches the client over direct WebRTC and a
   TURN-assisted case; the authenticated JPEG lane remains an honestly named
   fallback.
9. View and control revoke immediately. Lock/logoff/UAC secure desktop causes a
   named refusal rather than black or stale pixels.

The semantic assertion and pixel assertion are both necessary. Office.js can
prove a rectangle exists without proving the pane rendered correctly. Pixels
can show a rectangle without proving it is the expected PowerPoint object.

## 6. Streaming PowerPoint on Windows

Current Yaver source selects the `desktop-screen` target and uses FFmpeg
`gdigrab` for Windows desktop capture, then H.264 where available. The Windows
doctor proves changing desktop frames and one H.264 encode operation only after
local screen-view consent. This is a useful base, but it is full-desktop proof,
not yet a PowerPoint-window capture product.

The production sequence should be:

1. enumerate visible top-level windows in the user's interactive session;
2. identify PowerPoint by signed executable/process plus user-visible title,
   never title alone;
3. show a local window picker and preview before consent;
4. capture only the selected window where the Windows capture API permits;
5. fall back to the selected monitor/full desktop only with an explicit warning;
6. crop or redact notification/taskbar regions only when the crop is stable and
   disclosed;
7. stop capture on process exit, session lock, user revoke, or lease expiry;
8. keep input disabled by default and scope it to the selected window/session.

The WebRTC media path remains outside Office. The add-in may request sharing or
publish semantic state, but it cannot grant the native Windows capture
permission on the user's behalf.

For the first friend beta, full-desktop `gdigrab` with explicit local consent
is acceptable if the presentation is disposable and unrelated applications are
closed. Before a broader beta, window-selective capture and multi-monitor
selection are P0 privacy requirements.

## 7. Office.js versus COM/VSTO

Use Office.js as GanttSnap's primary product:

- cross-platform web technology;
- task pane and ribbon commands;
- PowerPoint slide/shape APIs where supported;
- one hosted application and a manifest/package;
- public Marketplace and tenant deployment paths.

Add a Windows-only COM/VSTO companion only after an operation proves an
essential feature is unavailable in Office.js. COM/VSTO adds machine
installation, .NET/COM registration, Office bitness/update compatibility,
broader Windows trust, Authenticode, and a second behavior matrix. Microsoft
explicitly describes these models as Windows-only and provides an
"equivalent add-in" relationship for coexistence; see
[Office/COM/VSTO equivalence](https://learn.microsoft.com/en-gb/office/dev/add-ins/develop/make-office-add-in-compatible-with-existing-com-add-in).

Do not use COM/VSTO merely to obtain screen pixels. Native Yaver capture is the
correct outer layer and remains useful for every Windows application, not just
PowerPoint.

## 8. Linux, macOS, and cloud Windows truth

- **Linux:** can build, test, host, and deploy the Office.js web application.
  It can validate PowerPoint on the web in an authenticated browser harness.
  It cannot run native Windows PowerPoint. Do not use Wine as product proof.
- **macOS:** can run native PowerPoint for Mac and validate the add-in in its
  actual macOS webview. A Windows pass does not prove Mac compatibility.
- **BYO Windows:** best first native PowerPoint renderer because the friend
  already owns the Windows profile, Office license, and interactive seat.
- **Azure/Windows 365/AVD:** valid later renderer options when provisioned as a
  licensed interactive user desktop. Partner registration does not supply a
  Windows or Microsoft 365 license.

Office Add-ins are web applications whose UI/code must be served, and Microsoft
requires HTTPS for Office on the web and Marketplace scenarios. See
[Requirements for running Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/requirements-for-running-office-add-ins).

## 9. Microsoft accounts and Simkab Partner Center

### 9.1 Beta distribution does not require public Marketplace approval

For the friend beta, use one supported testing/private distribution lane:

- sideload the manifest into the friend's test Office environment; or
- have the friend's Microsoft 365 administrator deploy it to a small selected
  group through Integrated Apps/centralized deployment.

Tenant policy can block user acquisition or sideloading, so Yaver must report
that as an admin-policy route, not an add-in defect. Microsoft recommends the
Integrated Apps portal for organization deployment and supports staged rollout
to selected users/groups. See [deploy Office Add-ins in the Microsoft 365 admin center](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/manage-deployment-of-add-ins?view=o365-worldwide)
and [sideload Office Add-ins for testing](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing).

### 9.2 Public GanttSnap distribution should use Simkab as publisher

Yes, Simkab can enroll as the legal/publisher entity if its authorized
representative and business information pass Microsoft's verification.
Microsoft currently requires an Entra work account, authority to sign company
agreements, legal business/contact information, a Partner Center account, and
enrollment in the **Microsoft 365 and Copilot** program. See
[Open an Office account in Partner Center](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/open-a-developer-account).

Recommended ownership:

| Item | Owner |
|---|---|
| Partner Center tenant/publisher account | Simkab, with at least two controlled admin identities |
| GanttSnap manifest identity and store listing | Simkab/GanttSnap |
| Entra app registration and Graph scopes, if any | Simkab/GanttSnap tenant |
| Hosted task-pane origin and backend | Simkab/GanttSnap production accounts |
| Privacy policy, terms, support, incident contact | Simkab |
| Yaver device/relay identity | Each Yaver user/device; never the Partner tenant |
| Friend's Windows/Microsoft 365 license | Friend or friend's organization |

The public sequence is:

1. verify the Simkab Entra work-account and company domain;
2. enroll/attach the Partner Center publisher to Microsoft 365 and Copilot;
3. settle the exact publisher display name before manifests, consent pages,
   signing subjects, privacy pages, and screenshots proliferate;
4. prepare manifest/package, icons, HTTPS production origin, privacy policy,
   terms, support URL, test account/instructions, and validation evidence;
5. declare the minimum requirement sets honestly and test every claimed
   platform;
6. submit the Office solution through Partner Center for certification;
7. publish only after the approved package points at production, not a
   developer localhost/tunnel;
8. use tenant/private rollout first, then public availability.

Microsoft states that Marketplace publication makes the add-in available in
the Office in-product experience and that submission goes through Partner
Center certification; see [Publish an Office Add-in to Microsoft Marketplace](https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish-office-add-ins-to-appsource)
and [Deploy and publish Office Add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish).

### 9.3 Windows signing and Partner Center are independent

The existing Certum/SimplySign license can sign Windows native artifacts such
as Yaver Desktop, the Go agent, or a future COM/VSTO installer. It does not sign
the Office.js manifest and does not replace Microsoft Partner verification or
Marketplace certification.

The repository's new release workflow consumes an exportable PFX through
`WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`. A SimplySign cloud certificate commonly
works through a Windows certificate-store/virtual-card session instead. Owning
that license is therefore not yet proof that a GitHub-hosted runner can sign.
Choose and operation-prove one release topology:

1. **Exportable CI PFX:** store base64 PFX and password only in the protected
   GitHub environment and let the hosted Windows job sign and timestamp; or
2. **Dedicated signing runner:** a Simkab-controlled Windows runner with
   SimplySign available, strong operator/MFA policy, protected environment, no
   untrusted PR execution, and post-job cleanup; or
3. **Provider signing service:** use its supported non-interactive signing API
   if the purchased certificate/product explicitly provides one.

Never export or commit the private key to this public repository. Do not weaken
the workflow to publish unsigned artifacts while deciding. The certificate
subject and timestamp chain must be asserted on the raw Go agent, embedded
agent, installed Electron executable, uninstaller, and outer NSIS installer.

## 10. Identity and security boundaries

Keep these identities independent:

1. Yaver account and device key;
2. friend/organization Microsoft 365 account and Office activation;
3. GanttSnap Entra application consent, if Graph is used;
4. GitHub/GitLab repository authorization;
5. Codex/Claude/OpenCode/provider authorization on the selected runner;
6. Vercel/Cloudflare/Supabase/Firebase project authorization;
7. Simkab Partner Center publisher administrators;
8. Windows code-signing private key/operator.

Never ask for the friend's Microsoft password, tenant-admin password, Windows
password, or provider token. Use each provider's supported interactive/device
flow and keep tokens on the device that needs them. A runner credential does
not automatically move when runner placement changes; the UI should name the
missing authorization on that exact machine.

PowerPoint documents and screen frames are private workload data:

- use a disposable test deck for automation;
- require explicit local view consent and a separate control consent;
- show a persistent local sharing indicator and immediate revoke;
- bind sessions to owner/access-graph checks plus device public-key auth;
- encrypt media end-to-end across the pass-through relay;
- never log frames, slide contents, auth headers, or document paths;
- do not capture lock/UAC/Winlogon secure desktops;
- expire leases and pairing codes quickly.

## 11. Required product work and acceptance gates

### P0 — friend beta

1. Obtain the GanttSnap repository and record its manifest type, PowerPoint API
   sets, scripts, HTTPS/dev-cert flow, tenant assumptions, and platform claims.
2. Save a project-specific runner/render row with `ganttsnap-windows` as the
   native renderer and run `machine_roles_doctor` before dispatch.
3. Add a PowerPoint project doctor that validates manifest URLs/host/API sets,
   dev certificate, WebView2, PowerPoint discovery, and a real `Office.onReady`
   probe. Detection must reach web/mobile/Electron with named repair actions.
4. Add a deterministic sideload/install/remove route for the selected supported
   beta method; never edit Office caches blindly.
5. Prove runner completion, exact commit/artifact handoff, one reload, one
   semantic Office.js assertion, and one pixel assertion.
6. Prove full-desktop H.264 direct and TURN paths plus authenticated JPEG
   fallback, control revoke, session lock refusal, and wake/reconnect.
7. Use the existing Windows host first. Cloud Windows remains after the BYO
   loop is green.

### P1 — productized PowerPoint lane

1. Add PowerPoint window enumeration/selection and window-scoped capture.
2. Add multi-monitor and presenter-view handling.
3. Build the thin Yaver Developer Bridge add-in only if it shortens the closed
   loop compared with the shared desktop/web dashboard.
4. Add persistent authenticated PowerPoint-on-the-web testing for the Linux
   renderer lane.
5. Add a real macOS PowerPoint matrix if GanttSnap claims Mac support.
6. Add tenant-admin private deployment and rollback guidance surfaced as
   structured actions.

### P2 — public Marketplace

1. Complete Simkab Partner Center verification and program enrollment.
2. Freeze production publisher identity, origins, consent, privacy, terms, and
   support ownership.
3. Run Microsoft validation-preflight across every declared platform and API.
4. Submit GanttSnap; keep the Yaver Developer Bridge private unless it has an
   independent customer value and passes the same review/security bar.

## 12. Go/no-go

**Go for a private friend beta** when the selected runner and Windows renderer
are independently reachable and authorized, a real PowerPoint host loads the
GanttSnap manifest, `Office.onReady` and a reversible API mutation pass, one
post-task reload occurs, the user sees changing PowerPoint pixels through the
authorized stream, and revoke/lock failures are named and recoverable.

**No-go for claiming “Yaver is a published PowerPoint plugin” today.** No Yaver
Office manifest/package exists in this checkout; GanttSnap source was not
audited; current Windows streaming proves a consented full desktop rather than
a selected PowerPoint window; and Partner Center enrollment, Marketplace
certification, and the real signing credential topology are external gates.

The realistic first product sentence is:

> Yaver can develop GanttSnap on any authorized local or remote runner, render
> it in the friend's real PowerPoint on an authorized Windows machine, and
> stream that Windows session to Yaver clients. A thin PowerPoint companion can
> be added later, while the native Yaver agent remains responsible for runners,
> machine control, and WebRTC.
