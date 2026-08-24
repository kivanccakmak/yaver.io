# Mobile leanness and appearance audit — 2026-08-24

This audit is code-grounded. The source files named below are authoritative;
line counts are a size signal, not a quality score.

## Decision

Yaver remains **dark by default** on a new or legacy-unset surface. Light is an
explicit opt-in. The preference is not account-global: Convex can store one
`light|dark` row for each client family (`mobile`, `web`, `tvos`, `androidtv`,
`watchos`, `wearos`, `visionos`, `carplay`). A local cache paints immediately
and keeps offline startup usable; the signed-in Convex row reconciles it.

CarPlay is the deliberate exception to manual application: its voice template
continues to follow the vehicle/system day-night appearance for driver safety.
The backend reserves the `carplay` row so a future Apple-supported preference
can use the same contract, but Yaver must not fake that support by recoloring a
phone view while the real `CPVoiceControlTemplate` remains system-controlled.

Dark is the least surprising factory value because every existing Yaver client
already starts dark, much of the product is terminal/preview work, and TV/watch
use benefits from low glare. Defaulting existing users to light would be a
breaking visual migration and would add a cold-start flash unless every native
splash and pre-hydration path changed atomically.

## What is already lean

- The bottom bar exposes only Tasks, Projects, and More. The many routed tools
  in `mobile/app/(tabs)/_layout.tsx` are hidden destinations, not peer tabs.
- More intentionally omits a duplicate page hero and keeps diagnostics and
  preferences one tap deeper.
- Experimental/hardware entries are preference-gated, and owner-only tools are
  separately permission-gated.
- Appearance is one compact two-choice control in Settings. It is not repeated
  on Tasks, Projects, or More.
- The audit's palette scan found auxiliary dark-only chrome in Voice Test, the
  global feedback panel, and the Projects/Vibing overlay; those now consume the
  shared theme tokens. Pure content canvases (camera/video/remote desktop),
  terminal/code blocks, the branded launch splash, and the fatal error boundary
  deliberately retain black/dark presentation because black is content
  framing or an emergency fallback there, not app appearance.

## Main leanness debt

1. **Screen files are acting as subsystems.** At audit time Tasks was about
   10.4k lines, Settings 5.9k, Apps/Projects 4.4k, and More 3.4k. This increases
   regression radius and makes cross-surface parity harder to see. Split by
   feature boundary, keeping route files as orchestration only.
2. **More retains a large compile-time-disabled legacy tree.** `LEAN_MORE_SURFACE
   = true` hides the older branch, but the branch still parses, type-checks, and
   has to be maintained. Delete it after extracting any still-reachable routes;
   a permanent boolean is dead code, not progressive disclosure.
3. **More owns too many implementations.** Quality gates, Git, pairing, and
   provider connection logic live in the same route as navigation. Move each to
   a focused component/module; load it only when its destination/section opens.
4. **Settings mixes preference UI with operational workflows.** Appearance is
   appropriate there, but agent install/auth, subscription, speech, relay, and
   task behavior should remain grouped and progressively disclosed. Avoid any
   new top-level card unless it changes a frequent user decision.
5. **Wear OS is intentionally one screen, but every extra chip competes with
   Speak.** Appearance is therefore a secondary chip and must never displace the
   primary voice action or a required confirmation/recovery route.

## Recommended reduction order

1. Delete the unreachable legacy More branch and its now-unused handlers/imports.
2. Extract More's Pair Machine workflow and Quality Gates implementation.
3. Extract Settings sections behind typed preference hooks, beginning with
   appearance and startup behavior.
4. Split Tasks into live-console transport, task state, composer, and render
   action modules without changing its visible information hierarchy.

These are source-structure reductions. They should be landed separately from
the appearance preference so visual behavior and refactoring risk remain easy
to review.
