# Yaver Desktop GUI: Doctor, Runners, Updates, and macOS TestFlight Audit

Date: 2026-08-16

## Outcome

Yaver Desktop has one task/runtime architecture, not an Electron-only runner:
the signed direct desktop package supervises the same Go agent that powers the
CLI, mobile, web, and remote surfaces. The dashboard inside Electron therefore
uses the existing task APIs, runner selection, raw output streams, review and
completion states, install streams, and cross-device routing for Codex, Claude,
and OpenCode.

The desktop now also exposes a bounded Development Doctor in the Health tab.
It probes real commands and provider identity operations, emits structured fix
routes, and is shared with MCP. It does not parse human error prose and does not
accept arbitrary fix commands.

## Distribution boundaries

| Build | Local Go agent | Local repos/runners/capture | Update owner |
|---|---:|---:|---|
| macOS Developer ID DMG | yes | yes | signed Yaver GitHub release updater |
| Windows signed NSIS | yes | yes | signed Yaver GitHub release updater |
| Linux AppImage | yes | yes | signed Yaver GitHub release updater |
| Linux deb/rpm | yes | yes | Linux package manager |
| macOS App Store/TestFlight | no | no; client connects to a Yaver node | Apple App Store/TestFlight |

The App Store split is deliberate. Apple's mandatory App Sandbox is compatible
with a network client, but not with an honest promise of arbitrary repository
access, CLI spawning, an inbound agent listener, screen capture, and desktop
automation. `process.mas` therefore selects a client-only runtime; the MAS
builder excludes `Resources/bin/yaver`, and the deploy verifier fails if an
agent binary appears in the package.

## Renderer-inventory incident: `sfmg / mobile` on Ubuntu

The failure was not a React Native or Hermes limitation. Split mode fetched the
top-level project list from the render machine, but merged `/repos/list`,
`/projects/mobile`, and `/workspace/apps` from the connected Mac. A failed
render-machine `/projects` request also silently fell back to the Mac. That made
`sfmg / mobile` selectable while a Linux cloud box was the renderer even
though Ubuntu had never reported that checkout.

All inventory legs now route to the selected renderer. An unreachable renderer
clears the picker with a named failure; no connected-box inventory is
substituted. Electron labels its exact local agent identity **This PC** and
offers **Render on This PC**. This does not manufacture a checkout on Ubuntu:
Ubuntu must be reachable and the repo must genuinely be cloned there.

Headless operation proof on 2026-08-16: Ubuntu's authenticated render-routed
`/projects` reported 10 top-level repos; `/projects/mobile` reported 29 mobile
apps including `sfmg / mobile`; and a real `POST /dev/build-native` for that
exact Ubuntu inventory row produced a 10,943,694-byte, 42-file web bundle. The
machine can render SFmg. The failed desktop run was routing/inventory drift,
not an unsupported Ubuntu rendering stack.

## CLI/GUI runner bootstrap

Global `yaver-cli` installs probe and best-effort install the official
`@anthropic-ai/claude-code`, `@openai/codex`, and `opencode-ai` packages on
Windows as well as macOS/Linux, then register Yaver MCP for installed runners.
Interactive desktop installs also fetch the separately signed GUI unless
`YAVER_SKIP_POSTINSTALL_DESKTOP=1`; CI/headless Linux does not. The direct GUI
contains the signed Go agent and exposes the same Doctor install routes. Runner
credentials remain user OAuth/BYOK state and are never bundled. App Store
builds remain sandboxed clients and run these tools on another Yaver node.

## Native diagnostic logging

Electron logs are structured, secret-redacted and bounded: 256 KiB memory
queue, one-second batched flush, 2 MiB files, three files maximum. The tray can
reveal the active log. This covers agent state, renderer/process exits, load
failures, updater errors and lifecycle without turning diagnostics into an SSD
write loop.

## Development Doctor contract

`GET /agent/doctor` returns checks with stable fields:

```json
{
  "id": "flutter",
  "name": "Flutter",
  "status": "warn",
  "detail": "flutter is not installed",
  "section": "development",
  "fix": {
    "kind": "install",
    "label": "Install",
    "method": "POST",
    "path": "/install/flutter",
    "stream": "install:flutter"
  }
}
```

The GUI consumes the route directly, subscribes to the authenticated SSE
stream, shows recent progress, waits for the terminal result event, and rescans.
Configure findings route to the existing Tools/OAuth surface. Provider URLs
open outside the hardened Electron navigation boundary.

### Shared checks

- Codex, Claude Code, and OpenCode installation plus actual runner auth/provider
  readiness from the Yaver agent audit;
- Git, Node, npm/npx, Go, Flutter, Java, Android platform tools, and Docker;
- Vercel, Cloudflare Wrangler, Supabase, Firebase, and Convex CLIs;
- GitHub and GitLab CLIs;
- noninteractive identity operations for GitHub, GitLab, npm, Vercel,
  Cloudflare, Supabase, and Firebase when their CLIs are installed;
- existing OpenAI/GitHub/GitLab machine onboarding state.

### OS-specific checks

| OS | Additional operation probes | Fix policy |
|---|---|---|
| macOS | Xcode and `codesign` | Yaver installers only where implemented |
| Linux | POSIX shell and systemd user-service lane | streamed Yaver installers using detected package manager or managed runtime |
| Windows | native PowerShell, winget, and WSL status | never advertise a Unix installer; use setup/configure routes until a native deterministic recipe exists |

The common matrix is unit-tested for all three GOOS values even when CI runs on
only one host. Unsupported desktop operating systems fail explicitly instead
of spinning.

## MCP parity and safety

MCP advertises:

- `development_doctor`: structured JSON from the same builder as the GUI;
- `development_doctor_fix`: accepts only an exact check ID returned by the
  Doctor.

The fix dispatcher resolves the current check again, requires the Doctor's
`/install/<known-tool>` route, rejects slashes/query fragments, and resolves the
tool only through built-in install plans. It cannot receive shell text. OAuth,
API-key, and browser configuration findings return a user-action route; MCP
does not invent, print, or persist a credential.

## Runner/vibing path

The direct desktop app adopts a healthy agent already listening on port 18080
or spawns and supervises the bundled signed agent. It does not duplicate an
agent. The dashboard then uses the same task transport as web/mobile:

1. choose Codex, Claude, or OpenCode and an available model/provider;
2. create a task on the local desktop node or another owned node;
3. stream raw runner output and structured task state;
4. keep the task alive when the window hides to tray;
5. resume from another Yaver surface and complete/review/delete through the
   shared APIs.

This was operation-probed with OpenCode and DeepSeek V4 Flash before the GUI
loop: `/agent/runners/test` returned `HELLO_DESKTOP_E2E`. The Electron harness
then drives the actual shell and accepts the honest terminal states `review`
or `completed`, completing review before asserting the final task state.

## Keychain behavior

Two distinct stores were causing confusion:

- The Go agent's vault/keychain mirror is disabled for the Electron-supervised
  process with `YAVER_VAULT_SKIP_KEYCHAIN=1`. Runner readiness must therefore
  not open a macOS keychain dialog while remote vibing.
- Chromium secure storage remains OS-protected in a signed production build.
  macOS may authorize that stable Yaver identity once. Only unpackaged browser
  automation uses `--use-mock-keychain` with an isolated profile, and the code
  structurally prevents that switch in packaged builds.

Repeated prompts after installing a newly signed build indicate an unstable or
changed signing identity and are a release-signing failure, not something to
paper over by weakening production storage.

## Native frame and icon

The BrowserWindow keeps the operating system frame, shadow, resize affordance,
and rounded corners. macOS uses the default title bar; Windows keeps the thick
frame and Mica background. The canonical Yaver PNG is used for the live Dock
icon during development, while signed packages use ICNS/ICO/PNG assets.

## Auto-update design

Direct builds use `electron-updater` with a GitHub provider and architecture
channels (`latest-arm64`, `latest-x64`). CI preserves per-architecture metadata,
blockmaps, and AppImage zsync files as release assets so parallel jobs cannot
overwrite one another. Updates default on, check every six hours, download in
the background, and install on quit. The tray and preload bridge can disable
background updates or trigger one explicit check.

The updater is lazy-loaded only in a packaged direct build. It is disabled in
unpackaged development, excluded from MAS behavior, and refuses in-place
replacement of deb/rpm installations. That last case reports “package manager”
instead of falsely claiming automatic installation; AppImage is the self-
updating Linux artifact.

## macOS TestFlight gate

Canonical commands:

```bash
./deploy/deploy.sh desktop-mas --dry-run
./deploy/deploy.sh desktop-testflight --dry-run
```

The build path validates full Xcode, provisioning profile app ID and sandbox
entitlement, package signature, signed app entitlements, and absence of the
embedded agent. Upload additionally requires a clean committed `main`, App
Store Connect API credentials, validation, and a separate explicit upload
action. No TestFlight/App Store state is mutated by build-only or dry-run.

External prerequisites remain: an App Store Connect macOS record for
`io.yaver.gui`, Mac App Distribution and Mac Installer Distribution signing
identities, matching distribution/development profiles, privacy/export
answers, screenshots/metadata, and tester groups.

## Verified gates

- Electron unit suite: frame, keychain boundary, MAS client-only mode, embedded
  agent lifecycle, auth interceptor, updater bridge and opt-out.
- Web TypeScript: Development Doctor types, fetch, progress stream, action
  routing, and compact progressive disclosure compile cleanly.
- Focused Go tests: Doctor platform matrix, installers, runner audit, keychain,
  and relevant MCP/tool coverage.
- macOS deploy wrapper: shell syntax, help, build dry-run, upload dry-run.

The full broad MCP dispatcher coverage test is not a useful bounded gate in its
current form: it invokes every advertised tool and did not terminate during the
audit. That pre-existing harness behavior must be split into schema/dispatch
coverage versus live-operation suites; it was interrupted rather than treated
as a false green.
