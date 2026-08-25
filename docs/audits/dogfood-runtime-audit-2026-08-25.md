# Reusable Dogfood runtime audit

Date: 2026-08-25. Code, tests, and native hosts were re-read; older Markdown
claims were treated as historical context only.

## Result

The reusable React Native SDK now owns a single explicit Dogfood lifecycle and
lane policy. Yaver mobile consumes the same policy for self-development.

| Project class | Browser | Hermes | WebRTC |
|---|---:|---:|---:|
| Expo / React Native | yes, default | yes | when an enabled native target is measured |
| Flutter | yes, default | no | when an enabled native target is measured |
| Web frameworks | yes, default | no | when an enabled native target is measured |
| Native-only Swift/Kotlin | no | no | when an enabled native target is measured |

WebRTC is intentionally capability-gated: showing it from a framework label
without an executable target would recreate the “inventory says yes, operation
says no” failure. Browser is similarly limited to browser-capable stacks.

## Findings fixed

1. `DogfoodController` stored every attempt's cleanup in one array. An obsolete
   async attempt could finish after Stop + Retry and tear down the replacement
   attempt's session. Cleanup ownership is now generation-scoped, with a race
   regression test.
2. `P2PDogfoodDriver` treated Hermes delivery as a long-lived dev server and
   registered `/dev/stop`. Stopping that one-shot lane could kill an unrelated
   browser preview. Only the browser lane now owns that cleanup.
3. Yaver self-development was still rejected for Hermes in the Go execution
   layer and again in mobile composition. That policy was stale: iOS owns the
   escape in `AppDelegate.swift` and Android owns guest unload/recreation in
   `YaverShakeDetectorModule.kt`, both outside guest JS. The duplicate refusals
   are removed and parity is source-tested.
4. The browser Vibing overlay already had independent runner/render device
   routing and runner/model selection, but Dogfood entry could only imply a
   primary machine and WebRTC did not mount the overlay. Entry now exposes
   Device → Runner → Model → Runtime, and browser/WebRTC mount the same live
   overlay.
5. Reload was common but visually secondary and labelled Full Reload. The
   floating action adjacent to Vibing is now Fast Reload; Full Reload remains a
   progressive-disclosure operation where a surface supports it.
6. The SDK full-suite identity test repeatedly replaced virtual Expo/native
   modules after module loading. It passed alone and failed by suite order. Its
   mocks now expose mutable module state installed once, making the harness
   deterministic (169/169 tests pass in one serial run).

## Operational contracts retained

- Browser/Hermes/WebRTC start only after explicit user selection; importing the
  SDK creates no runtime or network work.
- Every failed start carries a stable code, remedy, retryability, and optional
  same-checkout AI-fix prompt. Failed partial browser entry revokes its minted
  attach capability.
- Hermes delivery counts as success only when the native target reports actual
  delivery; compilation alone is not green.
- Runner and model preferences are per device. Browser/WebRTC settings keep
  runner and render devices independent.
- Auth boundaries are unchanged. No lane adds wildcard CORS, URL credentials,
  relay authorization, or cross-account discovery.
- Validation is serial on the 8 GB Mac. Browser contexts, simulators, and an
  archive are never started concurrently.

## Verification

- SDK Dogfood controller/driver tests cover lane policy, explicit start, cleanup
  race, retry, handoff, event streaming, and browser-only `/dev/stop` ownership.
- Go tests cover capability composition, execution routing, third-party RN
  parity, and both native Yaver escape implementations.
- Mobile contract tests cover all three Yaver lanes, device switching,
  runner/model controls, overlay mounting, native WebView escape, and Fast
  Reload adjacency. TypeScript checks the integrated surfaces.
- The guard is also exercised with a negative control before release: break the
  asserted native escape marker, observe the parity test fail, restore it, and
  rerun green.

The remaining closed-loop proof is the release operation itself: archive and
upload one iOS build through `./deploy/deploy.sh ios`, then exercise Browser,
Hermes, and WebRTC from that TestFlight build against a same-account device.
