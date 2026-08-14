# tvOS local-only coding

Yaver can operate on an Apple TV without a desktop, remote box, OpenCode
server, or Codex process. In this mode the TV app itself:

- stores a DeepSeek (or OpenAI-compatible) API key and least-privilege GitHub
  or GitLab token in the device Keychain;
- keeps a Git workspace in its application sandbox;
- calls the model over HTTPS and permits only read, search, write, status,
  diff, and explicit local commit tools; and
- pushes only a newly created `yaver/local-*` review branch after a separate
  confirmation.

It never gets shell access, cannot run OpenCode or Codex, package managers,
Docker, tests, builds, simulators, deployments, or long-running background
jobs. A task that needs those must be handed off to CI or an available agent.

## Build configuration

The project intentionally keeps phone builds as the default. Generate a clean
TV native project with:

```sh
cd mobile
npm run prebuild:tvos
npm run ios:tvos
```

`EXPO_TV=1` is the build-time switch consumed by `@react-native-tvos/config-tv`.
Do not reuse a native directory generated for a phone build: switching targets
requires the clean prebuild above.

`plugins/with-tv-keychain.js` adds the default keychain access-group entitlement.
Before distribution, sign the tvOS target with the intended Apple Developer Team
and verify the resulting provisioning profile contains that entitlement. In
Settings, local credentials remain disabled unless `expo-secure-store` reports
persistent storage available. This deliberate fail-closed behavior prevents a
Keychain error from leaving a provider or Git credential only in process memory.

## Apple-to-Apple behavior

Device-code pairing signs the Apple TV into the same Yaver account and allows
non-secret preferences and task/run metadata to appear through Yaver/Convex.
Convex never receives model API keys, Git tokens, or Keychain contents.

Apple Keychain access groups share credentials only among signed apps/extensions
on the same device and developer team. They are not a mechanism to transfer an
iPhone secret to Apple TV, and tvOS does not participate in iCloud Keychain
synchronization. AirPlay is display/control transport only and must not carry
credentials. Therefore use one of these explicit configurations:

1. **Standalone TV (implemented):** enter a dedicated, least-privilege DeepSeek
   key and Git token on that TV. Prefer repository-scoped tokens and review
   branches.
2. **Paired-phone execution (future transport):** the TV submits a non-secret,
   user-approved operation to a nearby phone that retains its own credentials.
   This is not standalone operation and requires a native paired-device channel;
   it must never copy raw tokens through Convex or AirPlay.

## Release test gate

Run this on a physical Apple TV before enabling local-only coding in a release:

1. Pair with a phone and confirm account/task metadata appears, without any
   secret shown in Convex.
2. Save and reopen a provider key and a Git token; restart the app and confirm
   the values remain available only through secure storage.
3. Clone a test repository, edit one file, commit, and confirm push creates a
   `yaver/local-*` branch rather than changing the default branch.
4. Request `npm test`, `xcodebuild`, Docker, and a deployment. Confirm the
   model reports them as not executed and does not fabricate an outcome.
5. Suspend/relaunch during a model call and clone/push. Confirm the UI reports
   interruption or retry rather than claiming completion.
