# Todo · Yaver Serverless

> People need a reliable todo list that keeps their tasks consistent across devices without vendor lock-in

A polished cross-device mobile todo app backed by portable Yaver Serverless with sync-ready task records and local-first interaction.

---

## Stack

- **Mobile** (`apps/mobile`) — React Native + TypeScript via Expo (iOS + Android)
- **Backend** (`yaver.serverless.yaml`, `schema.yaml`, `auth.yaml`, `seed.json`) — portable SQLite-first Yaver Serverless, promotable to your hardware or Yaver Cloud
- **Sync** — optimistic local cache + durable mutation queue over `/data/<slug>/todos`
- **Credentials** — project token entered at runtime and stored in SecureStore; never bundled in source or put in a URL
- **Git** — Yaver Git first, with GitHub/GitLab mirrors only after explicit authorization

## Product defaults

- Problem: People need a reliable todo list that keeps their tasks consistent across devices without vendor lock-in.
- Anonymous project-scoped access; no user-account auth or payments in this phase.
- Unique angle: Local-first interaction backed by exportable Yaver Serverless SQLite data.
- Mobile permissions: none requested at scaffold time

## Configuration

Set the public server base and slug from `.env.example`. Paste the generated `pp_…` project token into the app; it is stored in the native keychain.

## Mobile Workspace flow

- The phone is the control surface.
- The selected primary remote box performs vibing, dependency installation, builds, backend execution, and rendering.
- Yaver Serverless runs as a lightweight host process with portable SQLite—no Docker or external database.
- The UI remains usable offline and drains its durable mutation queue on sync.

## Reproducible validation

```sh
npm ci
npm run typecheck
npm run export:web
```

Project tokens are entered at runtime and stored in SecureStore. This example contains synthetic seed data only and no credentials or personal data.
