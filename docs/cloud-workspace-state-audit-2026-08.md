# Cloud Workspace State Audit — durable repos, GitHub/GitLab, Vault, agent credentials (2026-08-09)

Status: read-only audit of `main` against
`YAVER_CLOUD_WORKSPACE_GITHUB_GITLAB_VAULT_PLAN_2026-08-09.md` (the
"durable developer environment attached to disposable compute" plan).
Code is the source of truth; every claim below was re-verified against
files on disk on 2026-08-09. This is the plan's Task-1/§109 output.

## TL;DR

The plan's core product invariant — **the VM is disposable, the workspace
is durable** — is already largely TRUE for the normal same-location path:
the persistent Hetzner volume is mounted as the container's `/root`
(`backend/convex/cloudMachines.ts:323-346`), so repos, the local vault,
git credentials, and all four coding-agent auth files survive park/wake.

A real git + vault + OAuth layer already exists in the Go agent
(`vault.go`, `git_oauth_device.go`, `git_provider.go`, `codex_credential.go`,
`autoHydrateGitCredentialsOnManagedBox`). This is **not greenfield**.

What is missing is the **server-side model**: workspace identity separate
from machine identity, provider-neutral source-control connections, a
server-side encrypted Vault, GOLD checkpoints / cold restore, a git
credential helper, and environment fingerprints. Everything below is
mapped plan-section → reality.

---

## 1. Workspace identity / durable storage (plan §2, §4, §5, §6, §110)

| Plan ask | Reality |
|---|---|
| Durable state survives park/wake | ✅ **Volume = `/srv/yaver/state` = container `/root`.** Repos at `/srv/yaver/state/Workspace`, agent home (vault, git creds, tool auth) all persist. `cloudMachines.ts:229-246, 323-346` |
| Park = delete server, keep volume; wake = reattach | ✅ `pauseMachine`/`resumeMachine` with volume reattach, SKU substitution, same-location-first, transient retry. `cloudLifecycle.ts:1079-1200, 2480-2660` |
| Workspace identity ≠ machine identity | ❌ Machine `_id` IS the workspace. No `workspaces` / `workspaceComputeAttachments` model. Deleting the row destroys everything. No one-writer lease (§4 invariant) |
| Same-location SKU flexibility | ✅ Wake substitutes SKU within cost ceiling (`cloudLifecycle.ts:2530-2564`) |
| Cross-location recovery | ❌ Volume is location-bound. No checkpoint → new-volume restore. Long outage in one DC = unrecoverable (§7, §53, §102) |
| parkMode (deep/standby/reserved) | ⚠️ Field exists (`schema.ts:1637`); "deep" (delete+volume) is default |

## 2. GOLD checkpoint / cold restore (plan §8, §9, §53, §101-102, §119)

| Plan ask | Reality |
|---|---|
| GOLD manifest + archive + hashes + verify | ❌ **No checkpoint system at all.** No `gold.tar.zst`, no manifest, no hashes, no restore verification |
| Symlink / path-traversal safety | ❌ No archive code, so no safety either (§82-83) |
| Backup destination independent of VM | ❌ None. Hetzner snapshot (`lastSnapshotId`) exists only for the legacy non-volume path |
| Dirty-work preservation | ✅ By volume persistence (repos + `.git` on the volume) — but only same-location; no cold path |

## 3. Source control (plan §10-32, §62, §94-95, §111-114)

| Plan ask | Reality |
|---|---|
| Git creds persisted, host-scoped | ✅ `~/.yaver/git-credentials.json` (`{host,username,token}`, 0600) + native `~/.git-credentials` sync. `repos_http.go:22-152` |
| GitHub + GitLab auth | ✅ RFC 8628 device-flow OAuth, public client IDs (vault/env overridable), per-box `git_connect --deviceId`. `git_oauth_device.go:3-70` |
| "Auth once, works everywhere" | ✅ `autoHydrateGitCredentialsOnManagedBox` pulls creds from primary device → fresh managed box (P2P, never Convex). `git_cred_autohydrate.go` |
| Provider abstraction | ✅ `git_provider.go` (1764 lines) + `forge_github.go` + `forge_gitlab.go`, gh-CLI/raw transports, clone/push/PR |
| Provider-neutral connection model | ❌ Flat `host→token`, **one token per host**. No `sourceControlConnections`; no multiple accounts per host; no per-repo binding; no `workspaceRepositories` table |
| `yaver-git` credential helper | ❌ No git credential helper with per-remote routing. Resolution is host-level; multi-remote (fork/upstream across providers) unsupported; no remote-URL sanitization (§62) |
| GitHub App installation identity for git | ❌ Git uses long-lived OAuth PATs, not short-lived installation tokens. Server-side GitHub App minting exists (`githubAppAuth.ts`) but is wired to task/relay intents only |
| GitLab OAuth refresh model | ❌ Device flow yields a PAT; no refresh token, no atomic rotation/lease, no scope discipline (read_repository/write_repository) |
| GitLab self-managed | ⚠️ `forge_gitlab.go` + host field exist; no automatic OAuth app registration (acceptable as beta per §20) |
| Exact-host trust | ✅ Host-exact by construction (no suffix matching) |

## 4. Yaver Vault (plan §33-35, §58-60, §88, §116)

| Plan ask | Reality |
|---|---|
| Encrypted on-device secret store | ✅ `~/.yaver/vault.enc` — NaCl secretbox, Argon2id key derived from auth token, categories (api-key/signing-key/ssh-key/git-credential/custom), keychain interop, rekey, v2 rotation. `vault.go`, `vault_rekey.go` |
| P2P owner-device sync, never Convex | ✅ (`vault.go:24-26` privacy contract) |
| Server-side Vault with envelope encryption | ❌ No Convex vault: no KEK/DEK/keyVersion, no `putSecret/getSecretForAuthorizedRuntime`, no account/workspace/project scopes, no secret-metadata API, no runtime machine authorization |
| Secret least-privilege hydration | ❌ Secrets live as tool-native files on the durable volume — readable by a compromised shell (§59-60). No `/run/yaver-secrets` tmpfs materialization |
| Hydration independent of primary device | ❌ Fresh box hydrates only if the primary device is ONLINE (P2P). A server-side vault would decouple this |

## 5. Coding-agent credential adapters (plan §39-44, §98, §117)

| Plan ask | Reality |
|---|---|
| Codex | ✅ `codex_credential.go` — atomic, expiry-aware, field-preserving rotation of `~/.codex/auth.json` |
| Claude / OpenCode / GLM | ✅ Browser-auth onboarding writes tool-native files 0600: claude `~/.claude/.credentials.json`, opencode `~/.local/share/opencode/auth.json`. `runner_auth_browser_http.go:1333-1400` |
| Survive park/wake | ✅ All on the volume (HOME = /root) |
| Adapter framework (detect/validate/capture/restore/watch/cleanup) | ❌ No framework; no credential-refresh → vault sync loop; no tmpfs hydration |
| One expired agent must not block the workspace | ✅ Per-runner auth state is separate; workspace readiness isn't a single boolean (mobile/web show per-runner status) |

## 6. Machine bootstrap identity (plan §36, §52)

| Plan ask | Reality |
|---|---|
| One-time bootstrap → short-lived machine session | ✅ One-time device code (`brokeredAuth`) + long-lived machine token in cloud-init; machine-token-authed endpoints (`/machine/phase`, `/machine/park-self`, `/machine/tls-*`). `cloudMachines.ts:2255-2261` |
| Workspace-scoped capability list | ⚠️ Session is device-scoped, not workspace/capability-scoped (§36) |

## 7. Environment persistence (plan §49-50, §120)

| Plan ask | Reality |
|---|---|
| Fingerprint / setupRevision / skip-install | ❌ No fingerprint logic, no base-image version on the workspace, no `yaver.yaml` |
| No repeated `pnpm install` on wake | ✅ Outcome holds lazily: `node_modules` + caches are on the volume |

## 8. Park/wake lifecycle (plan §51-52)

| Plan ask | Reality |
|---|---|
| Graceful park (flush, stop accepting tasks, checkpoint, detach, delete) | ❌ Park is an abrupt server delete (volume-backed, so data is safe; in-flight processes/tasks are killed). No flush/grace/checkpoint sequence |
| Idle auto-park + meter | ✅ `autoParkMinutes` (default 20), `/machine/park-self`, `idleSweep`, `meterTick` |
| Wake readiness ladder | ✅ `resumeMachine` → resumeHealthCheck → active (only real agent liveness promotes) |

## 9. UI (plan §63-64, §26, §122)

| Plan ask | Reality |
|---|---|
| Connections / Repositories / Agents pages | ❌ None. Web/mobile show machine lifecycle + ManagedCloudPanel only |
| Workspace health split (storage/compute/sourceControl/agents) | ❌ No such model/UI |
| Repo-selection onboarding | ❌ None |

## 10. Tests (plan §94-102, §129)

| Area | Reality |
|---|---|
| Existing | ✅ `git_provider_metadata_test`, `ops_git_test`, `vault_test`, `vault_rekey_test`, `vault_v2_rotation_test`, `git_oauth_device_test`, `codex_credential_test`, `config_credential_safety_test` |
| Missing (release blockers) | ❌ GitHub+GitLab coexistence, dirty-state park/wake/cold-restore, symlink safety, secret-backup exclusion, cross-location recovery, fresh-user full acceptance (§129) |

## 11. Security observations (plan §58-59, §70-71, §81-87)

- ✅ Host-exact credential matching; vault never reaches Convex; autohydrate is owner-device-only; no account-wide secret inventory API.
- ⚠️ **Largest gap:** a compromised workspace shell can read tool credential files on the volume (Codex/Claude/OpenCode auth.json are plaintext tool-native). The plan's tmpfs least-privilege hydration fixes this; until then, machine compromise ≈ credential compromise.
- ⚠️ Device-flow GitHub tokens are long-lived PATs (no short-lived installation tokens for git).
- ⚠️ Remote-URL sanitation (§62) not implemented — a repo cloned from a token-embedded URL keeps the token in `.git/config`.

## 12. Recommended execution order

1. Workspace identity (`workspaces` + `workspaceComputeAttachments`, volume↔workspace, one-writer guard) — additive schema, unlocks everything.
2. Provider-neutral source-control schema + migrate `git-credentials.json` into `sourceControlConnections`/`workspaceRepositories` (multi-account-per-host), flat-file read for compat.
3. `yaver-git` credential helper (per-host exact routing, clean URLs, no token logs).
4. Server-side Vault (envelope encryption + machine-scoped authorization + GitLab refresh rotation) — security review before prod.
5. GOLD checkpoint + cold restore (symlink-safe, restore-verified) — unlocks cross-location + the §129 acceptance test.
6. E2E soaks: coexistence, dirty state, auth survival, disconnect isolation, secret exclusion.
7. UI last: Connections / Repositories / Coding Agents / workspace health / reconnect states.

## 13. Not verified (no access from this box)

- Prod Convex env values (`CLOUD_PREVIEW_OWNER_EMAIL` / `CLOUD_PREVIEW_OWNER_USER_IDS` — must contain `kivanc.cakmak@icloud.com` for owner-only Hetzner spend; the allowlist is env-configured and fail-closed when unset).
- Live provider state (volume contents, existing boxes).
