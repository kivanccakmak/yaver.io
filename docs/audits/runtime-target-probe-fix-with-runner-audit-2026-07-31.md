# Runtime Target Probe / Fix-With-Runner Audit - 2026-07-31

## Incident

The dashboard showed a usable-looking machine while Load Targets failed with relay credential errors or runner/render role errors. In those states, "Fix with OpenAI Codex" / "Fix with Claude Code" could appear to do nothing because the fix task depended on the same broken route.

## Root Causes

- Relay credential failures were not treated as auth failures by the shared dashboard auth classifier.
- Runtime target probe classification only knew relay presence, relay route, version skew, and generic operation failures. Invalid/stale/missing relay password fell into the generic bucket and could show a runner-fix route.
- Machine-role saves surfaced the backend ownership assertion directly. The raw message named `runnerDeviceId` but did not tell the user that the selected runner/render pair must come from their own refreshed device list.

## Product Hardening

- Relay auth failures now route to reconnect/retry, never to "Fix with runner".
- Runtime probe failure policy has an explicit `auth` class for relay credential denials.
- Machine-role save failures now render actionable copy for auth and owned-device guard failures.

## Validation

- `web/lib/agentAuthError.test.ts` covers relay credential strings and stable relay codes.
- `web/lib/runtimeTargetProbeFailure.test.ts` proves invalid/stale relay password cannot show "Fix with runner".
- `web/lib/useMachineRoles.test.ts` proves the Convex ownership guard becomes a visible route-to-fix.

## Follow-Up

- Verify deployed `yaver.io` with a fresh browser session after web deploy.
- Re-auth the local CLI/browser session before using `/devices/list`; a stale local bearer token currently returns 401 and is not a valid machine-health proof.
