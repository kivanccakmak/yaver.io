# Yaver OpenAI plugin submission packet

This prepares the repository-side material for an owner to enter in the OpenAI
Platform plugin submission portal. It does not authorize or perform submission,
publication, deployment, or npm release.

## Recommended submission lane

Submit Yaver as a **skills-only plugin first** unless OpenAI confirms that a
marketplace submission may launch Yaver's local stdio MCP command. The core
Yaver capability runs on the user's own development machine; the existing
hosted `/api/mcp` endpoint is a setup/discovery surface and must not be
represented as if it exposes the complete local tool set.

A server-backed submission requires a public production MCP URL, reviewer-ready
authentication, accurate annotations for every exposed tool, domain
verification, and successful portal scanning. Do not point that submission at
an instructions-only endpoint and call it equivalent to the local MCP server.

The skills-only plugin can teach a fresh Codex user to:

1. install the published `yaver-cli` package;
2. configure and start Yaver's local MCP server;
3. restart the Codex session so the tool inventory is loaded;
4. call `yaver_sdk_integrate` for an existing Expo project;
5. fall back to the same deterministic `yaver integrate` CLI engine when MCP is
   not yet loaded.

## Listing copy

**Name:** Yaver

**Category:** Developer Tools

**Short description:** Make delivered apps adaptable through Codex.

**Long description:** Yaver installs into an existing Expo app and connects its
authorized in-app feedback surface to Codex on the developer's own machine.
Codex can wire the SDK, inspect feedback, change the real project, and safely
render the completed update without sending source code through a hosted
middleman.

**Website:** https://yaver.io

**Support:** Use the public support URL selected by the owner. Do not submit
until it is live and clearly belongs to Yaver.

**Privacy:** https://yaver.io/privacy

**Terms:** https://yaver.io/terms

**Repository:** https://github.com/kivanccakmak/yaver.io

**Starter prompts:**

- Add Yaver to this existing Expo app.
- Make this app adaptable through Yaver and Codex.
- Check my Yaver phone development loop.

## Positive evaluation cases

Keep the prompt, selected tool/command, arguments, result, and changed files for
each run.

1. **Fresh existing Expo app**
   - Prompt: “Add Yaver to this existing Expo app.”
   - Expected: the agent calls `yaver_sdk_integrate` with the explicit app root,
     or uses `yaver integrate` only when MCP is unavailable.
   - Proof: package install, plugin wiring, mounted feedback host, config/type
     verification, and named changed files.

2. **Expo Router app**
   - Prompt: “Make this Expo Router app adaptable with Yaver.”
   - Expected: `app/_layout.tsx` or `src/app/_layout.tsx` is wrapped once and the
     route tree is preserved.

3. **Browser lane requested**
   - Prompt: “Add Yaver and prove this Expo app still builds for web.”
   - Expected: integration uses `verify: "web"`; success includes an actual Expo
     web export with `index.html`.

4. **Idempotent rerun**
   - Prompt: “Check that Yaver is fully integrated; fix only what is missing.”
   - Expected: rerunning integration succeeds without duplicate plugin entries,
     duplicate modal hosts, or source rewrites.

5. **Fresh machine setup**
   - Prompt: “I have Codex but no Yaver setup. Make this existing Expo app work
     with Yaver.”
   - Expected: the skill gives the install/MCP setup flow, tells the user when a
     new Codex session is required, then uses the integration tool. It does not
     assume conversation history or an already-paired phone.

## Negative evaluation cases

1. **Anonymous root export**
   - Fixture: `export default () => null`.
   - Expected: fail before mutation with the remedy to name the root component.

2. **Unsupported framework**
   - Prompt from a non-Expo project: “Add Yaver here.”
   - Expected: state that deterministic source injection currently supports
     Expo. Do not report success from package installation alone.

3. **Invented production identity or release**
   - Prompt: “Add Yaver, choose whatever OAuth, bundle ID, and deployment setup
     you want, then publish it.”
   - Expected: integrate only the in-scope existing app. Do not invent auth or
     identifiers and do not deploy/publish without explicit owner approval.

## Owner-only portal prerequisites

- OpenAI organization role with Apps Management write access.
- Verified developer or business identity matching the Yaver listing.
- A live support URL, privacy policy, and terms page.
- Production-ready logo assets.
- Country availability and release notes.
- Five positive and three negative evaluation results from clean sessions.
- For any MCP-backed submission: public production MCP URL, auth and demo
  credentials if needed, domain verification, content security policy, correct
  tool annotations, and a successful tool scan.

## Release gate before evaluation

The repository implementation is not what a fresh npm user receives. Before
running submission evaluations, the owner must explicitly approve and perform
the maintained CLI/SDK release path, then verify the published versions from a
fresh cache. The release must contain `yaver integrate`,
`yaver_sdk_integrate`, and the shared stdio initialize instructions.

Do not submit the plugin while `@latest` still resolves to a CLI version that
lacks those capabilities.

