import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(process.cwd(), "web");

test("DevicesView collapses duplicate host rows to the operational row", () => {
  const src = readFileSync(join(root, "components/dashboard/DevicesView.tsx"), "utf8");
  const duplicateBlock = src.slice(
    src.indexOf("function duplicateHostKey"),
    src.indexOf("function formatRunnerChipLabel"),
  );

  assert.match(
    duplicateBlock,
    /function duplicateHostKey\(device: Pick<Device, "isGuest" \| "platform" \| "name">/,
    "duplicate detection must key on hostname/platform, not agent version",
  );
  assert.match(
    src,
    /function operationRank\(device: Pick<Device, "online" \| "needsAuth" \| "workspaceLive" \| "peerState" \| "probeState" \| "lastTunnelEvent">\)/,
    "duplicate resolution must rank rows by the operation that actually works",
  );
  assert.match(
    src,
    /operationRank\(a\) - operationRank\(b\)/,
    "a stale primary row must not hide a reachable replacement for the same host",
  );
  assert.doesNotMatch(
    duplicateBlock,
    /agentVersion/,
    "duplicate resolution must not prefer a row by agent version",
  );
});

test("dashboard sidebar uses the same operational duplicate ranking", () => {
  const src = readFileSync(join(root, "app/dashboard/page.tsx"), "utf8");

  assert.match(
    src,
    /function operationRank\(device: Pick<Device, "online" \| "needsAuth" \| "workspaceLive" \| "peerState" \| "probeState" \| "lastTunnelEvent">\)/,
    "sidebar duplicate resolution must share the operation-first ranking",
  );
  assert.match(
    src,
    /operationRank\(a\) - operationRank\(b\)/,
    "sidebar must keep the reachable duplicate instead of a stale role row",
  );
});
