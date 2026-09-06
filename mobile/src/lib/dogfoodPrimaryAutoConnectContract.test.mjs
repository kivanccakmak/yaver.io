import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../components/AttachModeSection.tsx", import.meta.url), "utf8");

test("Dogfood reconnects its configured primary without overriding explicit local choices", () => {
  assert.match(source, /primaryDeviceId/,
    "Dogfood must consume the configured primary instead of depending only on an already-focused device");
  assert.match(source, /selectDevice\(primaryDevice, true\)/,
    "Dogfood must request one automatic primary connection when its route opens disconnected");
  assert.match(source, /userDisconnected/,
    "Dogfood auto-connect must respect an explicit user disconnect");
  assert.match(source, /codingMode !== "remote-preferred"/,
    "Dogfood auto-connect must not override No remote box mode");
  assert.match(source, /primaryAutoConnectAttemptRef\.current === primaryDevice\.id/,
    "a failed primary must not produce a reconnect loop on every render");
});
