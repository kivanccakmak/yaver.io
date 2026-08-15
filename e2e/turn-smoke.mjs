import crypto from "node:crypto";
import { chromium } from "@playwright/test";

const host = process.env.YAVER_TURN_HOST || "public.yaver.io";
const secret = process.env.YAVER_TURN_SECRET;
if (!secret) throw new Error("YAVER_TURN_SECRET is required");

const username = `${Math.floor(Date.now() / 1000) + 3600}:turn-smoke`;
const credential = crypto.createHmac("sha1", secret.trim()).update(username).digest("base64");
const cases = [
  { name: "udp", url: `turn:${host}:3478?transport=udp` },
  { name: "tcp", url: `turn:${host}:3478?transport=tcp` },
  { name: "tls", url: `turns:${host}:5349?transport=tcp` },
];

const browser = await chromium.launch({
  headless: true,
  ...(process.env.YAVER_CHROME_PATH ? { executablePath: process.env.YAVER_CHROME_PATH } : {}),
});
try {
  const page = await browser.newPage();
  for (const testCase of cases) {
    const result = await page.evaluate(
      async ({ url, username, credential }) => {
        const pc = new RTCPeerConnection({
          iceTransportPolicy: "relay",
          iceServers: [{ urls: [url], username, credential }],
        });
        const candidates = [];
        try {
          pc.createDataChannel("turn-smoke");
          pc.onicecandidate = (event) => {
            if (event.candidate) {
              candidates.push({
                type: event.candidate.type,
                protocol: event.candidate.protocol,
                relayProtocol: event.candidate.relayProtocol || null,
              });
            }
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
          return candidates;
        } finally {
          pc.close();
        }
      },
      { url: testCase.url, username, credential },
    );
    const relayed = result.filter((candidate) => candidate.type === "relay");
    if (relayed.length === 0) {
      throw new Error(`${testCase.name}: no relay ICE candidate gathered`);
    }
    console.log(`${testCase.name}: ok ${JSON.stringify(relayed)}`);
  }

  const rejected = await page.evaluate(async ({ host, username }) => {
    const pc = new RTCPeerConnection({
      iceTransportPolicy: "relay",
      iceServers: [{ urls: [`turn:${host}:3478?transport=udp`], username, credential: "invalid" }],
    });
    const candidates = [];
    try {
      pc.createDataChannel("turn-negative");
      pc.onicecandidate = (event) => event.candidate && candidates.push(event.candidate.type);
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return candidates;
    } finally {
      pc.close();
    }
  }, { host, username });
  if (rejected.includes("relay")) throw new Error("invalid TURN credential was accepted");
  console.log("invalid-credential: rejected");
} finally {
  await browser.close();
}
