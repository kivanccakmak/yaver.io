#!/usr/bin/env node
/**
 * Generate Apple OAuth client secret (a signed JWT).
 *
 * Usage:
 *   node scripts/generate-apple-secret.mjs
 *
 * Requires:
 *   - Apple private key (.p8) at the path below
 *   - Team ID, Key ID, and Services ID (client ID)
 *
 * The generated secret is valid for 6 months (Apple's max).
 */

import { readFileSync } from "fs";
import { createPrivateKey, createSign } from "crypto";

// --- Configuration ---
const TEAM_ID = "5SJZ4KA39A";
const KEY_ID = "77Z6B543D5";
const CLIENT_ID = "io.yaver.web"; // Your Services ID — update if different
const KEY_PATH =
  process.env.APPLE_KEY_PATH ||
  `${process.env.HOME}/Workspace/talos/mobile/ios/AuthKey_${KEY_ID}.p8`;

// --- Generate JWT ---
const now = Math.floor(Date.now() / 1000);
const exp = now + 86400 * 180; // 6 months

const header = {
  alg: "ES256",
  kid: KEY_ID,
};

const payload = {
  iss: TEAM_ID,
  iat: now,
  exp,
  aud: "https://appleid.apple.com",
  sub: CLIENT_ID,
};

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64url");
}

const unsignedToken = `${base64url(header)}.${base64url(payload)}`;

const keyPem = readFileSync(KEY_PATH, "utf8");
const privateKey = createPrivateKey({ key: keyPem, format: "pem" });

const sign = createSign("SHA256");
sign.update(unsignedToken);
const signature = sign.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }, "base64url");

const clientSecret = `${unsignedToken}.${signature}`;

console.log("Apple OAuth Client Secret (valid for 6 months):\n");
console.log(clientSecret);
console.log("\nSet in Vercel:");
console.log(`  OAUTH_APPLE_CLIENT_ID = ${CLIENT_ID}`);
console.log(`  OAUTH_APPLE_CLIENT_SECRET = <the JWT above>`);
