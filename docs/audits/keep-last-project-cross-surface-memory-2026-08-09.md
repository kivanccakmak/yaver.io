# Audit — Keep-last-project cross-surface memory: two namespaces → one Convex store (2026-08-09)

> **Docs drift; code is the source of truth.** Every `file:line` below was read
> at the commits this document landed on (`ddf56ea15`, `96d9fba9e`). Before
> acting on any row, grep the code again. When this doc and the code disagree,
> the code is the bug.

## 1. The bug class

The "keep last project" feature had two independent, incompatible
implementations and zero server sync:

| | Mobile | Web |
|---|---|---|
| Storage | `@yaver/last_project/v1/<deviceId>` in AsyncStorage | `yaver:vibe-coding:last-project:<deviceId>` in localStorage |
| Key namespace | `@yaver/last_project/v1/` | `yaver:vibe-coding:last-project:` |
| Payload | `{deviceId, name, path, branch, gitRemote, updatedAt}` | `{name, path, branch, gitRemote, updatedAt}` (no deviceId) |
| Keep-toggle key | `@yaver/tasks_keep_last_project` | `yaver:vibe-coding:keep-last-project` |
| Backend | device-local | device-local |

Two different key namespaces + two different storage backends = a project
remembered on the phone is never remembered on the web dashboard (and vice
versa). Switching phone→web lost the last project entirely. The keep-last
toggle was also duplicated across the two namespaces.

## 2. The canonical pattern that already existed

`defaultRuntimeProjectByDevice` — a per-device Convex row
(`backend/convex/schema.ts:1069`) with the privacy-limited fields
`{deviceId, projectName, repoName, gitProvider, gitRemote, branch, framework,
updatedAt}` — **no absolute paths**. Server-side merge is replace-by-deviceId
(`backend/convex/userSettings.ts:329` `mergeRuntimeProjectPreference`), so the
last write for a device wins, regardless of which surface wrote it.

- Write: `POST /settings { defaultRuntimeProjectForDevice: {...} }`
  (`backend/convex/userSettings.ts:645`, `:853`, `:1062`)
- Read: `GET /settings` → `settings.defaultRuntimeProjectByDevice`
- Web helpers existed: `web/lib/runtimeProjectSettings.ts`
  (`runtimeProjectPreferenceFor`, `runtimeProjectIdentityScore`,
  `resolveRuntimeProjectPreference`, `runtimeProjectDefaultMap`)
- Mirrored mobile copy: `mobile/src/lib/runtimeProjectSettings.ts`

The task composers just never used it.

## 3. The fix

### Mobile — `mobile/src/lib/taskComposerPrefs.ts`
- `saveLastTaskProjectToConvex(token, project)` — writes
  `defaultRuntimeProjectForDevice` (privacy-limited: projectName, gitRemote,
  branch). Lazy `await import("./auth")` keeps react-native/expo-secure-store
  out of module scope so the node test (`taskComposerPrefs.test.mts`) stays
  runnable.
- `loadLastTaskProjectFromConvex(token, deviceId)` — reads
  `defaultRuntimeProjectByDevice`, matches by deviceId, returns the row
  (no path — caller matches by name/remote against its live project list).
- Consumers: `mobile/app/(tabs)/tasks.tsx` — send site writes **both** stores
  (`saveLastTaskProject` + `saveLastTaskProjectToConvex`); boot load is
  **Convex-first, local-fallback**.

### Web — `web/lib/runtimeProjectSettings.ts` + `web/components/dashboard/VibeCodingView.tsx`
- `loadLastProjectFromConvex(convexUrl, token, deviceId)` /
  `saveLastProjectToConvex(convexUrl, token, project)` — same wire shape
  (`defaultRuntimeProjectForDevice` / `defaultRuntimeProjectByDevice`).
- `saveLastProjectBoth()` helper writes localStorage + Convex together; all 4
  save sites (task send, project pick, keep-toggle re-enable) call it.
- Boot read is Convex-first (match by tail-name/name), localStorage fallback.

### Rule kept everywhere
A failed settings write NEVER blocks task creation — both helpers swallow
errors, exactly like the pre-existing local-write pattern.

## 4. Related wiring landed in the same pass

- **Goal-mode cross-surface** (opencode goal plugin): `/goal <objective>`
  composer recognition shared via `mobile/src/lib/goalSlashCommand.ts`,
  mirrored in `web/components/dashboard/VibeCodingView.tsx`
  (`goalFromSlashCommand`). The objective travels as the structured `goal`
  field on the task — NOT as a raw runner command — because the agent's
  `<yaver_goal>` wrapper (`desktop/agent/tasks.go:2866`) only fires when
  `!rawRunnerCommand`. Parity test: `web/lib/goalSlashCommandParity.test.ts`
  (19 cases, incl. a mock-fetch Convex round trip).
- **DeepSeek V4 Flash as the opencode default** (user ask 2026-08-09: "our
  default will be deepseek v4 flash"): `DEFAULT_MODEL_BY_RUNNER.opencode` on
  web (`web/components/dashboard/DevicesView.tsx`) and mobile
  (`mobile/src/context/DeviceContext.tsx`), plus the agent's
  `fallbackRunnerModels("opencode")` default
  (`desktop/agent/httpserver.go`). A saved per-device model (user default)
  still wins over this global default.

## 5. Verification (no TestFlight)

All of this is verifiable headlessly / on the real RN-web app without an iOS
build:

1. **Unit**: `cd mobile && npx tsx src/lib/taskComposerPrefs.test.mts`
   (3 tests — local store per-device, Convex degradation, wire-shape markers).
2. **Parity**: `cd web && npx tsx lib/goalSlashCommandParity.test.ts`
   (19 tests — web↔mobile recognizer agreement, surface imports, Convex
   round trip via mock fetch).
3. **Type/build**: `cd web && npx tsc --noEmit`; `cd desktop/agent && go build ./...`.
4. **Live RN-web at a REAL mobile viewport**: the mobile app serves via
   `expo start --web` (localhost:8081). Drive it with
   `e2e/_open-for-user.mjs` (headful Chrome, full iPhone 15 Pro device
   descriptor — `browser.newContext({ ...devices["iPhone 15 Pro"] })`), sign
   in via `YAVER_TEST_EMAIL`/`YAVER_TEST_PASSWORD` (`.env.test` in the repo
   root). For headless runs, inject the agent token into
   `localStorage["yaver.secure.yaver_auth_token"]` (RN-web key via
   `mobile/src/lib/secureStoreCompat.ts`); reference
   `e2e/verify_live_console.mjs` / `e2e/tests/vibe-color-loop.spec.ts`.
   A narrowed desktop window is NOT a mobile context — see AGENTS.md.
5. **Cross-surface proof**: pick a project on the web dashboard (keep-last
   on) → reload the phone app → the same project must restore; and the
   reverse. The Convex row is the memory; localStorage is only the offline
   fallback.

## 6. Testimony

Verified 2026-08-09:
- `npx tsx mobile/src/lib/taskComposerPrefs.test.mts` → 3 pass / 0 fail.
- `npx tsx web/lib/goalSlashCommandParity.test.ts` → 19 pass / 0 fail.
- `cd web && npx tsc --noEmit` → clean.
- `cd desktop/agent && go build ./...` → clean.
- Commits `ddf56ea15`, `96d9fba9e` on `github/main`.
