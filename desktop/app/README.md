# desktop/app — LEGACY / UNSUPPORTED (do not use)

**Status: frozen.** This Electron renderer tree is **not built, not packaged,
and not shipped** by any release path (`deploy/`, `scripts/`, CI). It was
superseded by the canonical desktop GUI in [`electron/`](../../electron) —
the hardened shell around the web dashboard with sandboxed renderer, context
isolation, navigation allowlist, scoped auth interception, bounded logs, and a
direct-versus-MAS capability split.

Why it is frozen (audit: `docs/audits/macos-gui-desktop-code-audit-pass-2-2026-08-19.md`):

- Exposes bearer tokens to renderer JavaScript and through a preload bridge
  with **no trusted-origin gate** (the bridge survives any navigation of the
  main window).
- Generic `agentRequest`/`convexRequest` IPC lets the renderer call any
  authenticated route.
- OAuth callback on `127.0.0.1:19836` accepts any `?token=` with no state/nonce.
- `shell.openExternal` accepts arbitrary renderer-controlled URLs.
- Device URL construction (`connectToDevice`) has no host/port validation.
- Startup can fail before `ready-to-show` without showing a cause.

**Do not resurrect this code.** If a capability seems missing from
`electron/`, build it there — the security boundary of the new client is
deliberate and load-bearing. This tree is retained only as reference material
and must never be re-added to a release/install path.
