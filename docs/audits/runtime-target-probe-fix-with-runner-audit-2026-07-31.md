# Runtime Target Probe / Fix-With-Runner Audit - 2026-07-31

## Incident

The dashboard showed a usable-looking machine while Load Targets failed with relay credential errors or runner/render role errors. In those states, "Fix with OpenAI Codex" / "Fix with Claude Code" could appear to do nothing because the fix task depended on the same broken route.

## Root Causes

- Relay credential failures must be deterministic auth recovery. They are not product-code failures and must not route to a coding runner.
- A relay 502 means the browser cannot reach the agent through the relay tunnel. Direct HTTP from `https://yaver.io` is expected to be blocked by the browser, so the relay lane is the operation that matters.
- Machine-role saves surfaced the backend ownership assertion directly. The raw message named `runnerDeviceId` but did not tell the user that the selected runner/render pair must come from their own refreshed device list.

## Product Hardening

- Relay auth failures are part of the shared dashboard auth classifier.
- Runtime target probe policy on current `main` already classifies relay credential failures before generic "Fix with runner" routing.
- Machine-role save failures now render actionable copy for auth and owned-device guard failures.

## Validation

- `web/lib/agentAuthError.test.ts` covers relay credential strings and stable relay codes.
- `web/lib/runtimeTargetProbeFailure.test.ts` proves relay auth does not show "Fix with runner".
- `web/lib/useMachineRoles.test.ts` proves the Convex ownership guard becomes a visible route-to-fix.
