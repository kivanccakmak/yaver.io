import { createRequire } from "node:module";

const requireFrom = process.env.YAVER_E2E_PACKAGE_ROOT || import.meta.url;
const require = createRequire(requireFrom);
const { chromium } = require("@playwright/test");

const brokerURL = process.env.YAVER_TURN_BROKER_URL;
const relayPassword = process.env.YAVER_RELAY_PASSWORD;
if (!brokerURL) throw new Error("YAVER_TURN_BROKER_URL is required");
if (!relayPassword) throw new Error("YAVER_RELAY_PASSWORD is required");

const response = await fetch(brokerURL, {
  headers: { "X-Relay-Password": relayPassword, Accept: "application/json" },
  cache: "no-store",
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`TURN broker returned HTTP ${response.status}`);
if (!String(response.headers.get("cache-control") || "").includes("no-store")) {
  throw new Error("TURN broker response is cacheable");
}
const body = await response.json();
const turn = body.iceServers?.find((server) =>
  server.urls?.some((url) => String(url).startsWith("turn:")),
);
if (!turn?.username || !turn?.credential) throw new Error("TURN broker returned no ephemeral credential");

const expected = [
  ["udp", "turn:", "transport=udp"],
  ["tcp", "turn:", "transport=tcp"],
  ["tls", "turns:", "transport=tcp"],
];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.YAVER_CHROME_PATH ? { executablePath: process.env.YAVER_CHROME_PATH } : {}),
});
try {
  const page = await browser.newPage();
  for (const [name, scheme, transport] of expected) {
    const url = turn.urls.find((candidate) =>
      String(candidate).startsWith(scheme) && String(candidate).includes(transport),
    );
    if (!url) throw new Error(`${name}: broker omitted ${scheme} ${transport}`);
    const candidates = await page.evaluate(async ({ url, username, credential }) => {
      const pc = new RTCPeerConnection({
        iceTransportPolicy: "relay",
        iceServers: [{ urls: [url], username, credential }],
      });
      const found = [];
      try {
        pc.createDataChannel("turn-broker-smoke");
        pc.onicecandidate = (event) => {
          if (event.candidate) found.push({ type: event.candidate.type, protocol: event.candidate.protocol });
        };
        await pc.setLocalDescription(await pc.createOffer());
        await Promise.race([
          new Promise((resolve) => {
            if (pc.iceGatheringState === "complete") return resolve();
            pc.addEventListener("icegatheringstatechange", () => {
              if (pc.iceGatheringState === "complete") resolve();
            });
          }),
          new Promise((resolve) => setTimeout(resolve, 15_000)),
        ]);
        return found;
      } finally {
        pc.close();
      }
    }, { url, username: turn.username, credential: turn.credential });
    if (!candidates.some((candidate) => candidate.type === "relay")) {
      throw new Error(`${name}: no relay ICE candidate gathered`);
    }
    console.log(`${name}: relay candidate ok`);
  }
} finally {
  await browser.close();
}

const rejected = await fetch(brokerURL, {
  headers: { "X-Relay-Password": `${relayPassword}-invalid`, Accept: "application/json" },
  signal: AbortSignal.timeout(10_000),
});
if (rejected.status !== 401) throw new Error(`invalid relay credential returned HTTP ${rejected.status}, want 401`);
console.log("invalid relay credential: rejected");
