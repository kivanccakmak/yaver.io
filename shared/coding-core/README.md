# Shared coding runtime contract

All Yaver surfaces use the same runtime vocabulary:

- mobile: remote agent or local file/Git/LLM runtime;
- web: remote/cloud client or constrained browser workspace;
- desktop GUI: full local shell/sandbox plus remote agent;
- watch/car: status, voice, stop/retry, and approval routing;
- TV: status/review display plus an optional app-sandbox local Git/LLM mode;
- XR: rich review/edit client when the platform supports storage.

Watch and car must never receive provider or Git tokens. They send
validated commands to the phone, web, desktop, cloud, or CI runtime.

## No remote runtime

When no desktop agent, cloud worker, CI runner, or Android shell bridge is
reachable, use `OFFLINE_ONLY_CAPABILITIES` from `runtime.ts` as the hard gate.

- Phone: can use its configured direct model API and local Git workspace to
  edit, commit, and push a review branch. It cannot run OpenCode, Codex, a
  shell, Docker, package managers, tests, native builds, or deploys.
- Web: can only preserve a draft/browser workspace; it is not an execution
  fallback.
- Apple TV: a signed build with working device Keychain storage may use a
  device-local provider key and a least-privilege Git token to edit, commit,
  and push a review branch. It cannot run OpenCode, Codex, a shell, Docker,
  tests, builds, or deploys. If secure storage is unavailable, it must refuse
  credentialed local work rather than retaining a secret in memory.
- Watch, car, and XR: can only draft or display queued work. They never
  execute a model, hold provider/Git credentials, or claim test/build results.

## Configuration and credentials

Convex stores only non-secret choices such as runtime kind, runner ID, model,
reasoning effort, task status, and Git branch/commit metadata. It must never
store an API key, OAuth token, Codex/OpenCode login state, Git token, or device
secret. The phone keeps local-provider and Git credentials in its secure store;
desktop and workers keep theirs in their local secret stores. Companion devices
configure a task by sending the chosen non-secret fields to that credential-owning
endpoint, never by receiving or relaying a secret through Convex. Apple TV
does not receive iCloud Keychain secrets from an iPhone: it either uses its
own device-local credential or routes an approved operation to a paired phone.

## Validation truthfulness

All surfaces use `validation.ts` terminology. Phone and Apple TV local mode can
run a deterministic **static preflight** (merge-conflict scan, JSON config
parsing, and Git change summary), but must show `compiled: false` and
`tested: false`. Desktop/CI can report compile or test results only after they
actually execute those commands. Web, watch, car, and XR show the selected
executor or `not-available`; they must not turn an inspection result into a
green build.
