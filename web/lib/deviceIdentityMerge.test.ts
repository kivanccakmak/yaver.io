/**
 * The web mirror of backend/convex/deviceIdentityMerge.test.mts, over the
 * SHAPE the browser actually carries (`Device` from lib/use-devices.ts:
 * `id`, `online`, ISO `lastSeen`) — because the client collapses the same rows
 * a second time and the old client rule was even weaker than the server's: it
 * had no `needsAuth` clause at all.
 *
 * Also pins the RECLAIM gate: a device whose row points at an agent with no
 * viable transport must not be handed a button that can only 502.
 *
 * Run: npx tsx --test web/lib/deviceIdentityMerge.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pickIdentityOwner,
  resolveIdentityMerge,
  type IdentityCandidate,
  type SecondaryAgentRef,
} from "./deviceIdentityMerge";
import { agentInstanceRelation } from "./aliasShadowing";
import { deriveBrowserReach, deriveDeviceLifecycleState } from "./device-lifecycle";

const NOW = 1_800_000_000_000;
const HWID = "hw-ubuntu-4gb-hel1-1";

/** The browser's row shape, trimmed to what the merge and the gate read. */
type WebRow = {
  id: string;
  name: string;
  alias?: string;
  port: number;
  online: boolean;
  needsAuth: boolean;
  lastSeen: string;
  agentVersion?: string;
  publicKey?: string;
  hardwareId?: string;
  lastTunnelEvent?: { online: boolean; at: number };
  secondaryAgents?: SecondaryAgentRef[];
};

// The projection use-devices.ts uses, kept identical so this test exercises the
// real seam rather than a convenient one.
const toCandidate = (d: WebRow): IdentityCandidate => ({
  deviceId: d.id,
  needsAuth: !!d.needsAuth,
  isOnline: !!d.online,
  lastHeartbeat: Date.parse(d.lastSeen || "") || 0,
  port: d.port,
  agentVersion: d.agentVersion,
  alias: d.alias,
  publicKey: d.publicKey,
  hardwareId: d.hardwareId,
  lastTunnelEvent: d.lastTunnelEvent,
});

const OPTS = {
  relate: agentInstanceRelation,
  readSecondaries: (d: WebRow) => d.secondaryAgents,
  now: NOW,
};

function healthy(over: Partial<WebRow> = {}): WebRow {
  return {
    id: "5e79cf10-90e8-4a4f-bf07-041061dca210",
    name: "ubuntu-4gb-hel1-1",
    alias: "linux",
    port: 18080,
    online: true,
    needsAuth: false,
    lastSeen: new Date(NOW - 60_000).toISOString(),
    agentVersion: "1.99.389",
    publicKey: "pk-agent",
    hardwareId: HWID,
    lastTunnelEvent: { online: true, at: NOW - 30_000 },
    ...over,
  };
}

function simCell(over: Partial<WebRow> = {}): WebRow {
  return {
    id: "2ed7da41-bd6c-4dad-8a13-116756a7ed02",
    name: "ubuntu-4gb-hel1-1",
    alias: "linux-3",
    port: 18090,
    online: true,
    needsAuth: true,
    // ONE SECOND newer than the healthy row — the old rule's only input.
    lastSeen: new Date(NOW - 1_000).toISOString(),
    agentVersion: "1.99.259",
    publicKey: "pk-simcell",
    hardwareId: HWID,
    ...over,
  };
}

test("web: the needs-auth loopback agent never takes the row's identity", () => {
  const merged = resolveIdentityMerge(healthy(), simCell(), toCandidate, OPTS);
  assert.equal(merged.base.id, "5e79cf10-90e8-4a4f-bf07-041061dca210");
  assert.equal(merged.base.needsAuth, false);
  assert.equal(merged.base.port, 18080);
  assert.equal(merged.base.agentVersion, "1.99.389");
});

test("web: the winner does not depend on which row arrived first", () => {
  const ab = resolveIdentityMerge(healthy(), simCell(), toCandidate, OPTS);
  const ba = resolveIdentityMerge(simCell(), healthy(), toCandidate, OPTS);
  assert.equal(ab.base.id, ba.base.id);
  assert.equal(ab.base.needsAuth, ba.base.needsAuth);
});

test("web: equal heartbeats still resolve deterministically", () => {
  const sameTs = new Date(NOW - 5_000).toISOString();
  const a = healthy({ id: "aaaa", lastSeen: sameTs });
  const b = healthy({ id: "bbbb", lastSeen: sameTs });
  assert.equal(pickIdentityOwner(toCandidate(a), toCandidate(b), NOW), "a");
  assert.equal(pickIdentityOwner(toCandidate(b), toCandidate(a), NOW), "b");
});

test("web: the second agent survives the merge as a named secondary", () => {
  const merged = resolveIdentityMerge(healthy(), simCell(), toCandidate, OPTS);
  assert.equal(merged.secondAgentOnSameBox, true);
  assert.equal(merged.secondaryAgents?.length, 1);
  assert.equal(merged.secondaryAgents?.[0].port, 18090);
  assert.equal(merged.secondaryAgents?.[0].agentVersion, "1.99.259");
});

// ---------------------------------------------------------------------------
// The RECLAIM gate. page.tsx used to render Reclaim/Re-auth off `lifecycle`
// alone, so a row that had been hijacked by a tunnel-less agent offered a
// button whose only possible outcome was a 502.
// ---------------------------------------------------------------------------

/** The exact predicate app/dashboard/page.tsx applies before rendering RECLAIM. */
function reclaimOffered(d: {
  online: boolean;
  needsAuth: boolean;
  lastSeen: string;
  probeState?: "ok" | "auth-expired" | "unreachable";
  probeError?: string;
  secondaryAgents?: SecondaryAgentRef[];
}): boolean {
  const lifecycle = deriveDeviceLifecycleState(d as never);
  const reach = deriveBrowserReach(d as never, null, NOW);
  const secondAgents = d.secondaryAgents || [];
  const noViableTransport = reach.unreachable || (secondAgents.length > 0 && reach.state === "offline");
  const recoveryWanted = lifecycle === "bootstrap" || lifecycle === "yaver-auth-expired";
  return recoveryWanted && !noViableTransport;
}

test("RECLAIM is withheld when the browser has PROVEN it cannot reach the row", () => {
  const hijacked = {
    online: true,
    needsAuth: true,
    lastSeen: new Date(NOW - 1_000).toISOString(),
    probeState: "unreachable" as const,
    probeError: "relay.device_not_connected",
    secondaryAgents: [{ deviceId: "2ed7da41", port: 18090, needsAuth: false, hasTransport: true }],
  };
  assert.equal(deriveDeviceLifecycleState(hijacked as never), "bootstrap");
  assert.equal(reclaimOffered(hijacked), false);
});

test("RECLAIM is still offered on a needs-auth box we have no bad news about", () => {
  // `claimed` (heartbeating, unprobed) must NOT be treated as unreachable —
  // refusing to try would be its own kind of lie. See device-lifecycle.ts.
  const plain = {
    online: true,
    needsAuth: true,
    lastSeen: new Date(NOW - 1_000).toISOString(),
  };
  assert.equal(reclaimOffered(plain), true);
});
