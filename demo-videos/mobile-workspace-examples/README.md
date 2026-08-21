# Mobile Workspace todo examples

Credential-free browser recordings and screenshots produced by
`e2e/mobile-workspace-examples.mjs` from the web exports built on the selected
remote development box.

- `backendless-loop.webm` exercises local add, complete, filter, persistence,
  and delete behavior.
- `serverless-loop.webm` exercises the SQLite-first offline queue and the
  project-token configuration route without embedding a token.
- The PNG files are the corresponding completed/offline-first checkpoints.

The loop uses Playwright's full iPhone 15 Pro device descriptor (mobile user
agent, touch, device scale factor, and viewport), not a resized desktop page.
