---
name: yaver
description: Use when a Codex task should set up, inspect, or operate Yaver through the bundled MCP server.
---

# Yaver

Yaver is a local-first MCP server for driving a developer's own machine and paired phone from Codex. Prefer the MCP tools exposed by the bundled `yaver` server over shelling out directly when a matching tool exists.

## First Use

1. Check whether the `yaver` MCP server is available in the current Codex session.
2. If the user has not signed in or paired a device yet, call `yaver_lazy_setup` first. It returns the sign-in or device-code flow that the user can complete from the browser or phone.
3. For a new app, call `project_self_host_create` after setup instead of steering the user to a managed cloud path.
4. For an existing Expo app, call `yaver_sdk_integrate` with the explicit project directory. Do not install a second browser SDK, invent app identifiers, or manually splice JSX when this tool is available. It installs compatible packages, mounts the Yaver UI, wires the Expo plugin, and verifies the project. Use `verify: "web"` when the browser lane matters.
5. When the generated Expo + Convex app needs OpenRouter, call `yaver_openrouter_integrate` at the explicit monorepo root. Use its server-side SSE seam instead of putting the API key in Expo or polling Convex. Add the domain UI through Vibing after the bounded transport is installed.
6. For React Native phone reload issues, call `mobile_hermes_doctor` on the mobile app path and follow its returned next actions.

## Safety

- Do not send source files to a hosted service as part of Yaver setup. Yaver's default loop runs on the user's machine.
- Treat deploy, publish, vault, credential, and destructive workspace actions as sensitive. Use Yaver's own approval and permission gates.
- If MCP tools are unavailable, fall back to the documented command:

```bash
codex mcp add yaver -- npx -y yaver-cli yaver-mcp
```

Then start a fresh Codex session so the MCP server is loaded.

If the MCP server is unavailable but the CLI can run, the deterministic fallback for an existing Expo app is:

```bash
npx -y yaver-cli integrate --dir /absolute/path/to/app --framework expo --verify quick
```
