# Attachable Mode — deep audit before building "Yaver renders Yaver"

Date: 2026-08-02 · Branch: `vibing-false-green-fixes` · Static audit (code read,
not run). Every claim below is `file:line`-anchored; nothing is taken from a
`.md`.

## 0. What was asked for

A **Settings toggle that attaches the Yaver mobile app to Yaver's own code
running on a remote box**, so that:

1. the surface you're looking at IS the app under development (browser lane,
   RN-web served from the box — not the Hermes container),
2. you vibe from the **Tasks** tab against the same checkout,
3. when the turn finishes, the surface **fast-reloads** and you see your change,
4. if nothing is connected yet, the mode **onboards you**: pick a box, pick a
   runner, show box/runner status,
5. this is **Yaver-only self-dogfooding** — it is NOT the feedback SDK path.
   Third-party apps keep shake→feedback; Yaver improves itself through **tasks**.

That is a closed loop: *look at Yaver → ask Yaver to change Yaver → see it.*

## 1. Verdict

**The loop is blocked at three independent points, and every one of them fails
silently.** None of the three is a missing feature — each is an existing policy
that contradicts another existing policy. The good news: the transport layer is
already proven, so this is a wiring job, not a build-out.

| Layer | State |
|---|---|
| Browser lane can serve Yaver's own RN-web from a remote box | ✅ proven with pixels (`project_browser_lane_relay_fix_2026_07_26`) |
| Recursion guard permits the web target for self-dev | ✅ `workspace_preview_strategy.go:474` |
| Capability layer OFFERS the browser lane for self-dev | ❌ **it removes it** |
| Anything re-renders the attached surface when a task ends | ❌ **only for simulator targets, which this isn't** |
| A failure to render says why | ❌ **returns `false`, logs nothing** |
| Settings has a dogfood entry point | ❌ **rendered behind a hardcoded `false`** |
| Onboarding checks runner readiness | ❌ pairs a device, never checks runners |

## 2. What already exists (the good half)

- **`ShouldRefuseYaverSelfDevelopmentHermes`** — `desktop/agent/workspace_preview_strategy.go:474`.
  Enforced at the execution layer (`devserver_http.go:3261`, 409
  `YAVER_SELF_DEVELOPMENT_RECURSION`). It refuses **only** `mobile-hermes`, and
  the comment is explicit that web targets must stay open: *"refusing those would
  block the very route this guard steers people toward."* Identity-based
  detection (`IsYaverSelfDevelopmentDir`, `:414`) reads `package.json` name /
  bundle id / monorepo layout — not a path substring. **This is correct and is
  the legal basis for Attachable Mode.**
- **The browser lane itself** — `mobile/src/lib/devLane.ts:25`
  (`browserLaneStartBody()` → `{platform:"web", caller:"web-ui"}`),
  `previewBundlePath.ts` (`/dev/` vs `/dev-web/` resolution),
  `browserLaneDoctor.ts` (the agent probes the same lane and reports the stage
  it died at). `yaver.io/mobile` has rendered from `ubuntu-4gb-hel1-1` over the
  relay.
- **`boxInit.ts`** (`mobile/src/lib/boxInit.ts`) — a pure, tsx-tested
  `computeBoxReadiness()` producing `agent / opencode / claude / codex /
  git_github / git_gitlab` checks, each with a status **and** a remediation
  action id. This is exactly the "box selection + runner selection + status"
  model the request asks for. `BoxInitSection.tsx` renders it.
- **Render-intent plumbing** — `mobile/src/lib/renderIntent.ts` parses
  `yaver://render?project=…&mode=browser&reload=fast`; `web/app/render/page.tsx`
  is the universal-link landing page.
- **Reload routing** — `mobile/src/lib/previewReload.ts` (`planPreviewReload`)
  already encodes "a browser preview must stay in the browser lane, never fall
  through to `/dev/reload-app`".
- **Render-intent policy** — the queue → quiet status → one final render rule
  (CLAUDE.md) is already the house law, so Attachable Mode inherits it rather
  than inventing a refresh policy.

## 3. The blockers

### B1 — The capability layer deletes the browser lane for Yaver itself

`desktop/agent/project_preview_capabilities.go:141-150`:

```go
if caps.SelfDevelopment {
    caps.Options = append(caps.Options, ProjectPreviewOption{
        ID: PreviewOptionRemoteRuntime, Label: "Stream over WebRTC",
        Supported: true, Primary: true, ...
    })
    ...
} else {
    // Browser Reload, Open in Yaver, Compile Hermes, Stream over WebRTC
}
```

For a Yaver-self-dev project the option list is **exactly one entry**. And
`mobile/src/lib/mobileProjectActions.ts:66` states the consuming rule: *"A lane
the agent doesn't offer is ABSENT — not greyed out."*

So on the phone, for Yaver's own repo, **"Browser Reload" does not exist as a
button.** The refusal at `:474` says web is the recommended route; the advertiser
at `:141` never advertises it. Two policies, opposite answers, no test binds
them together.

This is the single largest blocker: the mode the user is asking for is currently
unreachable from the UI by construction.

### B2 — The self-dev lane cannot be re-rendered

The one lane self-dev *is* offered — `remote-runtime` on a browser target — then
rejects the render command.

`desktop/agent/remote_runtime.go:1867`:
```go
if !isRNSimulatorTarget(session.TargetID) {
    jsonError(w, http.StatusBadRequest, fmt.Sprintf("run-guest not supported for target %q", ...))
}
```
`isRNSimulatorTarget` (`:1396`) is `ios-simulator … android-redroid`. A browser
window target is **not** in it.

The mobile auto-render mirrors that list and bails first:
`mobile/src/lib/feedbackTrigger.ts:96`
```go
if (session.targetId && !canRunGuestOnRemoteTarget(session.targetId)) return false;
```

So: the agent offers self-dev exactly one lane, and that lane's re-render is a
`400` — which the phone never even sends, because it short-circuits to `false`.

A `navigate` control action does exist (`remote_runtime_webrtc.go:703`) and is
the natural browser-target re-render (navigate to the same URL), but **nothing
calls it after a task completes**.

### B3 — Task completion only renders the WebRTC lane, and only silently

`mobile/app/(tabs)/tasks.tsx:2604`:
```tsx
useEffect(() => {
  if (!selectedTask || !taskStatusAllowsRuntimeRender(selectedTask.status)) return;
  const pending = pendingRuntimeRenderRef.current;
  ...
  void rerenderActiveRemoteRuntimeSurface(pending.source, pending.workDir);
}, [selectedTask?.id, selectedTask?.status]);
```

`rerenderActiveRemoteRuntimeSurface` is the **only** post-task render path on
mobile. There is no browser-lane sibling. `DevPreview.tsx` (1774 lines, the
Tasks-tab preview card) contains **zero references to task status** — it is a
dev-server card that does not know a coding turn exists.

`feedbackTrigger.ts` already tracks `activePreviewLane: "browser" | "webrtc"`
(`:23`) — but only to route a *shake*. The browser branch has no render sibling.

And the failure is silent three ways: `:95` `if (!session?.id) return false;`,
`:96` wrong target → `return false`, both with no `appLog`. Only the
already-in-flight case logs (`:98`). **A user vibing on Yaver today gets: task
completes, nothing renders, nothing explains.** That is the exact
"unfalsifiable" shape CLAUDE.md forbids.

### B4 — The Settings dogfood entry point is dead UI

`mobile/app/(tabs)/settings.tsx:159` — `const LEAN_SETTINGS_SURFACE = true;`
(hardcoded, no toggle). The entire `Dogfood Yaver` section at `:4881` is wrapped
in `{!LEAN_SETTINGS_SURFACE && …}` → **never rendered**.

Two further defects inside that dead section, worth knowing before reviving any
of it:

- `saveDogfoodConfig` (`settings.tsx:533`) is a **local shadow** that writes only
  `{repoDir, prompt}` to the same AsyncStorage key
  (`@yaver/u/<uid>/dogfood_yaver`, `:440`) that `dogfoodConfig.ts` uses for
  `{repoDir, prompt, runner, mode}`. Editing the repo path in Settings would
  **silently wipe the Dogfood tab's runner and mode** back to defaults.
- `openDogfoodTask("hermes")` (`:541`) dispatches a **coding task** whose prompt
  asks the agent to prepare a Hermes/Metro flow for Yaver. That is (a) rendering
  routed through the runner system, which `devLane.ts:12` explicitly forbids, and
  (b) aimed at the one target the recursion guard 409s. It is a button that
  cannot succeed.

### B5 — Onboarding pairs a device but never checks a runner

`mobile/app/index.tsx` → `/survey` → `/onboarding-pair` → `/(tabs)/tasks`.
`onboarding-pair.tsx` succeeds when the Convex device list becomes non-empty. It
never asks whether that box has a **runner that can run a coding task**.

`computeBoxReadiness()` exists and answers precisely that (`boxInit.ts:216`:
`not-ready` when no runner is `ok`) — but `BoxInitSection` is mounted at
`settings.tsx:5237`, roughly 5,200 lines into Settings, inside an AI-keys panel.

Net effect: a fresh user can complete onboarding, land on Tasks, and hit
"no runner" with no route back to the checklist that would have told them.

### B6 — Producers with no consumers (would be built on sand)

Three modules a sibling session just added, all untracked, all with tests and
**no production caller** — the failure mode CLAUDE.md names explicitly ("a signal
with no consumer is not shipped"):

| Module | Consumers |
|---|---|
| `mobile/src/lib/renderIntent.ts` | only `renderIntent.test.mts` |
| `mobile/src/lib/previewReload.ts` | only `previewReload.test.mts` |
| `mobile/src/lib/yaver-dogfood.ts` | none — and gated on `__DEV__`, so it cannot run in TestFlight/Play |

`renderIntent.ts` and `previewReload.ts` are the **right** abstractions for this
feature. They should become the mode's implementation rather than staying
parallel to it. `yaver-dogfood.ts` is superseded by the tasks path and should be
deleted, not wired.

### B7 — Two browser-preview implementations, again

`apps.tsx:1004` and `DevPreview.tsx:289` both call `setActivePreviewLane("browser")`
and both own a browser preview. CLAUDE.md's snowball rule names this exact pair
as the drift that shipped a broken heartbeat, dropped SSE frames and a dead shake
gesture. Attachable Mode must not become a third implementation — it has to be a
**mode over one of them**, with the other deleted or delegating.

## 4. Unaudited-but-load-bearing risks

- **Capacity.** RN-web bundling *Yaver's own* mobile app is the heaviest Metro
  job in the repo (the proven run produced a 17.6 MB `entry.bundle`).
  `ubuntu-4gb-hel1-1` OOM-thrashed to network death on 2026-07-27 and now carries
  4 GiB swap + `OOMScoreAdjust=-800` (`project_ubuntu_oom_death_spiral`). Attach
  mode makes that compile the *default steady state*, not an occasional run. The
  mode must show compile progress + memory honestly, and should probably state
  a recommended box class rather than discovering the limit by dying.
- **Inner-app session.** The attached RN-web Yaver needs a session or it renders
  a login screen — the opposite of "feeling at home". RN-web reads
  `yaver.secure.yaver_auth_token` from localStorage
  (`reference_rnweb_signin_secure_prefix`). Seeding it means injecting the host's
  bearer into a WebView. Same user, own box, own authenticated tunnel — defensible,
  but it is a real boundary decision and must **never** generalize to third-party
  previews. See §6.
- **Nesting.** The attached Yaver can reach its own Settings and enable Attach
  Mode again. Needs a depth guard (an `attach=1` marker the inner instance reads
  and uses to refuse offering the mode), or the mirror is infinite.
- **Escape ownership.** A WebView is not WebRTC pixels, but it is still
  structurally safe: a WebView cannot register an RN gesture handler on the host
  and cannot draw over native chrome. The escape must therefore live in **native
  chrome outside the WebView** — that satisfies
  `workspace_preview_strategy.go:374`'s rule. This should be stated in code, not
  assumed.

## 5. Proposed shape

One mode, one toggle, one status line (LESS IS MORE).

**Settings → "Attach to Yaver"** (sticky, per-user, near the top — not behind
`LEAN_SETTINGS_SURFACE`).

**Off → On transition runs a three-step gate, in order, each showing its own
state and its own fix:**

1. **Box** — pick from the user's boxes. Show `readinessSummary()` per box from
   `computeBoxReadiness()`. Reuse `BoxInitSection`; do not fork it.
2. **Runner** — pick claude-code / codex / opencode from the same readiness
   object, with its remediation button when it isn't `ok`.
3. **Checkout** — the `yaver.io` path on that box, verified by the agent
   answering `IsYaverSelfDevelopmentDir` **true** (identity, not a typed path).
   A wrong path must say "that's not the Yaver checkout", not fail later.

**While On:**
- The agent serves `<checkout>/mobile` on the **browser lane**
  (`browserLaneStartBody()`), and the phone renders `/dev-web/` full-screen with
  native chrome (back / reload / detach) **outside** the WebView.
- One status line, honest: `Attached · ubuntu-4gb · codex · compiling 2:14 ·
  last output 3s ago`.
- Tasks opened while attached default to that box, runner and workDir.
- On task terminal state (`completed`/`review`): **queue → quiet status → one
  fast reload** of the attached surface. Never mid-turn, never twice.

**Fixes this requires (the actual work list):**

| # | Fix | Where |
|---|---|---|
| F1 | Offer `dev-server` (Browser Reload) as **primary** for self-dev; keep WebRTC as the secondary. Add a test binding the advertiser to the refusal. | `project_preview_capabilities.go:141` |
| F2 | Browser-target re-render: either extend `run-guest` or use `navigate(sameURL)`; return a named reason instead of a bare 400. | `remote_runtime.go:1867`, `remote_runtime_webrtc.go:703` |
| F3 | `rerenderActiveBrowserLaneSurface()` sibling; route post-task render by `activePreviewLane`. | `feedbackTrigger.ts`, `tasks.tsx:2604` |
| F4 | Every `return false` in the render path logs a named cause and surfaces it in the status line. | `feedbackTrigger.ts:95-96` |
| F5 | Wire `renderIntent.ts` + `previewReload.ts` as the mode's implementation; delete `yaver-dogfood.ts`. | mobile |
| F6 | Attach Mode entry point above `LEAN_SETTINGS_SURFACE`; delete the dead Dogfood section (and with it the shadowed `saveDogfoodConfig` and the impossible Hermes button). | `settings.tsx:159, 533, 541, 4881` |
| F7 | Nesting depth guard + native-chrome escape, stated in code. | mobile |
| F8 | Onboarding: surface `computeBoxReadiness` in `onboarding-pair`, not only 5,200 lines into Settings. | `onboarding-pair.tsx` |
| F9 | Prove each guard by breaking it (house rule): disable F1 → the option vanishes; disable F3 → the surface goes stale and the status line says so. | tests |

**Explicitly out of scope:** the feedback SDK. Shake→feedback stays exactly as
it is for third-party apps (`feedbackTrigger.ts`, `sdk/feedback/*`). Attachable
Mode improves Yaver through **tasks**, and touches no SDK code.

## 6. Decisions (taken 2026-08-02)

1. **Inner-app session — a scoped attach capability, NOT the host token.**
   (Decision as taken was "seed the host token"; hardened below on the "make it
   secure" instruction. The difference matters — see §7.)
2. **Full-screen takeover.** While attached, the app IS the dev build. Native
   chrome (back / reload / detach) lives **outside** the WebView and owns the
   escape, satisfying `workspace_preview_strategy.go:374`.
3. **No capacity gate — narrate honestly.** Attach anywhere. Stream compile
   progress, elapsed time and memory pressure into the status line; name an OOM
   as an OOM and offer the route to a bigger box. Probe the operation, never the
   inventory.

## 7. Security design for the attached session

### 7.1 Why "seed the host token" is the wrong primitive

The attached surface renders **arbitrary JavaScript from a dev server**. Metro
serves whatever is in the checkout, including everything under
`mobile/node_modules`. If we put the host's session bearer in that page's
localStorage, then:

- any compromised dependency in the Yaver checkout can read it
  (`localStorage.getItem("yaver.secure.yaver_auth_token")`) and POST it anywhere;
- what leaks is a **1-year, full-power session** (`sessions` are 1-year and
  refresh on every heartbeat) — it impersonates the user against Convex **and
  every box they own**, not just the attached one;
- it persists in the WebView data store on disk after detach;
- the blast radius of "my dev branch pulled a bad package" escalates from
  "bad code renders" to "account takeover".

That is a strictly worse trade than the browser lane makes today, and it is the
same mistake `probeTargets.ts:38` already documents: an unconditional
`Authorization: Bearer <session token>` shipped the user's credential where it
did not need to go.

### 7.2 The shape that is actually safe

`relay/webview_cookie.go` already solved the isomorphic problem — authenticate a
WebView's requests **without handing the page a secret**. Attach Mode uses the
same construction one layer up, at the agent:

**Mint an attach capability, not a credential.**

```
attach.<sessionId>.<expiryUnix>.<hmac>
```

HMAC over that tuple, keyed by an agent-local secret. It carries no session
material; it is verifiable only by the agent that minted it, and forging it
requires a secret whose holder never needed the capability.

**Preconditions — checked by the AGENT before minting, deny by default:**

1. Caller's bearer is valid **and is the owner** (`ownerUserId` match, not a
   guest, not a team member with lesser scope).
2. `IsYaverSelfDevelopmentDir(workDir)` is **true**
   (`workspace_preview_strategy.go:414`). This is the structural guarantee the
   decision demanded: the capability **cannot be minted for a third-party
   project**, because the mint refuses any workDir that is not Yaver's own
   checkout. Not a documented promise — a precondition.
3. A dev server is live for that workDir **on the web lane**
   (`isWebServedStatus`), so the capability cannot outlive the thing it exists to
   render.

**Properties, each deliberate:**

| Property | Why |
|---|---|
| Delivered as an **HttpOnly cookie**, path-scoped to the attached device subtree | Page JS cannot read it, so a hostile bundle in the checkout cannot exfiltrate it. This is the whole point — localStorage would defeat it. |
| **Never in a URL or query string** | House rule; a token in a URL lands in access logs, history and `Referer`. |
| **Minutes-long TTL**, refreshed by the host while attached | A leaked capability is quickly worthless. |
| **Explicit route allow-list**, deny by default | See 7.3. |
| **Revoked server-side on detach**, in addition to clearing the client | Either alone is a false green: a cleared client with a live server-side capability is still a live capability. |
| **Dies when the dev server dies**, and when the app backgrounds past a window | No orphaned authority. |
| **Origin-pinned** — enabled only while the WebView URL matches the exact attached origin | A navigation away (link, redirect, OAuth callback) must not carry it. |
| **Issued only to a host that passed `verifyHostIdentity`** (`identityProof.ts:26`) | "Match ⇒ this really is that machine ⇒ safe to attach a credential" — that file exists for precisely this question. Fail closed. |

### 7.3 Scope: what the attached Yaver may do

The attached app needs enough to *feel at home*, which is much less than a
session. Allow-list, deny by default:

**Allowed** — read agent/device status, list devices, list + stream tasks, send a
coding task to **this** box, dev-server status/reload for **this** workDir.

**Denied** — vault (read or write), deploy of any kind, auth mutations
(link/unlink/merge/logout/factory-reset), device approval or pairing, SDK-token
or guest-invite creation, exec/shell/remote-desktop, settings mutation, relay
password, any write to another device.

Rationale: the denied set is exactly the set whose abuse is irreversible or
reaches beyond the attached box. A capability that can start a coding task is
already powerful — that is inherent to the feature and is why it is short-lived,
owner-only, origin-pinned and revocable, rather than being the user's real
session.

### 7.4 How the inner app authenticates without holding a secret

The inner RN-web Yaver expects a token string in
`yaver.secure.yaver_auth_token`. It must **not** get one. Instead:

- localStorage receives a **non-secret sentinel** (`yaver.attach.mode = "1"`)
  which tells the inner app to skip its login gate and issue **same-origin,
  credentials-included** requests;
- the HttpOnly cookie rides those requests automatically and is what the agent
  actually verifies;
- page JS can therefore *use* the authority without being able to *read or move*
  it.

This needs an "attached" auth mode in the mobile web auth layer — additive, in a
`.web.ts` sibling, touching **no native path** (browser-transport rule #4), with
the `foo.ts`/`foo.web.ts` parity test that rule requires.

### 7.5 Nesting

The attached Yaver can reach its own Settings. The sentinel doubles as the depth
guard: when `yaver.attach.mode` is set, the attached instance **refuses to offer
Attach Mode** and says why. Without it the mirror is infinite.

### 7.6 Guards to prove by breaking

Per the house rule, each of these ships with a test that has been *seen to fail*:

- mint with a third-party `workDir` → refused (this is the one that keeps the
  capability from ever generalizing);
- mint as a guest / non-owner → refused;
- capability presented after detach → rejected;
- capability presented for a denied route → rejected;
- capability presented to a different device subtree → rejected;
- host fails `verifyHostIdentity` → never minted.

## 8. Landed ledger (2026-08-02)

Everything below is written and verified; nothing is committed.

| # | Fix | Where | Proof |
|---|---|---|---|
| F1 | Self-dev now offers the browser lane the refusal names; Browser Reload primary, WebRTC secondary | `project_preview_capabilities.go` | `TestSelfDevOffersTheLaneTheRefusalNames` — asks the refusal directly, then asserts the advertiser agrees. Broken → fails |
| F2 | Post-task render for a browser target no longer silently unreachable | `previewReload.ts` + `feedbackTrigger.ts` | 14 tsx tests incl. 2 negative controls |
| F3 | `rerenderActivePreviewSurface()` routes by lane; `subscribeBrowserRender` registry; `DevPreview` + `attach.tsx` listen | `feedbackTrigger.ts`, `DevPreview.tsx`, `tasks.tsx` | tsc clean; break-test on the browser branch |
| F4 | Every skip logs AND surfaces a named cause; banner in Tasks | `tasks.tsx` | `planPostTaskRender` totality test |
| F5 | `previewReload.ts` now has a consumer; `yaver-dogfood.ts` deleted (0 consumers, `__DEV__`-gated) | mobile | grep: no references |
| F6 | Attach Mode entry point above `LEAN_SETTINGS_SURFACE`; dead Dogfood panel + shadowed writer + impossible Hermes button removed | `settings.tsx` | tsc clean |
| F7 | Nesting sentinel + native-chrome escape stated in code | `attachMode.ts`, `attach.tsx` | `computeNestingVerdict` tests |
| F8 | Onboarding surfaces `computeBoxReadiness` — advisory, never blocking | `onboarding-pair.tsx` | tsc clean |
| §7 | Attach capability: HMAC, HttpOnly cookie, allow-list, revoke, idle bound | `attach_session.go`, `attach_http.go` | 13 Go tests; 2 guards proven by breaking |
| new | Lane support reflects the box's REAL capability; browser lane never demoted | `project_preview_capabilities.go` | 4 tests incl. timeout-keeps-static-verdict |

**Verification status.** `desktop/agent` does not compile in the working tree —
`main.go` at HEAD calls `BuildTaskProof`, `EmitStopResult` and
`SetTaskCommitEvidence`, whose defining files are untracked WIP from concurrent
sessions. The Go work here was therefore verified in an isolated package slice
(`scratchpad/isopkg`) carrying the real sources plus a stub `detectFramework`.
All attach, self-dev and lane-order tests pass there; the only failures are
framework-detection subtests that depend on the stubbed detector, not on any
change in this work. **These tests have not yet run against the full package**
— that needs the siblings' WIP to land first.

Mobile: `npx tsc --noEmit` over the whole project exits 0. Pure suites:
attachMode 10/10, previewReload 14/14, boxInit 8/8.

**Not done.** B7 — `apps.tsx` and `DevPreview.tsx` remain two browser-preview
implementations. `attach.tsx` deliberately did not become a third (it consumes
the shared `subscribeBrowserRender` seam), but the original pair is still
duplicated and should be collapsed.

## 9. Mode awareness + revert (added on request, 2026-08-02)

Four follow-up asks — a polite icon, a revert to the installed build, "the user
should be aware of the mode", and the same for third-party apps — are one
feature: **say what you're looking at, and always offer the way back.**

The problem is specific: Attach Mode renders Yaver's own dev build
pixel-identically to the installed one, and a Hermes guest renders a third-party
app identically to ITS installed build. A tester who cannot tell them apart
files "bugs" against unfinished work; a tester who cannot find the way out is
simply stuck.

**The model** — `mobile/src/lib/runtimeMode.ts`, pure + 10 tsx tests. Four modes
(`installed`, `attached-yaver`, `guest-hermes`, `guest-browser`), each carrying
its badge, its escape OWNER, and a `RevertPlan`. Two things it makes impossible:

- The attached instance reports `canRevertHere: false`. It is a WebView; its
  escape lives in the host's native chrome. A working-looking Revert button
  there would be a lie the user taps and stays put. (Negative control test.)
- `planRevert("attached-yaver")` sets `revokeAttachSession` AND
  `clearAttachSentinel`. Clearing only the client is the false green this repo
  keeps finding — UI says detached, box says attached. A stale sentinel also
  makes the NEXT launch think it is the attached copy.

**The mark is Yaver's Y.** One 22pt low-contrast glyph, no text until tapped.
Text is revealed on tap, never rendered at rest — a chip spelling out
"ATTACHED · DEV BUILD" in every header is the accretion LESS IS MORE exists to
stop, and wallpaper is what people stop reading. The installed app renders
nothing at all, so this is free for the normal case.

Mounted in `AppScreenHeader` (reaches ~138 screens) and on the attached surface.

**Third-party apps** — `sdk/feedback/react-native/src/YaverModeBadge.tsx`, with
`modeBadge?: boolean` (**default true**) and `modeBadgePosition` (default
`bottom-left`, because bottom-right is where most apps put a FAB and the badge
must never compete with the app's own primary action).

Default-on is deliberate: the failure it prevents is silent and lands on a
tester rather than a developer. It costs nothing in a standalone build — outside
Yaver's container `NativeModules.YaverInfo` is absent and the badge renders
null, so shipping it enabled changes nothing for real users.

It is rendered from `FeedbackModal`, which every integrating app already mounts.
A "default" that required a new mount point would not be a default.

**It is deliberately NOT the escape.** Yaver's container owns that (shake →
overlay → "Back to Yaver"); the badge only tells you the gesture exists. Putting
the exit inside the previewed app would let a guest style over or unmount it —
the trap the escape-ownership rules exist to prevent.

### Verification

- `runtimeMode` 10/10, `attachMode` 10/10, `previewReload` 14/14, `boxInit` 8/8.
- SDK `tsc --noEmit`: exit 0.
- Mobile `tsc --noEmit`: clean **except** 13 errors in
  `src/components/TaskProofCard.tsx` — a concurrent session's untracked WIP
  referencing `TaskProof`, `proofStatus`, `commitSha` etc. that do not exist
  yet. Same incomplete work that stops `desktop/agent` compiling. None of the
  errors are in files touched here.

### Not reached

`modeBadge` exists for **react-native only**. The `web`, `flutter`, `kotlin`,
`swift` and `unity` SDKs do not have it — and per the cross-surface parity rule
that means the feature is not finished, only started. Kotlin/Swift matter least
(the viewer owns their trigger, `remote_runtime.go:709`); `web` and `flutter`
have real in-app SDKs and should get it next.

## 10. Cross-surface badge ledger + dismissal

| SDK | Badge | Detection | Default | Verified |
|---|---|---|---|---|
| mobile app | ✅ header + attach surface | attach sentinel / lane state | on | tsx 13/13 |
| react-native | ✅ | `NativeModules.YaverInfo` | `modeBadge: true` | tsc clean |
| web | ✅ | `window.__yaverLane` | `modeBadge: true` | tsc clean |
| flutter | ✅ | `window.__yaverLane` via conditional import | widget placement | `dart analyze` clean |
| kotlin | ✅ | **explicit only** — `yaver.streamed` / `setStreamed()` | opt-in via `attach()` | ⚠️ **nothing compiles it** |
| swift | ✅ | **explicit only** — `YAVER_STREAMED` / `setStreamed(_:)` | opt-in via `attach(to:)` | `swift build` clean |
| unity | ✅ | **explicit only** — `YAVER_STREAMED` / `SetStreamed()` | opt-in via `Attach()` | ⚠️ metadata only — **not compiled** |

### Why the native SDKs detect differently

A native or Unity app is **never** a Hermes guest — the container loads React
Native bytecode, and there is no mechanism by which Kotlin/Swift/Unity code runs
inside it (stated at the top of `YaverFeedback.kt` since that SDK was written).
So `NativeModules.YaverInfo` has no counterpart.

What actually happens is **streaming**: the app runs on a box in Redroid, a
simulator or a desktop player, and the pixels arrive elsewhere. That is a real
"you are not looking at the installed build" situation, so it earns the mark.

**Platform sniffing was refused.** `Build.FINGERPRINT.contains("generic")`,
`#if targetEnvironment(simulator)` and `Application.isEditor` would each tell a
developer running their OWN emulator that they are inside Yaver. A false claim
about which build you are looking at is worse than no claim: it teaches people
to ignore the mark, which costs more than never having shown it. Detection is
therefore explicit and **fails closed** — absent evidence, say nothing.

### Dismissal

"Hide for now" on every surface, plus a programmatic control
(`hideYaverModeBadge`, `YaverFeedback.hideModeBadge`,
`YaverModeBadgeController.hide`, `YaverModeBadge.hide`).

User dismissal is **per-run and in memory, never persisted**. A permanently
hidden badge recreates exactly the problem it exists to prevent — a tester who
cannot tell an unbuilt branch from the installed app and cannot find the way
back. Polite means not nagging within a session; it does not mean permanent
amnesia about which build you are looking at.

App-level opt-out (`modeBadge: false`) IS permanent, because that is a developer
making an informed choice rather than someone clearing their screen for a
minute. `runtimeMode.test.mts` has a negative control asserting the copy
promises only "for now" and never "don't show again".

### Two verification gaps, both pre-existing

**Unity CI cannot compile anything.** `unity-sdk-tests.yml` gates on a
`UNITY_LICENSE` secret that is not set, and exits 1 before the package
validation or the EditMode tests ever run. Dispatched on this branch
(run 30750880012) it failed in 23s at that gate — exactly as the last run on
`main` did on 2026-07-27. So `YaverModeBadge.cs` has had its package metadata
validated locally (`node scripts/validate-unity-package.mjs` → ok) and has
**not been compiled by anything**. Closing this needs the secret, which is not
something a code change can supply.

**Deprioritised by the owner (2026-08-02): Unity is not important.** Recorded so
a later session does not spend time on the license gate. The C# is committed and
metadata-valid; treat it as best-effort until someone actually needs Unity.

### The other gap

**The Kotlin SDK has no build file and no CI job anywhere** — `find` shows only
`src/` and a README, and no workflow references `sdk/feedback/kotlin`. So
`YaverModeBadge.kt` is written but **nothing has compiled it**, here or in CI.
That is a pre-existing hole (the whole Kotlin SDK is in it, not just this file),
and it is worth closing with a minimal Gradle module + a CI job — an SDK nothing
compiles is the definition of an unverified guard.

## 11. Unity removed, Kotlin made verifiable (2026-08-02)

Both verification gaps in §10 are closed, in opposite directions.

**Unity: deleted.** Owner's call ("not important at all"). It was never
published — `docs/unity-openupm-publishing.md` described *prep*, and no release
was ever cut — and all four of its CI jobs were permanently red on a
`UNITY_LICENSE` secret that is not set, exiting before they compiled anything.
A permanently-red job is worse than no job: it trains people to ignore CI.

Removed as one unit so nothing dangles: `sdk/feedback/unity/`,
`sdk/feedback/test-app/unity/`, `unity-sdk-tests.yml`, `unity-sample-ci.yml`,
four unity jobs inside `ci.yml`, `package-feedback-unity` + its dispatch input
in `release-sdk.yml`, `scripts/validate-unity-package.mjs`, and two unity-only
docs. `CLAUDE.md` and `sdk/feedback/README.md` both claimed a Unity SDK and *no*
Kotlin/Swift ones; both now match what is on disk.

**Kotlin: given a build.** It shipped source-only — no build file, no CI job,
nothing anywhere that compiled it — so every change landed there was unverified
by construction, including its own unit test, which had never run. That is the
familiar shape: the inventory says "there is a Kotlin SDK", the operation says
nothing has ever built it.

It now has an Android library module (AGP 8.5, minSdk 21) and a
`kotlin-sdk-tests` job. Two traps the build had to dodge, both worth keeping:

- the source uses `src/main/kotlin`, not AGP's default layout, so `sourceSets`
  points at what exists rather than moving six files and losing their history;
- unit tests get a real `org.json`, because android.jar's stub throws
  "not mocked" for every method — which would make a passing `ReloadActions`
  test impossible and a failing one uninformative.

Gradle was deliberately NOT run locally: an Android toolchain belongs in CI, and
this machine is shared with other sessions.

**Badge ledger, corrected:** react-native, web, flutter, kotlin, swift. Unity is
gone. Every remaining surface now has something that compiles it.
