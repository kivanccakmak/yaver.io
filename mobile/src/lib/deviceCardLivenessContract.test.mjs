import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../../app/(tabs)/devices.tsx", import.meta.url), "utf8");

assert.match(source, /label="NOT LIVE"/, "offline machines must have a prominent NOT LIVE state");
assert.match(source, /last seen \$\{timeSince/, "offline machines must show when the agent was last seen");
assert.match(source, /if \(!probe\.reachable\) return;[\s\S]*await onSelect\(\);/, "a successful ping must continue into the Yaver connection flow");
assert.match(source, /pingState\.pinging[\s\S]*Pinging…/, "the user must see the bounded ping in progress");
assert.match(source, /Live agent · Yaver connection failed/, "agent reachability and Yaver-session failure must remain distinct");

console.log("deviceCardLivenessContract: ok");
