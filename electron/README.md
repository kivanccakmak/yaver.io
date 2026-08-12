# Yaver GUI (Electron)

A hardened desktop shell around the **Yaver web dashboard** — chat, vibing,
devices, projects, and previews in a native window with tray, notifications,
and deep links. Built from the findings in
[`docs/audits/webui-chat-vibing-gui-2026-08-12.md`](../docs/audits/webui-chat-vibing-gui-2026-08-12.md).

**The GUI is sign-in → app only.** It never shows the marketing web app —
no docs, blog, pricing, download, or any other web surface. Only the auth
flow (`/auth`, `/api/*`, OAuth providers) and the app itself (`/dashboard`,
`/d/<deviceId>/` agent proxy) may render in the window; everything else is
bounced to the auth gate by `src/navigation-policy.js` (unit-tested).

The web app agrees: on the auth flow and app surfaces the marketing header
nav (Pricing / FAQ / Docs / Developers / Download / Blog) and footer are not
rendered at all (`web/lib/app-surface.ts` + `web/components/Header.tsx`,
`Footer.tsx`) — the login page is chrome-free, exactly like the dashboard's
existing `dashboard-mode`. A project / MCP set picked in the chat composer is
shared with mobile through the same Convex rows
(`defaultRuntimeProjectByDevice` / `mcpServersByDevice`), so the GUI's tasks
respect the latest project + MCP choices on every surface.

## Run

```bash
cd electron
npm install
npm test           # 12/12 — auth interceptor + navigation policy guards
npm start          # production dashboard (https://yaver.io/dashboard)
npm run dev        # localhost:3000 when a web dev server answers, else production
```

Env overrides:

| Env | Effect |
|---|---|
| `YAVER_DASHBOARD_URL` | Load this URL instead (https or http). |
| `YAVER_DEV=1` | Prefer `http://localhost:3000` (probed, 1.2s timeout) over production. |

## What it fixes in the shell (not the web app)

The web dashboard passes the bearer token and relay password to SSE streams as
query params (`?token=` / `?__rp=`) because `EventSource` cannot set headers
(`web/lib/agent-client.ts:6135-6164`). On a bare browser that leaks the token
into agent access logs and browser history. The GUI intercepts every request in
the main process:

1. strips `?token=` / `?__rp=` from the outgoing URL,
2. captures the material per-origin (process-lifetime, never written to disk),
3. re-injects it as `Authorization: Bearer <token>` / `X-Relay-Password`
   headers — both already in the agent's CORS allowlist
   (`desktop/agent/httpserver.go:3231`) and used by the mobile app today.

Result: GUI users get header-auth SSE with no token-in-URL exposure, matching
the mobile app's transport.

## Security posture

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  `webSecurity: true` — the preload exposes a single frozen `window.yaver`
  object (platform, versions, `notify`, `setTaskNotifications`).
- Navigation allowlist: only `yaver.io` / `relay.yaver.io` / `cloud.yaver.io` /
  `localhost:3000` may navigate the window; everything else opens in the
  system browser (`setWindowOpenHandler` + `will-navigate`).
- No secrets persisted by the shell; auth lives in the dashboard's own
  `localStorage` / cookie as in a normal browser.

## Native value-adds

- **Task notifications**: a sandboxed DOM observer watches the chat header for
  terminal statuses (`completed` / `failed` / `stopped` / `review`), dedupes
  with a 45s cooldown, and shows a native notification. Toggle from the tray.
- **Tray**: show/hide, reload, notifications toggle, quit. The window hides
  instead of closing (close-to-tray) and the app stays alive so tasks keep
  streaming.
- **Deep links**: `yaver://dashboard?tab=chat|runtime|devices|projects`
  (macOS `open-url` + single-instance argv on Windows/Linux). The dashboard
  already syncs `?tab=` on navigation (`page.tsx:1218-1221`).

## Build / package

```bash
npm run dist:mac    # dmg + zip (electron-builder)
npm run dist:win    # nsis
npm run dist:linux  # AppImage
```

## Known limitations (inherited from the web app)

The GUI renders the dashboard as-is, so it inherits the web-only findings the
audit recorded — the GUI's job is to *surface* them, not hide them:

- Web chat still lacks the raw opencode console lane, command cards, and
  post-task render gating that mobile has (the three parity gaps users hit
  daily). The dashboard's `?tab=` URL only names tabs; the raw-lane work is a
  web-app change, tracked in the audit doc §9.6.
- The 900 ms `onLoad` overlay timer and the green-over-blank "preview live"
  pill are web-app rendering choices; the GUI keeps
  `StreamHealthNotice`/`RawFailureBanner` visible and adds no status chrome of
  its own (LESS IS MORE).
