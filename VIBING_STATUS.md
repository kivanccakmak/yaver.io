# Yaver Vibing — deep audit (2026-08-15)

Code is authoritative; this file records the measured incident and the
acceptance invariants that now have product owners.

## Outcome

The selected remote box is healthy and reachable over the public Yaver relay
while Tailscale is logged out. The installed agent answers `/health`, `/info`,
`/tasks`, `/dev/status`, `/project/preview-capabilities`,
`/vibing/preview/status`, and `/stream/webrtc/ice` through the relay. Tailscale
is an optional direct candidate, never a prerequisite.

The production mobile client now passes a cold Chrome/mobile-viewport loop
against that same box and agent v1.99.413: it selects the primary box, reports
`Connected · Relay`, and reads health, info, tasks, projects, runners, dev
status, MCP, and agent status through the free relay. The post-fix cold-start
trace contains zero relay `401` responses. Credentials stayed in process memory
and were neither logged nor written into the repository.

SFMG is detected as Expo/React Native with mobile + web surfaces. On tvOS the
honest render path is:

`SFMG → Expo web sibling → headless Chrome on box → vibe frame session → TV`

The box also reports a WebRTC option. The current native tvOS app ships no
WebRTC decoder, so WebRTC must remain visible-but-unavailable on TV rather than
becoming a black-screen button. Mobile/web may negotiate it independently.

## Why the session hurt

| Failure | False green | Production invariant / owner |
| --- | --- | --- |
| Mac checkout followed a stale GitLab mirror while the box/published agent followed GitHub | Local prototype routes looked current | The GitHub monorepo is the source of truth. Version + route checks precede UI work. |
| The prototype tvOS screen polled `/vibing/frame`, which is not the managed-agent contract | `/dev/status.serving=true` was rendered as “streaming” | Native tvOS uses `/vibing/preview/start` → snapshot/hash → `/vibing/preview/frames/{hash}`. Pixels, not status, are success. |
| Expo was started without the web surface fields | Metro served on 8081, but 8081 was not a browser page | Browser preview starts with `surface=web-reload`, `caller=web-ui`, `platform=web`, then captures the Expo web sibling. |
| A system unit and a user unit both owned the same agent | Heartbeats continued while processes fought over ports | A healthy agent already answering the primary port is reused even under `--debug`; port reclaim must never kill a healthy Yaver holder. |
| A relay service was co-located on an agent-only box and held UDP 4433 | The agent stayed “online” after direct QUIC failed to bind | Agent-only boxes run no local relay. `--no-quic` is a valid relay/HTTP-only mode; failed listeners are never advertised. |
| Repeated Chrome capture attempts accumulated under failure | The UI kept retrying a route that could never work until the kernel OOM-killed services | Capability probes precede launch; preview sessions own bounded capture; clients stop on terminal endpoint errors. |
| Auth completed on disk while the daemon retained expired in-memory state | Device-code page said signed in while `/health` said expired | Successful auth nudges `/auth/reload-from-disk`; the next health probe must be ready before clients claim connected. |
| DeviceProvider fetched relay topology before AuthProvider restored the user | `/config` published the password-gated free relay bare; the first real probe returned `401 relay password missing`, then a later `/settings` pass happened to recover | Relay bootstrap waits for both token and user scope. Only the password-bearing `/settings` result may reach auto-connect; a cold-start test requires zero relay 401s. |
| Browser capability code equated the relay with raw QUIC | RN-web claimed no relay method even though it performs authenticated HTTPS requests through `/d/{device}/…` | `relay-http` is a first-class browser transport. Raw QUIC remains native-only; HTTPS relay proxying is supported on web. |
| Relay passwords were duplicated into query strings even though tvOS can set headers | Requests worked, but credentials could enter URL logs | tvOS sends `X-Relay-Password` only on relay legs; relay URLs contain no credential. |
| Repository name was treated as one app | Talos/Yaver monorepos could only show a generic “monorepo” option | Select repository first, then query `/workspace/apps`; only that repository's runnable child apps remain on screen. |

## Product flow now implemented

1. Dashboard order begins with **Chat**, then **Vibing**.
2. Vibing opens a project picker sourced from the runner box.
3. Selecting a project removes the global list. Monorepos expand only their own
   declared apps from `/workspace/apps`.
4. The app asks `/project/preview-capabilities?surface=tv&probe=true`; it does
   not infer options from a framework label.
5. The options view separates what runs, target viewport, and transport truth.
6. A runnable browser lane opens the existing `WebPreviewStreamView`, whose
   right/bottom control surface keeps `VibeTurnPanel` beside the live pixels.
7. Direct LAN/Tailscale is tried when reachable; the free relay remains the
   off-LAN fallback. Either configuration must pass.

## Mobile connectivity acceptance loop

The lightweight loop is deliberately Chrome-based and uses the real RN-web
bundle, the real account device row, and the real relay HTTP proxy:

1. Start one Expo web server at `localhost:8081`; no simulator is required.
2. Seed only the existing authenticated session into an isolated Chrome
   context; never print or persist its credentials.
3. Begin from empty app storage apart from that session, so relay caches cannot
   hide bootstrap ordering defects.
4. Wait for visible `Connected · Relay` on the primary Ubuntu box.
5. Fail the loop if any `/d/{device}/health` response is `401`, even if a later
   retry connects. Recovery after a self-inflicted auth failure is not success.
6. Require agent endpoints to answer through the relay while Tailscale remains
   optional/off.

Measured before the fix: initial relay health `401`, then recovery after
`/settings`. Measured after the fix: initial relay health `200`, connected over
the public relay, zero relay 401s.

## Remaining truthful constraint

True WebRTC on tvOS is not implemented. Adding it requires a tvOS-compatible
native WebRTC decoder/framework and an end-to-end decoded-first-frame test.
`react-native-webrtc`/Jitsi is not the native SwiftUI app's transport and must
not be represented by a settings toggle. Until that work lands, frames are the
supported tvOS lane and WebRTC is named as available on mobile/web only.
