import assert from "node:assert/strict";
import { describeDeviceCardPing } from "./deviceCardLiveness";

const down = describeDeviceCardPing({ reachable: false, elapsedMs: 3012, errorCode: "no-transport" });
assert.equal(down.ok, false);
assert.match(down.headline, /^Not live · no response after 3\.0s$/);
assert.match(down.guidance, /powered on/);
assert.match(down.guidance, /Yaver is running/);

const live = describeDeviceCardPing({ reachable: true, path: "relay", elapsedMs: 87 });
assert.deepEqual(live, {
  ok: true,
  headline: "Live · relay · 87ms",
  guidance: "The agent answered. Connecting to Yaver…",
});

const missingRelayAuth = describeDeviceCardPing({
  reachable: false,
  elapsedMs: 1200,
  errorCode: "relay-credentials-missing",
});
assert.match(missingRelayAuth.guidance, /Sign in again/);

console.log("deviceCardLiveness: ok");
