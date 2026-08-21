# Todo · Backendless

> People need a calm todo list that works instantly without an account or network

A polished offline-first mobile todo app with local persistence, fast capture, filters, and accessible task completion.

---

## Stack

- **Mobile** (`apps/mobile`) — React Native + TypeScript via Expo (iOS + Android)
- **Storage** — device-local AsyncStorage; no account, API, or backend
- **Git** — local repository only until the user explicitly authorizes a GitHub/GitLab mirror

## Product defaults

- Problem: People need a calm todo list that works instantly without an account or network.
- No sign-in, analytics, payments, or network calls.
- Unique angle: Private by default with zero backend and transparent device-local storage.
- Mobile permissions: none requested at scaffold time

## Mobile Workspace flow

- The phone is the control surface.
- The selected primary remote box performs vibing, dependency installation, builds, and rendering.
- App data remains entirely on the device through AsyncStorage.
- The lightweight host workspace uses project-local dependencies; it does not require Docker.

## Reproducible validation

```sh
npm ci
npm run typecheck
npm run export:web
```

This example contains synthetic UI text only and no credentials or personal data.
