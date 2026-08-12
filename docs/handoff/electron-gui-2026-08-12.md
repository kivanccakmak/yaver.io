# Handoff — Yaver Desktop GUI (Electron) + Web UI Chat/Vibing Audit

Date: 2026-08-12. Session ended with a working, tested Electron shell and a
verified deep audit. This document is the handoff for a fresh session.

## TL;DR — state

- **Electron GUI app exists at `electron/`** and works: `npm install && npm start`
  launches a hardened desktop shell around the real web dashboard. 12/12 unit
  tests pass (`npm test`). Smoke-tested on this Mac (window opens, loads
  `https://yaver.io/dashboard`, redirects to `/auth?return=/dashboard` for a
  fresh profile — expected).
- **Deep audit of web chat + vibing written to**
  `docs/audits/webui-chat-vibing-gui-2026-08-12.md` (every claim verified).
- **User directive (2026-08-12):** the GUI is **sign-in → app only**. No
  marketing/docs/blog/pricing/download surfaces. Implemented as a path
  allowlist (`/auth*`, `/api*`, `/dashboard*`, `/d/*`, `/_next` + OAuth
  provider origins); everything else bounces to the auth gate.
- **Chrome-free login (2026-08-12, follow-up):** the web app no longer renders
  the marketing header/footer on the auth flow or app surfaces at all —
  `web/lib/app-surface.ts` (prefix set mirroring the shell's allowlist) +
  `web/components/Header.tsx` (bare brand bar) + `Footer.tsx` (hidden). The
  login page in the GUI is exactly the auth card (OAuth + email/passkey), no
  Developer FAQ / Docs / Developers / Download / Blog top bar. Landing/docs/
  blog pages keep their full marketing nav.
- **Fixed dead in-page guard (2026-08-12, follow-up):** `did-navigate-in-page`
  called `isAllowedAppPath` without importing it — a swallowed ReferenceError
  let Next.js soft-navigations render `/docs`, `/pricing`, … inside the GUI
  window. The decision now lives in `navigation-policy.js`
  (`inPageNavigationDecision`, unit-tested) and main.js bounces marketing
  soft-navs to the auth gate. 13/13 tests.
- **Project/MCP parity:** the chat composer already restores/saves the latest
  project + MCP choice to the same Convex rows mobile writes
  (`defaultRuntimeProjectByDevice` / `mcpServersByDevice`) and passes
  `workDir` / `mcpServers` / `includeYaverMcp` into task creation — the GUI
  inherits this by rendering the real dashboard. Verified web ↔ mobile share
  the store.

## File map

| Path | What it is |
|---|---|
| `electron/src/main.js` | Main process: window, tray, notifications, deep links, auth-header interceptor wiring, navigation lock wiring |
| `electron/src/preload.js` | Sandboxed bridge: frozen `window.yaver` + DOM observer for task-completion notifications (45s dedupe) |
| `electron/src/auth-interceptor.js` | Pure: strip `?token=`/`?__rp=` from URLs → re-inject as `Authorization`/`X-Relay-Password` headers (the web-only token-in-URL fix, done in the shell) |
| `electron/src/navigation-policy.js` | Pure: sign-in → app-only path allowlist |
| `electron/test/*.test.js` | 12 tests, all green |
| `electron/assets/icon.png` | Generated 512px brand icon (no deps) |
| `electron/package.json` | electron + electron-builder; scripts `start` / `dev` / `test` / `dist:*` |
| `docs/audits/webui-chat-vibing-gui-2026-08-12.md` | The audit (chat, vibing, security, parity, LESS-IS-MORE, verified-claim appendix) |

## How to run / verify

```bash
cd electron
npm install        # already done; node_modules present
npm test           # 12/12 pass — the guard on the two pure policy modules
npm start          # production dashboard (https://yaver.io/dashboard)
npm run dev        # probes http://localhost:3000 first (web dev server), else production
YAVER_DASHBOARD_URL=https://... npm start   # explicit override
```

Note: `npm test` uses `node --test test/*.test.js` — bare `node --test test/`
fails on Node 22 (trailing-slash arg gets treated as a module). Don't "fix"
the invocation to the bare form.

## Design decisions (load-bearing, don't silently change)

1. **Shell, not a fork.** The GUI loads the real dashboard, so chat + vibing
   always match the deployed web app. Never vend an offline copy.
2. **Token fix lives in the shell**, not the web app: `EventSource` can't set
   headers, so the web app passes `?token=`/`?__rp=` in SSE URLs
   (`web/lib/agent-client.ts:6135-6164`). The GUI intercepts every request,
   strips the params, captures per-origin (process-lifetime only, never on
   disk), and injects headers — both already in the agent's CORS allowlist
   (`desktop/agent/httpserver.go:3231`). This is the one place Electron can
   do what a browser cannot.
3. **Security posture:** `contextIsolation: true`, `sandbox: true`,
   `nodeIntegration: false`, `webSecurity: true`, navigation locked
   (`will-navigate` + `will-redirect` + `did-navigate-in-page`), external
   links → system browser, `setWindowOpenHandler` denies all popups.
4. **`/d/` must stay allowed** — the dashboard reaches agents through the
   same-origin `/d/<deviceId>/` proxy when relay-backed
   (`web/app/d/[deviceId]/route.ts`). The navigation-policy test pins this.
5. **Native value-adds:** tray (notifications toggle, reload, quit),
   close-to-tray keep-alive, task-completion notifications via DOM observer,
   `yaver://dashboard?tab=chat|runtime|devices|projects` deep links
   (macOS `open-url` + single-instance argv).
6. **LESS IS MORE:** the GUI adds no status chrome of its own — it renders
   the dashboard as-is, including `StreamHealthNotice`/`RawFailureBanner`.

## Known issues / not done

- **`dist:*` packaging never run.** `electron-builder` config exists but no
  DMG/AppImage/NSIS has been produced or signed. macOS signing/notarization
  for a new app id (`io.yaver.gui`) is untouched — needs the owner's certs
  and the repo's deploy rules (never deploy without explicit permission).
- **Icon is a quick generated PNG** — fine for dev, should be replaced with
  real brand art (`electron/assets/icon.png`).
- **Notifications observer is heuristic** (watches exact-match status text
  nodes, 45s cooldown). It dedupes by status+title and worked in inspection,
  but was not exercised against a real task run — the new session should run
  a real task from the GUI and confirm the notification fires exactly once.
- **The web-app audit findings are NOT fixed** — they're scheduled work in
  the web app (see next section). The GUI deliberately inherits them.

## Next steps (highest value first)

1. **Packaging + real use:** `npm run dist:mac`, install the DMG, sign in,
   run a real task, verify the notification + tray + deep links behave.
2. **Web-app fixes from the audit** (`docs/audits/webui-chat-vibing-gui-2026-08-12.md` §9.6):
   - Delete `taskOutputSuggestsRender` (`web/components/dashboard/RuntimeLabView.tsx:790-794`) — dead code encoding the AGENTS.md-forbidden "infer render from output text" rule.
   - Fix the OSC-8 `javascript:` href XSS (`web/lib/_core/ansi.ts:99` + `web/components/dashboard/AnsiConsoleText.tsx:72-78`) — allowlist `https:`/`http:`/`mailto:`.
   - Mount-or-delete `VibePreviewView` (615-line orphan; tab id declared at `web/app/dashboard/page.tsx:160`, never rendered).
   - Kill the dead `pendingFollowUps` queue (`page.tsx:1086`) + its lying composer copy ("Queue after current run" reads an always-empty array).
   - Port mobile's tested `planPostTaskRender` policy to web so all three web surfaces (RuntimeLabView / PreviewPane / VibeCodingView) agree on post-task render.
   - Web chat raw-console lane + command cards (mobile parity gaps users hit daily).
3. **GUI follow-ups:** sign-in flow verification through a real OAuth provider
   in-window (allowlist includes the provider origins — confirm Google/Apple
   round-trip); consider `titleBarStyle: hiddenInset` on macOS once the
   dashboard chrome is proven stable; decide whether the GUI gets added to
   `yaver.workspace.yaml`.

## Session context worth keeping

- Original ask: "compare yaver with onorca.dev" → then "make yavers gui app …
  check webui code … focus on chat and vibing … deep audit analysis" → then
  "desktop gui app: only signin, no developers/marketing at all — after
  signed in, the app parts".
- No commits/pushes were made (repo rule: never without explicit permission).
- The two explore-agent audit reports (chat, vibing) were synthesized into
  the single audit doc; the doc's appendix lists each verified claim.
