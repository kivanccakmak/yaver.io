# Integrate Yaver into an existing app

The executable and tests are authoritative; this page explains the supported
public contract.

## Expo

From the Expo app root:

```bash
npx -y yaver-cli integrate --dir . --framework expo --verify quick
```

For a real browser-bundle proof, replace `quick` with `web`. The command:

1. detects the project's package manager;
2. installs `yaver-feedback-react-native` and Expo-compatible runtime/web peers;
3. adds the SDK config plugin to `app.json` without duplicating string or
   `[plugin, options]` entries;
4. creates `yaver/YaverFeedbackRoot.tsx` with `initExpo()` and one
   `FeedbackModal`;
5. wraps a named default export in `App.tsx`, `app/_layout.tsx`, or
   `src/app/_layout.tsx` without rewriting the component body;
6. verifies Expo config and TypeScript; `--verify web` also exports an actual
   web bundle to a temporary directory and requires `index.html` to exist.

The operation is idempotent. It does not create an app, choose a bundle ID,
configure the app's own authentication, deploy, publish, or change Git state.
An anonymous or otherwise ambiguous default export fails before file mutation
and tells the caller to export a named root component.

The historical commands below route to the same engine for Expo projects:

```bash
yaver expo setup --dir .
yaver feedback setup --dir .
yaver sdk add feedback --dir .
```

## Coding agents

When the Yaver MCP server is loaded, agents should call:

```text
yaver_sdk_integrate {
  "directory": "/absolute/path/to/app",
  "framework": "expo",
  "verify": "quick"
}
```

Use an explicit directory. `quick` proves config and types; `web` additionally
proves the browser bundle. A successful result names every changed/unchanged
file and completed verification. A failed result includes a bounded log tail
and must not be converted into a success based on dependency inventory.

## OpenRouter in an Expo + Convex app

For an application that explicitly uses Convex, the MCP server can add the
paid-model boundary deterministically:

```text
yaver_openrouter_integrate {
  "directory": "/absolute/path/to/monorepo",
  "include_mobile_client": true
}
```

The tool detects either the Yaver starter-session boundary or standard Convex
identity. It writes an authenticated Convex HTTP action, passes OpenRouter's SSE
response directly to React Native/RN-web, and keeps `OPENROUTER_API_KEY` in
Convex environment variables. It does not poll and does not write one Convex
row per token. The default request budget uses one bounded counter row per user
and at most one small mutation per accepted request.

The tool refuses to create the route when neither supported auth boundary is
present. Nonstandard or ambiguous Convex/Expo directories can be supplied with
`convex_directory` and `mobile_directory`; `auth_mode` can be explicit but is
still checked against the code. It installs the secure transport seam, not a
generic chatbot UI; use Yaver Vibing afterward to add job context,
photo/vision inputs, and final answer history. Before production, set provider
credit limits plus Convex usage limits—the in-app request budget is not a
provider-level spend cap.

## Current boundary

The deterministic source-wiring implementation currently supports Expo. Other
SDK packages remain available, but coding agents must not represent their
instructions-only setup as equivalent to the Expo integration proof.

Maintainers can reproduce the uncontaminated external-consumer test with:

```bash
./scripts/test-sdk-integrate-cleanroom.sh
```

It creates a stock Expo app under `/tmp`, uses a fresh `HOME`, performs the web
bundle proof twice, and starts the local stdio MCP directly to verify that its
initialize instructions, tool listing, and integration call work without user
configuration or conversation history.
